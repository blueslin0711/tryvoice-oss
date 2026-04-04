#!/usr/bin/env python3
"""
训练唤醒词模型 - 正确的 OWW 流程

关键词模型输入: (batch, 16, 96) - 16帧 embedding, 每帧 96 维
"""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
from scipy.io import wavfile


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", required=True)
    parser.add_argument("--keyword", required=True)
    parser.add_argument("--output-dir", default="apps/host-runtime/backend/wakeword/oww")
    parser.add_argument("--negative-samples", default="", help="负向样本目录")
    parser.add_argument("--steps", type=int, default=0, help="训练步数 (0=自动计算)")
    parser.add_argument("--auto-steps", action="store_true", help="根据样本数量自动计算步数")
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

    # 加载 OWW 基础模型
    print("\n加载 OWW mel + embedding 模型...")
    mel_session = ort.InferenceSession(str(output_dir / "melspectrogram.onnx"))
    emb_session = ort.InferenceSession(str(output_dir / "embedding_model.onnx"))

    # 获取 mel 模型的输出信息
    mel_input_name = mel_session.get_inputs()[0].name
    emb_input_name = emb_session.get_inputs()[0].name
    print(f"Mel 输入: {mel_input_name}")
    print(f"Emb 输入: {emb_input_name}")

    def extract_embeddings(clip):
        """从音频片段提取 embedding 序列"""
        # 确保是 float32
        clip = clip.astype(np.float32)

        # 填充到足够长度 - 需要至少 76 帧 mel 才能生成一个 embedding
        # 每 80ms 音频生成约 5 帧 mel，所以需要 76/5 * 80ms ≈ 1.2s
        # 为了生成足够的 embedding (至少 16 个)，需要更多音频
        # 设置为 5 秒以确保有足够的 embedding 序列
        min_len = 16000 * 5  # 5 秒
        if len(clip) < min_len:
            clip = np.pad(clip, (0, min_len - len(clip)))

        embeddings = []
        chunk_size = 1280
        mel_buffer = []

        for i in range(0, len(clip) - chunk_size + 1, chunk_size):
            chunk = clip[i:i + chunk_size]

            try:
                # Mel spectrogram
                mel_out = mel_session.run(None, {mel_input_name: chunk.reshape(1, -1)})
                mel_frames = mel_out[0]  # shape varies

                # 处理 mel 输出
                if mel_frames is not None and len(mel_frames) > 0:
                    if len(mel_frames.shape) == 4:
                        # (1, 1, n_frames, 32)
                        n_frames = mel_frames.shape[2]
                        feature_size = mel_frames.shape[3]
                        for f in range(n_frames):
                            frame = mel_frames[0, 0, f, :]
                            # 归一化
                            frame = (frame / 10.0) + 2.0
                            mel_buffer.append(frame)
                    elif len(mel_frames.shape) == 3:
                        # (1, n_frames, 32)
                        n_frames = mel_frames.shape[1]
                        feature_size = mel_frames.shape[2]
                        for f in range(n_frames):
                            frame = mel_frames[0, f, :]
                            frame = (frame / 10.0) + 2.0
                            mel_buffer.append(frame)

                # 当 mel buffer 足够时，生成 embedding
                while len(mel_buffer) >= 76:
                    # 取 76 帧
                    mel_for_emb = np.array(mel_buffer[:76])  # (76, 32)

                    # embedding 模型期望 (1, 76, 32, 1)
                    emb_input = mel_for_emb.reshape(1, 76, 32, 1).astype(np.float32)
                    emb_out = emb_session.run(None, {emb_input_name: emb_input})

                    # embedding 输出 (1, 1, 1, 96) 或类似
                    emb = emb_out[0].flatten()[:96]  # 取前 96 维
                    embeddings.append(emb)

                    # 移动窗口
                    mel_buffer = mel_buffer[8:]

            except Exception as e:
                continue

        return embeddings

    def normalize_audio(audio: np.ndarray, target_rms: float = 0.1) -> np.ndarray:
        """Normalize audio to target RMS level.

        This ensures consistent volume across all samples,
        which is critical for model training.
        """
        # Calculate current RMS
        rms = np.sqrt(np.mean(audio ** 2))
        if rms < 1e-8:
            # Silent audio, return as-is
            return audio
        # Scale to target RMS
        scale = target_rms / rms
        return audio * scale

    # 加载音频
    print("\n加载正向样本...")
    positive_clips = []
    for f in sorted(samples_dir.iterdir()):
        if f.suffix.lower() == '.wav':
            try:
                sr, data = wavfile.read(str(f))
                if data.dtype == np.int16:
                    data = data.astype(np.float32) / 32768.0
                elif data.dtype == np.int32:
                    data = data.astype(np.float32) / 2147483648.0
                # 音量归一化
                data = normalize_audio(data)
                positive_clips.append(data)
            except Exception as e:
                pass

    print(f"加载了 {len(positive_clips)} 个音频文件")

    # 提取 embedding 序列
    print("\n提取 embedding 特征...")
    all_embeddings = []

    for i, clip in enumerate(positive_clips):
        embs = extract_embeddings(clip)
        all_embeddings.extend(embs)
        if (i + 1) % 100 == 0:
            print(f"  已处理 {i + 1}/{len(positive_clips)} 个文件, 累计 {len(all_embeddings)} 个 embedding")

    print(f"提取了 {len(all_embeddings)} 个 embedding")

    if len(all_embeddings) < 16:
        print("错误: embedding 数量不足")
        sys.exit(1)

    # 构建训练样本: 每 16 个 embedding 作为一个样本
    print("\n构建训练样本 (16帧序列)...")
    X_positive = []

    for i in range(len(all_embeddings) - 16 + 1):
        seq = np.array(all_embeddings[i:i + 16])  # (16, 96)
        if seq.shape == (16, 96):
            X_positive.append(seq)

    X_positive = np.array(X_positive, dtype=np.float32)  # (N, 16, 96)
    print(f"正向样本: {X_positive.shape}")

    # 加载负向样本（真实的不匹配语音）
    print("加载负向样本...")
    X_negative = []

    if args.negative_samples and Path(args.negative_samples).exists():
        neg_dir = Path(args.negative_samples)
        neg_clips = []
        for f in sorted(neg_dir.iterdir()):
            if f.suffix.lower() == '.wav':
                try:
                    sr, data = wavfile.read(str(f))
                    if data.dtype == np.int16:
                        data = data.astype(np.float32) / 32768.0
                    # 音量归一化
                    data = normalize_audio(data)
                    neg_clips.append(data)
                except:
                    pass

        print(f"加载了 {len(neg_clips)} 个负向音频文件")

        # 提取负向 embedding
        for clip in neg_clips:
            embs = extract_embeddings(clip)
            for i in range(len(embs) - 16 + 1):
                seq = np.array(embs[i:i + 16])
                if seq.shape == (16, 96):
                    X_negative.append(seq)

        print(f"从负向样本提取了 {len(X_negative)} 个序列")

    # 如果负向样本不足，用随机噪声补充
    if len(X_negative) < len(X_positive):
        print(f"负向样本不足，用随机噪声补充 {len(X_positive) - len(X_negative)} 个")
        all_embs_array = np.array(all_embeddings)
        for _ in range(len(X_positive) - len(X_negative)):
            indices = np.random.choice(len(all_embs_array), 16, replace=True)
            seq = all_embs_array[indices] + np.random.randn(16, 96).astype(np.float32) * 0.3
            X_negative.append(seq)

    X_negative = np.array(X_negative[:len(X_positive)], dtype=np.float32)
    print(f"负向样本: {X_negative.shape}")

    # 合并
    X = np.concatenate([X_positive, X_negative], axis=0)
    y = np.concatenate([np.ones(len(X_positive)), np.zeros(len(X_negative))])

    # 打乱
    idx = np.random.permutation(len(X))
    X, y = X[idx], y[idx]

    print(f"\n训练数据: {X.shape}")

    # 划分训练集和验证集 (80/20)
    split_idx = int(len(X) * 0.8)
    X_train, X_val = X[:split_idx], X[split_idx:]
    y_train, y_val = y[:split_idx], y[split_idx:]
    print(f"训练集: {X_train.shape}, 验证集: {X_val.shape}")

    # 创建模型 - 输入 (batch, 16, 96)
    class WakeWordModel(nn.Module):
        def __init__(self):
            super().__init__()
            # 展平后 16*96 = 1536
            self.flatten = nn.Flatten()
            self.fc1 = nn.Linear(16 * 96, 128)
            self.fc2 = nn.Linear(128, 32)
            self.fc3 = nn.Linear(32, 1)
            self.relu = nn.ReLU()
            self.dropout = nn.Dropout(0.5)
            self.sigmoid = nn.Sigmoid()

        def forward(self, x):
            x = self.flatten(x)
            x = self.dropout(self.relu(self.fc1(x)))
            x = self.dropout(self.relu(self.fc2(x)))
            x = self.fc3(x)
            return self.sigmoid(x)

    model = WakeWordModel()

    # 定义安全文件名（提前定义，训练中会用到）
    safe_name = args.keyword.replace(" ", "_")

    # 计算训练步数
    n_positive_files = len(positive_clips)
    if args.steps == 0 or args.auto_steps:
        # 动态计算：样本越多，步数越少
        # 基准：50 个样本需要 20000 步
        # 公式：steps = max(5000, 20000 * 50 / n_positive_files)
        auto_steps = max(5000, int(20000 * 50 / n_positive_files))
        print(f"\n自动计算步数: {auto_steps} (基于 {n_positive_files} 个正向样本)")
        steps = auto_steps
    else:
        steps = args.steps

    print(f"\n训练 {steps} 步...")
    sys.stdout.flush()
    optimizer = torch.optim.Adam(model.parameters(), lr=0.0005, weight_decay=1e-4)
    criterion = nn.BCELoss()

    X_train_t = torch.from_numpy(X_train).float()
    y_train_t = torch.from_numpy(y_train).float().unsqueeze(1)
    X_val_t = torch.from_numpy(X_val).float()
    y_val_t = torch.from_numpy(y_val).float().unsqueeze(1)

    batch_size = min(32, len(X_train))
    best_val_acc = 0
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

        # 每 500 步验证一次
        if step % 500 == 0:
            model.eval()
            with torch.no_grad():
                # 训练集准确率
                train_pred = (model(X_train_t) > 0.5).float()
                train_acc = (train_pred == y_train_t).float().mean().item()

                # 验证集准确率
                val_pred = model(X_val_t)
                val_pred_binary = (val_pred > 0.5).float()
                val_acc = (val_pred_binary == y_val_t).float().mean().item()

                # 分别计算正负样本
                pos_mask = y_val_t.flatten() == 1
                neg_mask = y_val_t.flatten() == 0
                pos_acc = (val_pred_binary[pos_mask] == 1).float().mean().item() if pos_mask.sum() > 0 else 0
                neg_acc = (val_pred_binary[neg_mask] == 0).float().mean().item() if neg_mask.sum() > 0 else 0

            print(f"Step {step}: Loss={loss.item():.4f}, Train={train_acc:.1%}, Val={val_acc:.1%} (Pos={pos_acc:.1%}, Neg={neg_acc:.1%})")
            sys.stdout.flush()

            # 早停检查
            if val_acc > best_val_acc:
                best_val_acc = val_acc
                patience = 0
                # 保存最佳模型
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
    model.eval()
    onnx_path = output_dir / f"{safe_name}.onnx"

    # 输入形状 (batch, 16, 96)
    dummy_input = torch.randn(1, 16, 96)

    try:
        torch.onnx.export(
            model,
            dummy_input,
            str(onnx_path),
            opset_version=13,
            input_names=['input'],
            output_names=['output'],
            dynamic_axes={'input': {0: 'batch'}, 'output': {0: 'batch'}},
        )
        print(f"模型已导出: {onnx_path}")
    except Exception as e:
        print(f"导出失败 (可能是 PyTorch 版本太新): {e}")
        print("请在 Docker 容器中运行导出:")
        print(f"  docker run --rm -v ... python -c \"import torch; ... \"")

    # 验证
    onnx_model = onnx.load(str(onnx_path))
    onnx.checker.check_model(onnx_model)

    # 检查输入形状
    inp = onnx_model.graph.input[0]
    dims = [d.dim_value if d.dim_value else d.dim_param for d in inp.type.tensor_type.shape.dim]
    print(f"ONNX 输入形状: {dims}")

    print(f"导出成功: {onnx_path}")

    # 元数据
    meta = {"keyword": args.keyword, "version": 1, "created_at": datetime.now().isoformat()}
    with open(onnx_path.with_suffix(".json"), "w") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)

    print(f"\n完成! 重启服务器后测试。")


if __name__ == "__main__":
    main()