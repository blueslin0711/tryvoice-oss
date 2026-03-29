#!/usr/bin/env python3
"""
训练自定义唤醒词模型

使用方法:
    python scripts/train_wakeword_simple.py --keyword "大橘大橘" --samples /path/to/samples --output-dir output
"""

import argparse
import json
import os
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
from scipy.io import wavfile


def load_audio_files(directory: Path, target_sr: int = 16000):
    """加载音频文件"""
    clips = []
    for f in sorted(directory.iterdir()):
        if f.suffix.lower() == '.wav':
            try:
                sr, data = wavfile.read(str(f))
                # 转换为 float32
                if data.dtype == np.int16:
                    data = data.astype(np.float32) / 32768.0
                elif data.dtype == np.int32:
                    data = data.astype(np.float32) / 2147483648.0
                else:
                    data = data.astype(np.float32)
                clips.append(data)
            except Exception as e:
                print(f"警告: 无法加载 {f}: {e}")
                continue
    return clips


def main():
    parser = argparse.ArgumentParser(description="训练唤醒词模型")
    parser.add_argument("--samples", required=True, help="样本目录路径")
    parser.add_argument("--keyword", required=True, help="唤醒词名称")
    parser.add_argument("--output-dir", default="apps/host-runtime/backend/wakeword/oww", help="输出目录")
    parser.add_argument("--steps", type=int, default=10000, help="训练步数")
    args = parser.parse_args()

    try:
        import torch
        import torch.nn as nn
        import onnx
    except ImportError as e:
        print(f"错误: {e}")
        sys.exit(1)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    samples_dir = Path(args.samples)
    if not samples_dir.is_dir():
        print(f"错误: 样本目录不存在: {samples_dir}")
        sys.exit(1)

    print(f"训练模型: {args.keyword}")
    print(f"输出目录: {output_dir}")

    # 加载正向样本
    print("\n加载正向样本...")
    positive_clips = load_audio_files(samples_dir)
    if len(positive_clips) == 0:
        print("错误: 未找到音频样本")
        sys.exit(1)

    print(f"加载了 {len(positive_clips)} 个正向样本")

    # 创建一个简单的 CNN 模型
    class WakeWordModel(nn.Module):
        def __init__(self):
            super().__init__()
            # 输入: (batch, 1, 1280) - 80ms 音频 @ 16kHz
            self.conv1 = nn.Conv1d(1, 32, kernel_size=5, stride=2, padding=2)
            self.conv2 = nn.Conv1d(32, 64, kernel_size=5, stride=2, padding=2)
            self.conv3 = nn.Conv1d(64, 128, kernel_size=5, stride=2, padding=2)
            self.pool = nn.AdaptiveAvgPool1d(1)
            self.fc = nn.Linear(128, 1)
            self.relu = nn.ReLU()
            self.sigmoid = nn.Sigmoid()

        def forward(self, x):
            x = self.relu(self.conv1(x))
            x = self.relu(self.conv2(x))
            x = self.relu(self.conv3(x))
            x = self.pool(x)
            x = x.squeeze(-1)
            x = self.fc(x)
            return self.sigmoid(x)

    model = WakeWordModel()

    # 准备训练数据
    print("\n准备训练数据...")
    target_len = 1280  # 80ms

    X_positive = []
    for clip in positive_clips:
        # 截取或填充到目标长度
        if len(clip) >= target_len:
            # 随机截取多段
            for i in range(0, len(clip) - target_len, target_len // 2):
                segment = clip[i:i + target_len]
                X_positive.append(segment)
        else:
            # 填充
            padded = np.pad(clip, (0, target_len - len(clip)))
            X_positive.append(padded)

    X_positive = np.array(X_positive, dtype=np.float32)
    print(f"正向样本段数: {len(X_positive)}")

    # 生成负向样本（随机噪声 + 环境噪声模拟）
    X_negative = np.random.randn(len(X_positive), target_len).astype(np.float32) * 0.1

    # 合并数据
    X = np.concatenate([X_positive, X_negative], axis=0)
    y = np.concatenate([np.ones(len(X_positive)), np.zeros(len(X_negative))], axis=0)

    # 打乱
    indices = np.random.permutation(len(X))
    X = X[indices]
    y = y[indices]

    # 添加通道维度
    X = X[:, np.newaxis, :]  # (N, 1, 1280)

    print(f"训练数据形状: {X.shape}")

    # 训练
    print(f"\n开始训练（steps={args.steps}）...")
    optimizer = torch.optim.Adam(model.parameters(), lr=0.001)
    criterion = nn.BCELoss()

    X_tensor = torch.from_numpy(X)
    y_tensor = torch.from_numpy(y).unsqueeze(1)

    model.train()
    batch_size = 32

    for step in range(args.steps):
        # 随机采样批次
        idx = np.random.choice(len(X), batch_size, replace=False)
        batch_X = X_tensor[idx]
        batch_y = y_tensor[idx]

        optimizer.zero_grad()
        output = model(batch_X)
        loss = criterion(output, batch_y)
        loss.backward()
        optimizer.step()

        if step % 1000 == 0:
            # 计算准确率
            with torch.no_grad():
                pred = (output > 0.5).float()
                acc = (pred == batch_y).float().mean()
            print(f"Step {step}: Loss = {loss.item():.4f}, Acc = {acc.item():.2%}")

    # 导出模型
    print("\n导出模型...")
    model.eval()
    safe_name = args.keyword.replace(" ", "_")
    onnx_path = output_dir / f"{safe_name}.onnx"

    dummy_input = torch.randn(1, 1, 1280)
    torch.onnx.export(
        model,
        dummy_input,
        str(onnx_path),
        opset_version=13,
        input_names=['input'],
        output_names=['output'],
        dynamic_axes={'input': {0: 'batch_size'}, 'output': {0: 'batch_size'}},
    )
    print(f"模型已导出: {onnx_path}")

    # 验证 ONNX 模型
    onnx_model = onnx.load(str(onnx_path))
    onnx.checker.check_model(onnx_model)
    print(f"ONNX 验证通过: IR={onnx_model.ir_version}, opset={[o.version for o in onnx_model.opset_import]}")

    # 创建元数据
    meta = {
        "keyword": args.keyword,
        "version": 1,
        "created_at": datetime.now().strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    meta_path = onnx_path.with_suffix(".json")
    with open(meta_path, "w", encoding="utf-8") as f:
        json.dump(meta, f, indent=2, ensure_ascii=False)

    print(f"\n训练完成!")
    print(f"模型文件: {onnx_path}")
    print(f"元数据文件: {meta_path}")


if __name__ == "__main__":
    main()