#!/usr/bin/env python3
"""
验证 Whisper Encoder ONNX 导出正确性

对比 PyTorch 原始模型和 ONNX 模型的输出一致性。

用法:
    python scripts/verify_whisper_onnx.py --encoder whisper_encoder.onnx
    python scripts/verify_whisper_onnx.py --encoder whisper_encoder.onnx --model tiny
"""

import argparse
import sys
import numpy as np
from pathlib import Path

def main():
    parser = argparse.ArgumentParser(description="验证 Whisper Encoder ONNX 导出")
    parser.add_argument("--encoder", required=True, help="ONNX encoder 文件路径")
    parser.add_argument("--model", default="tiny", choices=["tiny", "base", "small"], help="原始 Whisper 模型大小")
    parser.add_argument("--tolerance", type=float, default=1e-3, help="输出差异容差")
    parser.add_argument("--samples", type=int, default=5, help="测试样本数量")
    args = parser.parse_args()

    try:
        import torch
        from transformers import WhisperModel
        import onnxruntime as ort
    except ImportError as e:
        print(f"错误: 缺少依赖 - {e}")
        print("请安装: pip install transformers[torch] onnxruntime")
        sys.exit(1)

    encoder_path = Path(args.encoder)
    if not encoder_path.exists():
        print(f"错误: 文件不存在 - {encoder_path}")
        sys.exit(1)

    print(f"验证 ONNX Encoder: {encoder_path}")
    print(f"原始模型: openai/whisper-{args.model}")
    print(f"容差: {args.tolerance}")

    # 加载 PyTorch 模型
    print("\n加载 PyTorch 模型...")
    model_name = f"openai/whisper-{args.model}"
    pytorch_model = WhisperModel.from_pretrained(model_name)
    pytorch_encoder = pytorch_model.encoder
    pytorch_encoder.eval()

    # 加载 ONNX 模型
    print("加载 ONNX 模型...")
    onnx_session = ort.InferenceSession(str(encoder_path))

    # 获取输入输出信息
    onnx_input = onnx_session.get_inputs()[0]
    onnx_output = onnx_session.get_outputs()[0]
    print(f"ONNX 输入: {onnx_input.name}, 形状: {onnx_input.shape}")
    print(f"ONNX 输出: {onnx_output.name}, 形状: {onnx_output.shape}")

    # 测试不同输入形状
    test_cases = [
        (1, 80, 300),    # 3秒音频 (唤醒词典型长度)
        (1, 80, 3000),   # 30秒音频 (Whisper 原始长度)
        (2, 80, 300),    # batch=2
        (4, 80, 1500),   # batch=4, 15秒
    ]

    all_passed = True

    for batch, mel_bins, time_frames in test_cases:
        print(f"\n测试输入形状: (batch={batch}, mel_bins={mel_bins}, time={time_frames})")

        # 生成随机输入
        np_input = np.random.randn(batch, mel_bins, time_frames).astype(np.float32)
        torch_input = torch.from_numpy(np_input)

        # PyTorch 推理
        with torch.no_grad():
            pytorch_output = pytorch_encoder(torch_input)
            pytorch_output_np = pytorch_output.last_hidden_state.numpy()

        # ONNX 推理
        onnx_output_np = onnx_session.run(
            [onnx_output.name],
            {onnx_input.name: np_input}
        )[0]

        # 比较输出
        max_diff = np.abs(pytorch_output_np - onnx_output_np).max()
        mean_diff = np.abs(pytorch_output_np - onnx_output_np).mean()

        print(f"  PyTorch 输出形状: {pytorch_output_np.shape}")
        print(f"  ONNX 输出形状: {onnx_output_np.shape}")
        print(f"  最大差异: {max_diff:.6f}")
        print(f"  平均差异: {mean_diff:.6f}")

        passed = max_diff < args.tolerance
        status = "✓ 通过" if passed else "✗ 失败"
        print(f"  结果: {status}")

        if not passed:
            all_passed = False

    # 多次随机测试
    print(f"\n进行 {args.samples} 次随机测试...")
    for i in range(args.samples):
        batch = np.random.randint(1, 5)
        time_frames = np.random.randint(100, 3001)
        np_input = np.random.randn(batch, 80, time_frames).astype(np.float32)
        torch_input = torch.from_numpy(np_input)

        with torch.no_grad():
            pytorch_output = pytorch_encoder(torch_input).last_hidden_state.numpy()

        onnx_output = onnx_session.run(
            [onnx_output.name],
            {onnx_input.name: np_input}
        )[0]

        max_diff = np.abs(pytorch_output - onnx_output).max()
        passed = max_diff < args.tolerance
        status = "✓" if passed else "✗"
        print(f"  测试 {i+1}: batch={batch}, time={time_frames}, diff={max_diff:.6f} {status}")

        if not passed:
            all_passed = False

    # 总结
    print("\n" + "="*50)
    if all_passed:
        print("验证成功! ONNX 模型输出与 PyTorch 一致")
        return 0
    else:
        print("验证失败! 存在输出差异超出容差")
        return 1


if __name__ == "__main__":
    sys.exit(main())