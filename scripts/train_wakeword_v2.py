#!/usr/bin/env python3
"""
训练唤醒词模型 - 使用正确的 OWW 特征流程
"""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
from scipy.io import wavfile


def extract_mel_embedding(clip, mel_session, emb_session):
    """使用 OWW 的 mel + embedding 模型提取特征"""
    import onnxruntime as ort

    # 填充/截断到目标长度
    target_len = 1280 * 16  # 约 1.28 秒
    if len(clip) < target_len:
        clip = np.pad(clip, (0, target_len - len(clip)))
    else:
        clip = clip[:target_len]

    # 分块处理，模拟 OWW 的处理流程
    chunk_size = 1280
    mel_frames = []

    for i in range(0, len(clip) - chunk_size + 1, chunk_size):
        chunk = clip[i:i + chunk_size].astype(np.float32)

        # Mel spectrogram
        mel_input = chunk.reshape(1, -1)
        mel_out = mel_session.run(None, {'input': mel_input})
        mel_frame = mel_out[0]  # shape depends on mel model

        if mel_frame is not None:
            mel_frames.append(mel_frame)

    if not mel_frames:
        return None

    # 合并 mel frames
    all_mel = np.concatenate(mel_frames, axis=0)

    # Embedding
    # 需要调整形状以匹配 embedding 模型输入 (batch, 76, 32, 1)
    if all_mel.shape[0] >= 76:
        # 取足够的帧
        mel_for_emb = all_mel[:76]
        if len(mel_for_emb.shape) == 2:
            mel_for_emb = mel_for_emb.reshape(1, 76, 32, 1)
        elif len(mel_for_emb.shape) == 3:
            mel_for_emb = mel_for_emb.transpose(0, 2, 1)
            mel_for_emb = mel_for_emb.reshape(1, 76, 32, 1)

        emb_out = emb_session.run(None, {'input_1': mel_for_emb.astype(np.float32)})
        embedding = emb_out[0]  # (1, 1, 1, 96) or similar

        return embedding.flatten()

    return None


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", required=True)
    parser.add_argument("--keyword", required=True)
    parser.add_argument("--output-dir", default="apps/host-runtime/backend/wakeword/oww")
    parser.add_argument("--steps", type=int, default=20000)
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

    # 加载音频
    print("加载正向样本...")
    positive_clips = []
    for f in sorted(samples_dir.iterdir()):
        if f.suffix.lower() == '.wav':
            try:
                sr, data = wavfile.read(str(f))
                if data.dtype == np.int16:
                    data = data.astype(np.float32) / 32768.0
                positive_clips.append(data)
            except Exception as e:
                pass

    print(f"加载了 {len(positive_clips)} 个样本")

    # 提取特征
    print("\n提取 embedding 特征...")
    positive_features = []

    for clip in positive_clips:
        emb = extract_mel_embedding(clip, mel_session, emb_session)
        if emb is not None:
            positive_features.append(emb)

    if not positive_features:
        print("错误: 无法提取特征")
        sys.exit(1)

    X_positive = np.array(positive_features, dtype=np.float32)
    print(f"正向特征: {X_positive.shape}")

    # 生成负向样本（随机 embedding）
    # 实际应该用真实负向音频，这里用随机数模拟
    X_negative = np.random.randn(len(positive_features), 96).astype(np.float32) * 0.5
    print(f"负向样本: {X_negative.shape}")

    # 合并
    X = np.concatenate([X_positive, X_negative], axis=0)
    y = np.concatenate([np.ones(len(X_positive)), np.zeros(len(X_negative))])

    # 打乱
    idx = np.random.permutation(len(X))
    X, y = X[idx], y[idx]

    # 模型 - 输入 (batch, 96) embedding
    class Model(nn.Module):
        def __init__(self):
            super().__init__()
            self.net = nn.Sequential(
                nn.Linear(96, 64),
                nn.ReLU(),
                nn.Dropout(0.3),
                nn.Linear(64, 32),
                nn.ReLU(),
                nn.Linear(32, 1),
                nn.Sigmoid()
            )

        def forward(self, x):
            return self.net(x)

    model = Model()

    # 训练
    print(f"\n训练 {args.steps} 步...")
    optimizer = torch.optim.Adam(model.parameters(), lr=0.001)
    criterion = nn.BCELoss()

    X_t = torch.from_numpy(X)
    y_t = torch.from_numpy(y).unsqueeze(1)

    model.train()
    for step in range(args.steps):
        idx = np.random.choice(len(X), 32, replace=False)
        loss = criterion(model(X_t[idx]), y_t[idx])
        optimizer.zero_grad()
        loss.backward()
        optimizer.step()

        if step % 2000 == 0:
            with torch.no_grad():
                acc = ((model(X_t) > 0.5).float() == y_t).float().mean()
            print(f"Step {step}: Loss={loss.item():.4f} Acc={acc.item():.1%}")

    # 导出
    print("\n导出 ONNX...")
    model.eval()
    onnx_path = output_dir / f"{args.keyword.replace(' ', '_')}.onnx"

    torch.onnx.export(
        model,
        torch.randn(1, 96),
        str(onnx_path),
        opset_version=13,
        input_names=['input'],
        output_names=['output'],
        dynamic_axes={'input': {0: 'batch'}, 'output': {0: 'batch'}},
    )

    # 验证
    onnx_model = onnx.load(str(onnx_path))
    print(f"导出成功: IR={onnx_model.ir_version}, opset=13")

    # 元数据
    meta = {"keyword": args.keyword, "version": 1, "created_at": datetime.now().isoformat()}
    with open(onnx_path.with_suffix(".json"), "w") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)

    print(f"\n完成: {onnx_path}")


if __name__ == "__main__":
    main()