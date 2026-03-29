#!/usr/bin/env python3
"""
训练自定义中文唤醒词/结束词模型

使用方法:
    python scripts/train_chinese_wakeword.py "小助手" --output-dir apps/host-runtime/backend/wakeword/oww

依赖安装:
    pip install openwakeword edge-tts

原理:
    使用 edge-tts 合成训练样本，然后用 openwakeword 训练模型
"""

import argparse
import json
import os
import sys
import tempfile
import asyncio
from datetime import datetime
from pathlib import Path

# Monkey patch for torchaudio compatibility with speechbrain
try:
    import torchaudio
    if not hasattr(torchaudio, 'list_audio_backends'):
        torchaudio.list_audio_backends = lambda: []
except ImportError:
    pass


async def generate_tts_samples(keyword: str, output_dir: Path, num_samples: int, voices: list):
    """使用 edge-tts 生成 TTS 样本"""
    import edge_tts

    samples = []
    for i in range(num_samples):
        voice = voices[i % len(voices)]
        output_file = output_dir / f"sample_{i}.wav"

        # 使用不同的语速和音调增加多样性
        rate = "-10%" if i % 3 == 0 else ("+10%" if i % 3 == 1 else "+0%")

        communicate = edge_tts.Communicate(keyword, voice, rate=rate)
        await communicate.save(str(output_file))
        samples.append(str(output_file))

        if (i + 1) % 100 == 0:
            print(f"已生成 {i + 1}/{num_samples} 个样本")

    return samples


def main():
    parser = argparse.ArgumentParser(description="训练中文唤醒词模型")
    parser.add_argument("keyword", help="唤醒词/结束词，如 '小助手'、'我说好了'")
    parser.add_argument("--output-dir", default="apps/host-runtime/backend/wakeword/oww", help="输出目录")
    parser.add_argument("--role", choices=["wakeword", "endword", "cancelword"], default="endword", help="模型角色")
    parser.add_argument("--epochs", type=int, default=30, help="训练步数（实际为 steps 参数）")
    parser.add_argument("--samples", type=int, default=1000, help="正向训练样本数")
    parser.add_argument("--voices", default="zh-CN-XiaoxiaoNeural,zh-CN-YunxiNeural,zh-CN-YunyangNeural", help="TTS 语音列表")
    args = parser.parse_args()

    try:
        import edge_tts
    except ImportError as e:
        print(f"错误: 请先安装 edge-tts")
        print(f"  pip install edge-tts")
        print(f"详细错误: {e}")
        sys.exit(1)

    try:
        import openwakeword
        from openwakeword.train import Model, augment_clips
        from openwakeword.data import mmap_batch_generator
        import torch
        import numpy as np
        import scipy.io.wavfile as wavfile
    except ImportError as e:
        print(f"错误: 请先安装 openwakeword 和相关依赖")
        print(f"  pip install openwakeword torch torchaudio speechbrain librosa scipy")
        print(f"详细错误: {e}")
        sys.exit(1)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    voices = args.voices.split(",")

    print(f"训练模型: {args.keyword}")
    print(f"角色: {args.role}")
    print(f"输出目录: {output_dir}")
    print(f"TTS 语音: {voices}")
    print("开始训练...")

    # 创建临时目录存放样本
    with tempfile.TemporaryDirectory() as tmp_dir:
        positive_dir = Path(tmp_dir) / "positive"
        positive_dir.mkdir()

        # 生成正向样本
        print(f"\n生成 {args.samples} 个正向样本...")
        asyncio.run(generate_tts_samples(args.keyword, positive_dir, args.samples, voices))

        # 加载音频文件
        print("\n加载正向样本...")
        positive_clips = []
        for f in sorted(positive_dir.iterdir()):
            if f.suffix == ".wav":
                sr, data = wavfile.read(str(f))
                if sr != 16000:
                    # 需要重采样到 16kHz
                    from scipy import signal
                    data = signal.resample_poly(data, 16000, sr)
                positive_clips.append(data)

        # 转换为 numpy array
        positive_data = np.array(positive_clips, dtype=np.float32) / 32768.0

        print(f"正向样本形状: {positive_data.shape}")

        # 获取负向样本数据（使用 openwakeword 内置的负向数据）
        print("\n准备负向样本数据...")

        # 从 openwakeword 获取内置的负向音频数据路径
        try:
            # 使用 openwakeword 内置的负向数据
            negative_data_path = Path(openwakeword.__file__).parent / "negative_data"
            if negative_data_path.exists():
                negative_clips = []
                for f in negative_data_path.iterdir():
                    if f.suffix == ".wav":
                        sr, data = wavfile.read(str(f))
                        negative_clips.append(data)
                negative_data = np.array(negative_clips, dtype=np.float32) / 32768.0
                print(f"使用内置负向样本: {len(negative_clips)} 个")
            else:
                print("警告: 未找到内置负向数据，将使用随机噪声")
                negative_data = np.random.randn(1000, 1280).astype(np.float32) * 0.1
        except Exception as e:
            print(f"警告: 加载负向数据失败: {e}")
            negative_data = np.random.randn(1000, 1280).astype(np.float32) * 0.1

        # 创建训练数据
        print("\n创建训练特征...")

        # 创建模型
        model = Model(n_classes=1, input_shape=(16, 96), model_type="dnn", layer_dim=128)

        # 从音频计算特征
        from openwakeword.train import compute_features_from_generator

        # 正向特征
        positive_features = []
        for clip in positive_data:
            # 填充/裁剪到固定长度（约 0.08 秒 = 1280 样本）
            target_len = 1280
            if len(clip) < target_len:
                clip = np.pad(clip, (0, target_len - len(clip)))
            else:
                clip = clip[:target_len]

            # 计算特征
            features = model.compute_features(clip)
            positive_features.append(features)

        X_positive = np.array(positive_features)

        # 负向特征
        negative_features = []
        for clip in negative_data[:min(len(negative_data), args.samples)]:
            target_len = 1280
            if len(clip) < target_len:
                clip = np.pad(clip, (0, target_len - len(clip)))
            else:
                clip = clip[:target_len]

            features = model.compute_features(clip)
            negative_features.append(features)

        X_negative = np.array(negative_features)

        # 合并训练数据
        X_train = np.vstack([X_positive, X_negative])
        y_train = np.hstack([np.ones(len(X_positive)), np.zeros(len(X_negative))])

        print(f"训练数据形状: {X_train.shape}")

        # 验证数据
        X_val = X_train[:min(100, len(X_train))]
        false_positive_val_data = X_negative[:min(50, len(X_negative))]

        # 训练模型
        print(f"\n开始训练（steps={args.epochs * 1000}）...")
        model.auto_train(
            X_train=torch.from_numpy(X_train),
            X_val=torch.from_numpy(X_val),
            false_positive_val_data=torch.from_numpy(false_positive_val_data),
            steps=args.epochs * 1000,
            target_fp_per_hour=0.5
        )

        # 导出模型
        print("\n导出模型...")
        safe_name = args.keyword.replace(" ", "_")
        model_name = f"{safe_name}"
        model.export_model(model, model_name, str(output_dir))

        # 创建元数据文件
        meta = {
            "keyword": args.keyword,
            "version": 1,
            "created_at": datetime.now().strftime("%Y-%m-%dT%H:%M:%SZ"),
        }
        if args.role != "wakeword":
            meta["role"] = args.role

        # 查找生成的 onnx 文件
        onnx_file = output_dir / f"{model_name}.onnx"
        meta_path = onnx_file.with_suffix(".json")
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2, ensure_ascii=False)

        print(f"\n元数据已创建: {meta_path.name}")
        print("\n训练完成!")
        print(f"模型文件: {onnx_file}")


if __name__ == "__main__":
    main()