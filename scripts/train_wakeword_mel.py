#!/usr/bin/env python3
"""
训练唤醒词模型 - 基于 Mel 频谱直接训练

模型输入: (batch, n_frames, 32) - Mel 频谱序列
模型输出: (batch, 1) - 唤醒词置信度

优势: 直接在 Mel 特征上学习，不依赖 OWW embedding，对中文语音区分度更好
"""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
from scipy.io import wavfile


def extract_mel_spectrogram(audio, mel_session, mel_input_name, target_frames=64):
    """从音频提取 Mel 频谱序列

    Args:
        audio: 音频数据 (float32, 16kHz)
        mel_session: ONNX Mel 模型
        mel_input_name: Mel 模型输入名称
        target_frames: 目标帧数 (约 1.28 秒音频)

    Returns:
        mel_frames: (n_frames, 32) Mel 频谱帧
    """
    chunk_size = 1280  # 80ms
    mel_buffer = []

    # 确保足够长度
    min_len = 16000 * 3  # 至少 3 秒
    if len(audio) < min_len:
        audio = np.pad(audio, (0, min_len - len(audio)))

    for i in range(0, len(audio) - chunk_size + 1, chunk_size):
        chunk = audio[i:i + chunk_size].astype(np.float32)

        try:
            mel_out = mel_session.run(None, {mel_input_name: chunk.reshape(1, -1)})
            frames = mel_out[0]

            if frames is not None and len(frames) > 0:
                if len(frames.shape) == 4:
                    # (1, 1, n_frames, 32)
                    for f in range(frames.shape[2]):
                        frame = frames[0, 0, f, :]
                        mel_buffer.append(frame)
                elif len(frames.shape) == 3:
                    # (1, n_frames, 32)
                    for f in range(frames.shape[1]):
                        frame = frames[0, f, :]
                        mel_buffer.append(frame)
        except:
            continue

    if len(mel_buffer) < target_frames:
        return None

    return np.array(mel_buffer, dtype=np.float32)


def normalize_audio(audio, target_rms=0.1):
    """音量归一化"""
    rms = np.sqrt(np.mean(audio ** 2))
    if rms < 1e-8:
        return audio
    return audio * (target_rms / rms)


def main():
    parser = argparse.ArgumentParser(description="基于 Mel 频谱训练唤醒词模型")
    parser.add_argument("--samples", required=True, help="正向样本目录")
    parser.add_argument("--keyword", required=True, help="唤醒词")
    parser.add_argument("--output-dir", default="apps/host-runtime/backend/wakeword/oww", help="输出目录")
    parser.add_argument("--negative-samples", default="", help="负向样本目录")
    parser.add_argument("--steps", type=int, default=0, help="训练步数 (0=自动)")
    args = parser.parse_args()

    try:
        import torch
        import torch.nn as nn
        import onnx
        import onnxruntime as ort
    except ImportError as e:
        print(f"错误: {e}")
        sys.exit(1)

    output_dir = Path(args.output_dir)
    samples_dir = Path(args.samples)

    print(f"训练模型: {args.keyword}")
    print("方法: Mel 频谱直接训练")

    # 加载 Mel 模型
    print("\n加载 Mel 频谱模型...")
    mel_session = ort.InferenceSession(str(output_dir / "melspectrogram.onnx"))
    mel_input_name = mel_session.get_inputs()[0].name

    # 加载正向样本
    print("\n加载正向样本...")
    positive_mels = []
    for f in sorted(samples_dir.iterdir()):
        if f.suffix.lower() == '.wav':
            try:
                sr, data = wavfile.read(str(f))
                if data.dtype == np.int16:
                    data = data.astype(np.float32) / 32768.0
                elif data.dtype == np.int32:
                    data = data.astype(np.float32) / 2147483648.0
                data = normalize_audio(data)

                mel = extract_mel_spectrogram(data, mel_session, mel_input_name)
                if mel is not None:
                    positive_mels.append(mel)
            except Exception as e:
                print(f"  跳过 {f.name}: {e}")

    print(f"加载了 {len(positive_mels)} 个正向样本")

    if len(positive_mels) < 10:
        print("错误: 正向样本数量不足 (至少需要 10 个)")
        sys.exit(1)

    # 加载负向样本
    print("\n加载负向样本...")
    negative_mels = []
    if args.negative_samples and Path(args.negative_samples).exists():
        neg_dir = Path(args.negative_samples)
        for f in sorted(neg_dir.iterdir()):
            if f.suffix.lower() == '.wav':
                try:
                    sr, data = wavfile.read(str(f))
                    if data.dtype == np.int16:
                        data = data.astype(np.float32) / 32768.0
                    data = normalize_audio(data)

                    mel = extract_mel_spectrogram(data, mel_session, mel_input_name)
                    if mel is not None:
                        negative_mels.append(mel)
                except:
                    pass

    print(f"加载了 {len(negative_mels)} 个负向样本")

    # 构建训练序列
    print("\n构建训练数据...")
    SEQUENCE_LENGTH = 64  # 约 1.28 秒的 Mel 帧

    X_positive = []
    for mel in positive_mels:
        # 从每个样本中提取多个序列
        for i in range(0, len(mel) - SEQUENCE_LENGTH + 1, SEQUENCE_LENGTH // 2):
            seq = mel[i:i + SEQUENCE_LENGTH]
            if seq.shape == (SEQUENCE_LENGTH, 32):
                X_positive.append(seq)

    X_negative = []
    for mel in negative_mels:
        for i in range(0, len(mel) - SEQUENCE_LENGTH + 1, SEQUENCE_LENGTH):
            seq = mel[i:i + SEQUENCE_LENGTH]
            if seq.shape == (SEQUENCE_LENGTH, 32):
                X_negative.append(seq)

    # 如果负向样本不足，使用随机采样
    if len(X_negative) < len(X_positive):
        print(f"  负向序列不足，从现有样本中采样...")
        while len(X_negative) < len(X_positive):
            idx = np.random.randint(len(negative_mels))
            mel = negative_mels[idx]
            start = np.random.randint(0, max(1, len(mel) - SEQUENCE_LENGTH))
            seq = mel[start:start + SEQUENCE_LENGTH]
            if seq.shape == (SEQUENCE_LENGTH, 32):
                X_negative.append(seq)

    X_positive = np.array(X_positive, dtype=np.float32)
    X_negative = np.array(X_negative[:len(X_positive)], dtype=np.float32)

    print(f"正向序列: {X_positive.shape}")
    print(f"负向序列: {X_negative.shape}")

    # 合并数据
    X = np.concatenate([X_positive, X_negative], axis=0)
    y = np.concatenate([np.ones(len(X_positive)), np.zeros(len(X_negative))])

    # 打乱
    idx = np.random.permutation(len(X))
    X, y = X[idx], y[idx]

    print(f"\n总训练数据: {X.shape}")

    # 划分训练集和验证集
    split_idx = int(len(X) * 0.8)
    X_train, X_val = X[:split_idx], X[split_idx:]
    y_train, y_val = y[:split_idx], y[split_idx:]
    print(f"训练集: {X_train.shape}, 验证集: {X_val.shape}")

    # 定义模型 - 1D CNN
    class MelWakeWordModel(nn.Module):
        """基于 Mel 频谱的唤醒词检测模型"""

        def __init__(self):
            super().__init__()

            # 1D 卷积层处理 Mel 序列
            self.conv1 = nn.Conv1d(32, 64, kernel_size=3, padding=1)
            self.conv2 = nn.Conv1d(64, 128, kernel_size=3, padding=1)
            self.conv3 = nn.Conv1d(128, 256, kernel_size=3, padding=1)

            self.bn1 = nn.BatchNorm1d(64)
            self.bn2 = nn.BatchNorm1d(128)
            self.bn3 = nn.BatchNorm1d(256)

            self.pool = nn.MaxPool1d(2)
            self.dropout = nn.Dropout(0.3)

            # 全连接层
            self.fc1 = nn.Linear(256 * 8, 128)  # 64 -> 32 -> 16 -> 8 after pooling
            self.fc2 = nn.Linear(128, 32)
            self.fc3 = nn.Linear(32, 1)

            self.relu = nn.ReLU()
            self.sigmoid = nn.Sigmoid()

        def forward(self, x):
            # x: (batch, seq_len, 32) -> (batch, 32, seq_len)
            x = x.permute(0, 2, 1)

            # Conv blocks
            x = self.pool(self.relu(self.bn1(self.conv1(x))))
            x = self.dropout(x)
            x = self.pool(self.relu(self.bn2(self.conv2(x))))
            x = self.dropout(x)
            x = self.pool(self.relu(self.bn3(self.conv3(x))))

            # Flatten
            x = x.view(x.size(0), -1)

            # FC layers
            x = self.dropout(self.relu(self.fc1(x)))
            x = self.dropout(self.relu(self.fc2(x)))
            x = self.fc3(x)

            return self.sigmoid(x)

    model = MelWakeWordModel()

    # 定义安全文件名
    safe_name = args.keyword.replace(" ", "_")

    # 计算训练步数
    n_samples = len(positive_mels)
    if args.steps == 0:
        steps = max(5000, min(15000, 100 * n_samples))
        print(f"\n自动计算步数: {steps}")
    else:
        steps = args.steps

    print(f"\n训练 {steps} 步...")
    sys.stdout.flush()

    optimizer = torch.optim.Adam(model.parameters(), lr=0.001, weight_decay=1e-4)
    criterion = nn.BCELoss()

    X_train_t = torch.from_numpy(X_train).float()
    y_train_t = torch.from_numpy(y_train).float().unsqueeze(1)
    X_val_t = torch.from_numpy(X_val).float()
    y_val_t = torch.from_numpy(y_val).float().unsqueeze(1)

    batch_size = min(64, len(X_train))
    best_val_loss = float('inf')
    patience = 0
    max_patience = 10

    for step in range(steps):
        model.train()
        idx_batch = np.random.choice(len(X_train), batch_size, replace=False)
        output = model(X_train_t[idx_batch])
        loss = criterion(output, y_train_t[idx_batch])

        optimizer.zero_grad()
        loss.backward()
        optimizer.step()

        # 每 500 步验证
        if step % 500 == 0:
            model.eval()
            with torch.no_grad():
                train_pred = (model(X_train_t) > 0.5).float()
                train_acc = (train_pred == y_train_t).float().mean().item()

                val_pred = model(X_val_t)
                val_pred_binary = (val_pred > 0.5).float()
                val_acc = (val_pred_binary == y_val_t).float().mean().item()
                val_loss = criterion(val_pred, y_val_t).item()

                # 分别计算正负样本准确率
                pos_mask = y_val_t.flatten() == 1
                neg_mask = y_val_t.flatten() == 0
                pos_acc = (val_pred_binary[pos_mask] == 1).float().mean().item() if pos_mask.sum() > 0 else 0
                neg_acc = (val_pred_binary[neg_mask] == 0).float().mean().item() if neg_mask.sum() > 0 else 0

            print(f"Step {step}: Loss={loss.item():.4f}, Train={train_acc:.1%}, Val={val_acc:.1%} (Pos={pos_acc:.1%}, Neg={neg_acc:.1%})")
            sys.stdout.flush()

            # 早停
            if val_loss < best_val_loss:
                best_val_loss = val_loss
                patience = 0
                torch.save(model.state_dict(), output_dir / f"{safe_name}_best.pt")
            else:
                patience += 1
                if patience >= max_patience:
                    print(f"Early stopping at step {step}")
                    break

            model.train()

    # 加载最佳模型
    if (output_dir / f"{safe_name}_best.pt").exists():
        model.load_state_dict(torch.load(output_dir / f"{safe_name}_best.pt"))
        print("Loaded best model")

    model.eval()

    # 保存权重
    weights_path = output_dir / f"{safe_name}_weights.pt"
    torch.save(model.state_dict(), weights_path)
    print(f"权重已保存: {weights_path}")

    # 导出 ONNX
    print("\n导出 ONNX...")
    onnx_path = output_dir / f"{safe_name}.onnx"

    dummy_input = torch.randn(1, SEQUENCE_LENGTH, 32)

    torch.onnx.export(
        model,
        dummy_input,
        str(onnx_path),
        opset_version=13,
        input_names=['input'],
        output_names=['output'],
        dynamic_axes={'input': {0: 'batch'}, 'output': {0: 'batch'}},
    )

    # 验证 ONNX
    onnx_model = onnx.load(str(onnx_path))
    onnx.checker.check_model(onnx_model)

    inp = onnx_model.graph.input[0]
    dims = [d.dim_value if d.dim_value else d.dim_param for d in inp.type.tensor_type.shape.dim]
    print(f"ONNX 输入形状: {dims}")
    print(f"模型已导出: {onnx_path}")

    # 保存元数据
    meta = {
        "keyword": args.keyword,
        "version": 2,
        "method": "mel_direct",
        "sequence_length": SEQUENCE_LENGTH,
        "created_at": datetime.now().isoformat()
    }
    with open(onnx_path.with_suffix(".json"), "w") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)

    print(f"\n完成!")


if __name__ == "__main__":
    main()