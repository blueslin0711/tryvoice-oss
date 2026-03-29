#!/usr/bin/env python3
"""
使用预生成样本训练唤醒词模型

使用方法:
    # 1. 先生成样本（需要在本地执行）
    python scripts/generate_samples.py "大橘大橘" --output /tmp/samples --count 500

    # 2. 然后训练
    python scripts/train_from_samples.py --samples /tmp/samples --keyword "大橘大橘" --output-dir output

依赖安装:
    pip install openwakeword torch torchaudio speechbrain librosa scipy
"""

import argparse
import json
import os
import sys
import tempfile
from datetime import datetime
from pathlib import Path

# Monkey patch for torchaudio compatibility with speechbrain
try:
    import torchaudio
    if not hasattr(torchaudio, 'list_audio_backends'):
        torchaudio.list_audio_backends = lambda: []
except ImportError:
    pass


def load_audio_files(directory: Path, target_sr: int = 16000):
    """加载音频文件并重采样到目标采样率"""
    import numpy as np
    from scipy.io import wavfile
    from scipy import signal

    clips = []
    for f in sorted(directory.iterdir()):
        if f.suffix.lower() in ('.wav', '.mp3'):
            try:
                sr, data = wavfile.read(str(f))
                # 转换为 float32
                if data.dtype == np.int16:
                    data = data.astype(np.float32) / 32768.0
                elif data.dtype == np.int32:
                    data = data.astype(np.float32) / 2147483648.0
                else:
                    data = data.astype(np.float32)

                # 重采样到 16kHz
                if sr != target_sr:
                    data = signal.resample_poly(data, target_sr, sr)

                clips.append(data)
            except Exception as e:
                print(f"警告: 无法加载 {f}: {e}")
                continue

    return clips


def main():
    parser = argparse.ArgumentParser(description="使用预生成样本训练唤醒词模型")
    parser.add_argument("--samples", required=True, help="样本目录路径")
    parser.add_argument("--keyword", required=True, help="唤醒词名称")
    parser.add_argument("--output-dir", default="apps/host-runtime/backend/wakeword/oww", help="输出目录")
    parser.add_argument("--role", choices=["wakeword", "endword", "cancelword"], default="wakeword", help="模型角色")
    parser.add_argument("--steps", type=int, default=10000, help="训练步数")
    args = parser.parse_args()

    try:
        import openwakeword
        from openwakeword.train import Model
        import torch
        import numpy as np
    except ImportError as e:
        print(f"错误: 请先安装 openwakeword 和相关依赖")
        print(f"  pip install openwakeword torch torchaudio speechbrain librosa scipy")
        print(f"详细错误: {e}")
        sys.exit(1)

    output_dir = Path(args.output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    samples_dir = Path(args.samples)
    if not samples_dir.is_dir():
        print(f"错误: 样本目录不存在: {samples_dir}")
        sys.exit(1)

    print(f"训练模型: {args.keyword}")
    print(f"角色: {args.role}")
    print(f"输出目录: {output_dir}")
    print(f"样本目录: {samples_dir}")

    # 加载正向样本
    print("\n加载正向样本...")
    positive_clips = load_audio_files(samples_dir)
    if len(positive_clips) == 0:
        print("错误: 未找到音频样本")
        sys.exit(1)

    print(f"加载了 {len(positive_clips)} 个正向样本")

    # 创建模型
    model = Model(n_classes=1, input_shape=(16, 96), model_type="dnn", layer_dim=128)

    # 计算正向特征 (保持与模型输入形状一致)
    print("\n计算正向特征...")
    positive_features = []
    target_len = 1280  # ~80ms at 16kHz

    for clip in positive_clips:
        # 填充/裁剪到固定长度
        if len(clip) < target_len:
            clip = np.pad(clip, (0, target_len - len(clip)))
        else:
            clip = clip[:target_len]

        # 模型期望输入形状 (16, 96)
        try:
            import librosa
            mel = librosa.feature.melspectrogram(
                y=clip, sr=16000, n_mels=96, n_fft=512, hop_length=160
            )
            mel = librosa.power_to_db(mel)
            # 取前 16 帧
            mel = mel[:16, :96]
            if mel.shape[1] < 96:
                mel = np.pad(mel, ((0, 0), (0, 96 - mel.shape[1])))
            positive_features.append(mel)  # 形状 (16, 96)
        except Exception as e:
            print(f"警告: 特征计算失败: {e}")
            continue

    X_positive = np.array(positive_features, dtype=np.float32)  # (N, 16, 96)
    print(f"正向特征形状: {X_positive.shape}")

    # 获取负向样本
    print("\n准备负向样本...")
    try:
        negative_path = Path(openwakeword.__file__).parent / "negative_data"
        if negative_path.exists():
            negative_clips = load_audio_files(negative_path)
            print(f"加载了 {len(negative_clips)} 个内置负向样本")
        else:
            negative_clips = []
    except Exception as e:
        print(f"警告: 加载内置负向数据失败: {e}")
        negative_clips = []

    # 计算负向特征
    negative_features = []
    for clip in negative_clips[:min(len(negative_clips), len(positive_clips))]:
        if len(clip) < target_len:
            clip = np.pad(clip, (0, target_len - len(clip)))
        else:
            clip = clip[:target_len]

        try:
            import librosa
            mel = librosa.feature.melspectrogram(
                y=clip, sr=16000, n_mels=96, n_fft=512, hop_length=160
            )
            mel = librosa.power_to_db(mel)
            mel = mel[:16, :96]
            if mel.shape[1] < 96:
                mel = np.pad(mel, ((0, 0), (0, 96 - mel.shape[1])))
            negative_features.append(mel)  # 形状 (16, 96)
        except Exception as e:
            continue

    X_negative = np.array(negative_features, dtype=np.float32)

    # 如果负向样本不足，生成随机噪声
    if len(X_negative) < 100:
        print("警告: 负向样本不足，使用随机噪声")
        X_negative = np.random.randn(len(positive_clips), 16, 96).astype(np.float32) * 0.1

    # 合并数据
    X_train = np.concatenate([X_positive, X_negative], axis=0)  # (N, 16, 96)
    y_train = np.hstack([np.ones(len(X_positive)), np.zeros(len(X_negative))])

    print(f"\n训练数据形状: {X_train.shape}")
    print(f"正向样本: {len(X_positive)}, 负向样本: {len(X_negative)}")

    # 验证数据
    val_size = min(100, len(X_train))
    X_val = X_train[:val_size]
    false_positive_val_data = X_negative[:min(50, len(X_negative))]

    # 训练
    print(f"\n开始训练（steps={args.steps}）...")
    try:
        model.auto_train(
            X_train=torch.from_numpy(X_train),
            X_val=torch.from_numpy(X_val),
            false_positive_val_data=torch.from_numpy(false_positive_val_data),
            steps=args.steps,
            target_fp_per_hour=0.5
        )
    except Exception as e:
        print(f"训练错误: {e}")
        # 尝试简化训练
        print("尝试简化训练流程...")
        optimizer = torch.optim.Adam(model.parameters(), lr=0.001)
        criterion = torch.nn.BCEWithLogitsLoss()

        X_tensor = torch.from_numpy(X_train).float()
        y_tensor = torch.from_numpy(y_train).float().unsqueeze(1)

        for step in range(args.steps):
            optimizer.zero_grad()
            output = model(X_tensor)
            loss = criterion(output, y_tensor)
            loss.backward()
            optimizer.step()

            if step % 1000 == 0:
                print(f"Step {step}: Loss = {loss.item():.4f}")

    # 导出模型
    print("\n导出模型...")
    safe_name = args.keyword.replace(" ", "_")
    model_name = f"{safe_name}"
    onnx_path = output_dir / f"{model_name}.onnx"

    # 使用兼容的 opset 版本 13 手动导出
    try:
        import torch
        dummy_input = torch.randn(1, 16, 96)  # 模型输入形状
        torch.onnx.export(
            model,
            dummy_input,
            str(onnx_path),
            opset_version=13,
            input_names=['input'],
            output_names=['output'],
            dynamic_axes={'input': {0: 'batch_size'}, 'output': {0: 'batch_size'}},
            export_params=True,
        )
        print(f"模型已导出到: {onnx_path}")
    except Exception as e:
        print(f"导出错误: {e}")
        # 备用方法
        try:
            model.export_model(model, model_name, str(output_dir))
        except Exception as e2:
            print(f"备用导出也失败: {e2}")

    # 创建元数据文件
    meta = {
        "keyword": args.keyword,
        "version": 1,
        "created_at": datetime.now().strftime("%Y-%m-%dT%H:%M:%SZ"),
    }
    if args.role != "wakeword":
        meta["role"] = args.role

    onnx_file = output_dir / f"{model_name}.onnx"
    if onnx_file.exists():
        meta_path = onnx_file.with_suffix(".json")
        with open(meta_path, "w", encoding="utf-8") as f:
            json.dump(meta, f, indent=2, ensure_ascii=False)

        print(f"\n训练完成!")
        print(f"模型文件: {onnx_file}")
        print(f"元数据文件: {meta_path}")
    else:
        print("\n警告: ONNX 模型文件未生成")
        print("请检查训练过程是否正确完成")


if __name__ == "__main__":
    main()