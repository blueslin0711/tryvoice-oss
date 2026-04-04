#!/usr/bin/env python3
"""
Whisper 迁移学习唤醒词训练脚本

使用 Whisper encoder 作为特征提取器（冻结权重），
只训练轻量级分类头进行唤醒词检测。

优势：
- 利用 Whisper 多语言预训练（680k 小时，含中文）
- 只需 20-30 个真人样本（vs 当前 50-100 个）
- 训练步数 3000-5000（vs 当前 20000 步）

用法:
    python scripts/train_wakeword_whisper.py \
        --samples training_samples/小白小白/positive \
        --keyword "小白小白" \
        --negative-samples training_samples/negative \
        --output-dir apps/host-runtime/backend/wakeword/oww
"""

import argparse
import json
import sys
import os
from datetime import datetime
from pathlib import Path

import numpy as np
from scipy.io import wavfile

# 禁用 dynamo 以避免导出问题
os.environ["TORCH_DYNAMO_DISABLE"] = "1"


def compute_log_mel(audio: np.ndarray, sample_rate: int = 16000) -> np.ndarray:
    """
    计算 log-mel 频谱图，与 Whisper 兼容。

    Args:
        audio: 音频数组 (samples,)
        sample_rate: 采样率

    Returns:
        log-mel 特征 (80, time_frames)
    """
    import torch
    import torchaudio

    # 转换为 torch tensor
    waveform = torch.from_numpy(audio.astype(np.float32)).unsqueeze(0)

    # Whisper 的 mel 参数
    n_fft = 400
    hop_length = 160
    n_mels = 80

    # 计算 mel 频谱图
    mel_transform = torchaudio.transforms.MelSpectrogram(
        sample_rate=sample_rate,
        n_fft=n_fft,
        hop_length=hop_length,
        n_mels=n_mels,
        f_min=0.0,
        f_max=sample_rate // 2,
    )

    mel = mel_transform(waveform)  # (1, 80, time_frames)

    # 转换为 log 刻度（与 Whisper 一致）
    log_mel = torch.log(torch.clamp(mel, min=1e-10))

    # 归一化（Whisper 使用特定均值/方差）
    # 简化处理：标准化到均值 0，方差 1
    log_mel = (log_mel - log_mel.mean()) / (log_mel.std() + 1e-8)

    return log_mel.squeeze(0).numpy()  # (80, time_frames)


class WhisperWakeWordHead:
    """
    唤醒词检测分类头（Attention Pooling + MLP）

    输入: encoder features (batch, seq_len, d_model)
    输出: 置信度 (batch, 1)

    参数量: ~65K (远小于 encoder 的 8M+)
    """

    def __init__(self, d_model: int = 384):
        import torch.nn as nn
        import torch

        self.d_model = d_model

        # Attention Pooling 参数
        self.attention_weights = nn.Parameter(torch.randn(d_model))

        # MLP 分类头
        self.mlp = nn.Sequential(
            nn.Linear(d_model, 128),
            nn.ReLU(),
            nn.Dropout(0.3),
            nn.Linear(128, 32),
            nn.ReLU(),
            nn.Linear(32, 1),
            nn.Sigmoid(),
        )

    def attention_pooling(self, x):
        """Attention pooling across time dimension.

        Args:
            x: (batch, seq_len, d_model)

        Returns:
            (batch, d_model)
        """
        import torch

        # Compute attention scores
        scores = torch.einsum('bsd,d->bs', x, self.attention_weights)
        weights = torch.softmax(scores, dim=1)  # (batch, seq_len)

        # Weighted sum
        pooled = torch.einsum('bs,bsd->bd', weights, x)
        return pooled

    def __call__(self, x):
        import torch

        # Attention pooling
        pooled = self.attention_pooling(x)  # (batch, d_model)

        # MLP classification
        output = self.mlp(pooled)  # (batch, 1)
        return output


def load_audio_samples(samples_dir: Path, target_rms: float = 0.1) -> list[np.ndarray]:
    """
    加载音频样本文件。

    Args:
        samples_dir: 样本目录
        target_rms: 目标 RMS 音量

    Returns:
        音频数组列表
    """
    clips = []

    for filepath in sorted(samples_dir.iterdir()):
        if filepath.suffix.lower() != '.wav':
            continue

        try:
            sr, data = wavfile.read(str(filepath))

            # 转换为 float32
            if data.dtype == np.int16:
                data = data.astype(np.float32) / 32768.0
            elif data.dtype == np.int32:
                data = data.astype(np.float32) / 2147483648.0

            # 单声道
            if len(data.shape) > 1:
                data = data[:, 0]

            # 音量归一化
            rms = np.sqrt(np.mean(data ** 2))
            if rms > 1e-8:
                data = data * (target_rms / rms)

            clips.append(data)

        except Exception as e:
            print(f"警告: 加载 {filepath} 失败: {e}")
            continue

    return clips


def extract_whisper_features(
    clips: list[np.ndarray],
    encoder_session,
    max_length: int = 3000,
) -> list[np.ndarray]:
    """
    使用 Whisper encoder 提取特征。

    Args:
        clips: 音频数组列表
        encoder_session: ONNX encoder session
        max_length: 最大帧数（填充目标）

    Returns:
        特征数组列表 (seq_len, d_model)
    """
    import onnxruntime as ort

    encoder_input = encoder_session.get_inputs()[0]
    encoder_output = encoder_session.get_outputs()[0]

    features = []

    for clip in clips:
        # 计算 log-mel
        log_mel = compute_log_mel(clip)  # (80, time_frames)

        # 填充或截断到 max_length
        time_frames = log_mel.shape[1]
        if time_frames < max_length:
            padding = np.zeros((80, max_length - time_frames), dtype=np.float32)
            log_mel = np.concatenate([log_mel, padding], axis=1)
        else:
            log_mel = log_mel[:, :max_length]

        # 运行 encoder
        input_features = log_mel.reshape(1, 80, max_length).astype(np.float32)
        encoder_out = encoder_session.run(
            [encoder_output.name],
            {encoder_input.name: input_features}
        )[0]

        # encoder_out: (1, 1500, d_model)
        # 对于短音频，只取有效时间段
        effective_frames = min(time_frames // 2, encoder_out.shape[1])
        features.append(encoder_out[0, :effective_frames, :])

    return features


def main():
    parser = argparse.ArgumentParser(description="Whisper 迁移学习唤醒词训练")
    parser.add_argument("--samples", required=True, help="正向样本目录")
    parser.add_argument("--keyword", required=True, help="唤醒词关键词")
    parser.add_argument("--negative-samples", default="", help="负向样本目录")
    parser.add_argument("--output-dir", default="apps/host-runtime/backend/wakeword/oww", help="输出目录")
    parser.add_argument("--whisper-model", default="tiny", choices=["tiny", "base"], help="Whisper 模型大小")
    parser.add_argument("--steps", type=int, default=5000, help="训练步数")
    parser.add_argument("--encoder-path", default="", help="预导出的 encoder ONNX 路径")
    args = parser.parse_args()

    try:
        import torch
        import torch.nn as nn
        import onnx
        import onnxruntime as ort
    except ImportError as e:
        print(f"错误: 缺少依赖 - {e}")
        print("请安装: pip install torch torchaudio onnx onnxruntime transformers")
        sys.exit(1)

    output_dir = Path(args.output_dir)
    samples_dir = Path(args.samples)

    print(f"Whisper 迁移学习唤醒词训练")
    print(f"关键词: {args.keyword}")
    print(f"Whisper 模型: {args.whisper_model}")
    print(f"训练步数: {args.steps}")
    print(f"输出目录: {output_dir}")

    # ============ 1. 加载 Whisper Encoder ============
    print("\n[1/5] 加载 Whisper Encoder...")

    encoder_path = args.encoder_path
    if not encoder_path:
        # 查找已导出的 encoder
        encoder_path = output_dir / f"whisper_encoder_{args.whisper_model}.onnx"
        if not Path(encoder_path).exists():
            # 尝试默认名称
            encoder_path = output_dir / "whisper_encoder.onnx"

    if not Path(encoder_path).exists():
        print(f"错误: Encoder ONNX 不存在: {encoder_path}")
        print("请先运行: python scripts/export_whisper_encoder.py --model {args.whisper_model}")
        sys.exit(1)

    print(f"加载 encoder: {encoder_path}")
    encoder_session = ort.InferenceSession(str(encoder_path))

    # 获取模型信息
    d_model = encoder_session.get_outputs()[0].shape[-1]  # 384 for tiny, 512 for base
    print(f"Encoder 隐藏层维度: {d_model}")

    # ============ 2. 加载音频样本 ============
    print("\n[2/5] 加载音频样本...")

    print(f"加载正向样本: {samples_dir}")
    positive_clips = load_audio_samples(samples_dir)
    print(f"  正向样本数: {len(positive_clips)}")

    negative_clips = []
    if args.negative_samples:
        neg_dir = Path(args.negative_samples)
        if neg_dir.exists():
            print(f"加载负向样本: {neg_dir}")
            negative_clips = load_audio_samples(neg_dir)
            print(f"  负向样本数: {len(negative_clips)}")

    if len(positive_clips) < 10:
        print("错误: 正向样本数量不足 (至少需要 10 个)")
        sys.exit(1)

    # ============ 3. 提取特征 ============
    print("\n[3/5] 提取 Whisper 特征...")

    print("处理正向样本...")
    positive_features = extract_whisper_features(positive_clips, encoder_session)
    print(f"  正向特征数: {len(positive_features)}")

    print("处理负向样本...")
    negative_features = extract_whisper_features(negative_clips, encoder_session)
    print(f"  负向特征数: {len(negative_features)}")

    # 如果负向样本不足，从正向样本中随机采样添加噪声
    if len(negative_features) < len(positive_features):
        print(f"负向样本不足，添加 {len(positive_features) - len(negative_features)} 个噪声样本")
        for _ in range(len(positive_features) - len(negative_features)):
            idx = np.random.randint(len(positive_features))
            noise_feature = positive_features[idx] + np.random.randn(*positive_features[idx].shape).astype(np.float32) * 0.5
            negative_features.append(noise_feature)

    # ============ 4. 训练分类头 ============
    print("\n[4/5] 训练分类头...")

    # 准备训练数据
    X = positive_features + negative_features
    y = [1] * len(positive_features) + [0] * len(negative_features)

    # 打乱
    indices = np.random.permutation(len(X))
    X = [X[i] for i in indices]
    y = [y[i] for i in indices]

    # 划分训练集/验证集
    split = int(len(X) * 0.8)
    X_train, X_val = X[:split], X[split:]
    y_train, y_val = y[:split], y[split:]

    print(f"训练集: {len(X_train)}, 验证集: {len(X_val)}")

    # 创建分类头
    class WakeWordHead(nn.Module):
        def __init__(self, d_model):
            super().__init__()
            self.attention_weights = nn.Parameter(torch.randn(d_model) * 0.1)
            self.fc1 = nn.Linear(d_model, 128)
            self.fc2 = nn.Linear(128, 32)
            self.fc3 = nn.Linear(32, 1)
            self.relu = nn.ReLU()
            self.dropout = nn.Dropout(0.3)
            self.sigmoid = nn.Sigmoid()

        def attention_pooling(self, x):
            scores = torch.einsum('bsd,d->bs', x, self.attention_weights)
            weights = torch.softmax(scores, dim=1)
            return torch.einsum('bs,bsd->bd', weights, x)

        def forward(self, x):
            pooled = self.attention_pooling(x)
            x = self.dropout(self.relu(self.fc1(pooled)))
            x = self.dropout(self.relu(self.fc2(x)))
            return self.sigmoid(self.fc3(x))

    model = WakeWordHead(d_model)
    optimizer = torch.optim.Adam(model.parameters(), lr=0.001, weight_decay=1e-4)
    criterion = nn.BCELoss()

    # 训练循环
    batch_size = min(32, len(X_train))
    best_val_acc = 0
    best_state = None

    for step in range(args.steps):
        model.train()

        # 随机采样 batch
        indices = np.random.choice(len(X_train), batch_size, replace=False)
        batch_x = [torch.tensor(X_train[i], dtype=torch.float32) for i in indices]
        batch_y = torch.tensor([y_train[i] for i in indices], dtype=torch.float32).unsqueeze(1)

        # 前向传播
        outputs = torch.stack([model(x.unsqueeze(0)).squeeze(0) for x in batch_x])
        loss = criterion(outputs, batch_y)

        # 反向传播
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()

        # 验证
        if step % 500 == 0:
            model.eval()
            with torch.no_grad():
                # 训练集准确率
                train_preds = []
                for x in X_train:
                    out = model(torch.tensor(x, dtype=torch.float32).unsqueeze(0))
                    train_preds.append(out.item())
                train_acc = sum((p > 0.5) == y for p, y in zip(train_preds, y_train)) / len(y_train)

                # 验证集准确率
                val_preds = []
                for x in X_val:
                    out = model(torch.tensor(x, dtype=torch.float32).unsqueeze(0))
                    val_preds.append(out.item())
                val_acc = sum((p > 0.5) == y for p, y in zip(val_preds, y_val)) / len(y_val)

                # 分别计算正负样本
                pos_correct = sum((p > 0.5) == y for p, y in zip(val_preds, y_val) if y == 1)
                neg_correct = sum((p <= 0.5) == y for p, y in zip(val_preds, y_val) if y == 0)
                pos_total = sum(1 for y in y_val if y == 1)
                neg_total = sum(1 for y in y_val if y == 0)
                pos_acc = pos_correct / pos_total if pos_total > 0 else 0
                neg_acc = neg_correct / neg_total if neg_total > 0 else 0

            print(f"Step {step}: Loss={loss.item():.4f}, Train={train_acc:.1%}, Val={val_acc:.1%} (Pos={pos_acc:.1%}, Neg={neg_acc:.1%})")

            if val_acc > best_val_acc:
                best_val_acc = val_acc
                best_state = {k: v.clone() for k, v in model.state_dict().items()}

    # 加载最佳模型
    if best_state:
        model.load_state_dict(best_state)
        print(f"加载最佳模型 (验证准确率: {best_val_acc:.1%})")

    # ============ 5. 导出 ONNX ============
    print("\n[5/5] 导出 ONNX 模型...")

    safe_name = args.keyword.replace(" ", "_")
    model_path = output_dir / f"{safe_name}.onnx"

    # 创建完整的推理模型（encoder + head）
    # 注意：由于我们分开存储 encoder 和 head，这里只导出 head
    # 推理时先运行 encoder，再运行 head

    # 导出 head
    head_path = output_dir / f"{safe_name}_head.onnx"
    dummy_input = torch.randn(1, 1500, d_model)  # 假设最大 1500 帧

    torch.onnx.export(
        model,
        dummy_input,
        str(head_path),
        input_names=["encoder_features"],
        output_names=["confidence"],
        opset_version=18,
        do_constant_folding=True,
    )

    print(f"分类头已导出: {head_path}")

    # 复制 encoder 到输出目录（如果不在同一位置）
    final_encoder_path = output_dir / f"whisper_encoder_{args.whisper_model}.onnx"
    if Path(encoder_path) != final_encoder_path:
        import shutil
        shutil.copy(encoder_path, final_encoder_path)
        print(f"Encoder 已复制: {final_encoder_path}")

    # 创建元数据
    meta = {
        "keyword": args.keyword,
        "version": 3,
        "method": "whisper_transfer",
        "whisper_model": f"openai/whisper-{args.whisper_model}",
        "d_model": d_model,
        "encoder_path": str(final_encoder_path.name),
        "head_path": str(head_path.name),
        "input_shape": [1, 80, 3000],
        "created_at": datetime.now().isoformat(),
        "training": {
            "steps": args.steps,
            "positive_samples": len(positive_clips),
            "negative_samples": len(negative_clips),
            "best_val_accuracy": round(best_val_acc, 4),
        }
    }

    meta_path = output_dir / f"{safe_name}.json"
    with open(meta_path, "w") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)

    print(f"元数据已保存: {meta_path}")

    # 总结
    print("\n" + "="*50)
    print("训练完成!")
    print(f"关键词: {args.keyword}")
    print(f"模型文件: {head_path}")
    print(f"Encoder: {final_encoder_path}")
    print(f"验证准确率: {best_val_acc:.1%}")
    print("="*50)

    return 0


if __name__ == "__main__":
    sys.exit(main())