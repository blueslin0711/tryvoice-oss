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

    # 获取 mel 模型的输出信息
    mel_input_name = mel_session.get_inputs()[0].name
    emb_input_name = emb_session.get_inputs()[0].name
    print(f"Mel 输入: {mel_input_name}")
    print(f"Emb 输入: {emb_input_name}")

    def extract_embeddings(clip):
        """从音频片段提取 embedding 序列"""
        # 确保是 float32
        clip = clip.astype(np.float32)

        # 填充到足够长度
        min_len = 1280 * 20  # 至少 20 个 chunk
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

    # 创建模型 - 输入 (batch, 16, 96)
    class WakeWordModel(nn.Module):
        def __init__(self):
            super().__init__()
            # 展平后 16*96 = 1536
            self.flatten = nn.Flatten()
            self.fc1 = nn.Linear(16 * 96, 256)
            self.fc2 = nn.Linear(256, 64)
            self.fc3 = nn.Linear(64, 1)
            self.relu = nn.ReLU()
            self.dropout = nn.Dropout(0.3)
            self.sigmoid = nn.Sigmoid()

        def forward(self, x):
            x = self.flatten(x)
            x = self.relu(self.fc1(x))
            x = self.dropout(x)
            x = self.relu(self.fc2(x))
            x = self.dropout(x)
            x = self.fc3(x)
            return self.sigmoid(x)

    model = WakeWordModel()

    # 训练
    print(f"\n训练 {args.steps} 步...")
    sys.stdout.flush()
    optimizer = torch.optim.Adam(model.parameters(), lr=0.001)
    criterion = nn.BCELoss()

    X_t = torch.from_numpy(X).float()
    y_t = torch.from_numpy(y).float().unsqueeze(1)

    model.train()
    batch_size = 32

    for step in range(args.steps):
        idx = np.random.choice(len(X), min(batch_size, len(X)), replace=False)
        output = model(X_t[idx])
        loss = criterion(output, y_t[idx])

        optimizer.zero_grad()
        loss.backward()
        optimizer.step()

        # 输出进度每 1000 步
        if step % 1000 == 0:
            with torch.no_grad():
                pred = (model(X_t) > 0.5).float()
                acc = (pred == y_t).float().mean()
            print(f"Step {step}: Loss={loss.item():.4f} Acc={acc.item():.1%}")
            sys.stdout.flush()  # 确保输出被刷新

    # 保存权重
    safe_name = args.keyword.replace(" ", "_")
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