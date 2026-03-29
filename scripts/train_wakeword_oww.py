#!/usr/bin/env python3
"""
使用 openwakeword 官方流程训练唤醒词

流程:
1. 使用 OWW 的 melspectrogram + embedding 模型提取特征
2. 训练分类模型
3. 导出 ONNX
"""

import argparse
import json
import sys
from datetime import datetime
from pathlib import Path

import numpy as np
from scipy.io import wavfile


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
        import openwakeword
    except ImportError as e:
        print(f"错误: {e}")
        sys.exit(1)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    samples_dir = Path(args.samples)

    print(f"训练模型: {args.keyword}")
    print(f"输出目录: {output_dir}")

    # 加载 OWW 的特征提取模型
    print("\n加载 OWW 特征提取模型...")
    oww_model = openwakeword.Model()

    # 加载音频样本
    print("\n加载正向样本...")
    positive_clips = []
    for f in sorted(samples_dir.iterdir()):
        if f.suffix.lower() == '.wav':
            try:
                sr, data = wavfile.read(str(f))
                if data.dtype == np.int16:
                    data = data.astype(np.float32) / 32768.0
                positive_clips.append(data)
            except Exception as e:
                print(f"警告: 无法加载 {f}: {e}")

    if len(positive_clips) == 0:
        print("错误: 未找到音频样本")
        sys.exit(1)

    print(f"加载了 {len(positive_clips)} 个正向样本")

    # 使用 OWW 提取 embedding 特征
    print("\n提取 embedding 特征...")
    positive_features = []

    for clip in positive_clips:
        try:
            # openwakeword 内部会处理 mel + embedding
            # 获取 embedding 输出
            # OWW 模型期望 16kHz 音频
            features = oww_model.get_embedding(clip)
            if features is not None and len(features) > 0:
                positive_features.append(features)
        except Exception as e:
            print(f"特征提取失败: {e}")
            continue

    if len(positive_features) == 0:
        print("错误: 特征提取失败")
        sys.exit(1)

    print(f"提取了 {len(positive_features)} 个特征向量")

    # 获取特征维度
    feature_dim = positive_features[0].shape[-1] if hasattr(positive_features[0], 'shape') else len(positive_features[0])
    print(f"特征维度: {feature_dim}")

    # 转换为 numpy
    X_positive = np.array([f.flatten() if hasattr(f, 'flatten') else np.array(f).flatten() for f in positive_features], dtype=np.float32)

    # 生成负向样本
    print("生成负向样本...")
    # 使用真实负向数据或随机噪声
    try:
        negative_path = Path(openwakeword.__file__).parent / "negative_data"
        if negative_path.exists():
            negative_clips = []
            for f in sorted(negative_path.iterdir())[:len(positive_clips)]:
                if f.suffix == '.wav':
                    sr, data = wavfile.read(str(f))
                    if data.dtype == np.int16:
                        data = data.astype(np.float32) / 32768.0
                    negative_clips.append(data)

            if negative_clips:
                X_negative = []
                for clip in negative_clips:
                    try:
                        features = oww_model.get_embedding(clip)
                        if features is not None:
                            X_negative.append(features.flatten() if hasattr(features, 'flatten') else np.array(features).flatten())
                    except:
                        pass
                if X_negative:
                    X_negative = np.array(X_negative, dtype=np.float32)
                    print(f"使用 {len(X_negative)} 个真实负向样本")
    except Exception as e:
        print(f"警告: 无法加载负向数据: {e}")

    if 'X_negative' not in dir() or len(X_negative) == 0:
        # 使用随机噪声作为负向样本
        X_negative = np.random.randn(len(positive_features), feature_dim).astype(np.float32) * 0.1
        print(f"使用 {len(X_negative)} 个随机噪声负向样本")

    # 合并数据
    X = np.concatenate([X_positive, X_negative], axis=0)
    y = np.concatenate([np.ones(len(X_positive)), np.zeros(len(X_negative))], axis=0)

    # 打乱
    indices = np.random.permutation(len(X))
    X = X[indices]
    y = y[indices]

    print(f"\n训练数据: {X.shape}")

    # 创建简单的分类模型
    class WakeWordClassifier(nn.Module):
        def __init__(self, input_dim):
            super().__init__()
            self.fc1 = nn.Linear(input_dim, 128)
            self.fc2 = nn.Linear(128, 64)
            self.fc3 = nn.Linear(64, 1)
            self.relu = nn.ReLU()
            self.dropout = nn.Dropout(0.3)
            self.sigmoid = nn.Sigmoid()

        def forward(self, x):
            x = self.relu(self.fc1(x))
            x = self.dropout(x)
            x = self.relu(self.fc2(x))
            x = self.dropout(x)
            x = self.fc3(x)
            return self.sigmoid(x)

    model = WakeWordClassifier(feature_dim)

    # 训练
    print(f"\n开始训练（steps={args.steps}）...")
    optimizer = torch.optim.Adam(model.parameters(), lr=0.001)
    criterion = nn.BCELoss()

    X_tensor = torch.from_numpy(X)
    y_tensor = torch.from_numpy(y).unsqueeze(1)

    model.train()
    batch_size = 32

    for step in range(args.steps):
        idx = np.random.choice(len(X), min(batch_size, len(X)), replace=False)
        batch_X = X_tensor[idx]
        batch_y = y_tensor[idx]

        optimizer.zero_grad()
        output = model(batch_X)
        loss = criterion(output, batch_y)
        loss.backward()
        optimizer.step()

        if step % 1000 == 0:
            with torch.no_grad():
                pred = (output > 0.5).float()
                acc = (pred == batch_y).float().mean()
            print(f"Step {step}: Loss = {loss.item():.4f}, Acc = {acc.item():.2%}")

    # 导出 ONNX
    print("\n导出模型...")
    model.eval()
    safe_name = args.keyword.replace(" ", "_")
    onnx_path = output_dir / f"{safe_name}.onnx"

    dummy_input = torch.randn(1, feature_dim)
    torch.onnx.export(
        model,
        dummy_input,
        str(onnx_path),
        opset_version=13,
        input_names=['input'],
        output_names=['output'],
        dynamic_axes={'input': {0: 'batch_size'}, 'output': {0: 'batch_size'}},
    )

    # 验证
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


if __name__ == "__main__":
    main()