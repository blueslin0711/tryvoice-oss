#!/usr/bin/env python3
"""
导出 Whisper Encoder 到 ONNX 格式

用于唤醒词迁移学习架构：
- Whisper encoder 作为特征提取器（冻结权重）
- 输入: (batch, 80, 3000) log-mel spectrogram (30秒窗口)
- 输出: (batch, 1500, 384) encoder features for tiny model

注意：
- Whisper encoder 固定要求 3000 帧输入（30秒）
- 短音频需要在输入前用零填充到 3000 帧
- 输出取对应时间段的特征即可（如前 150 帧 = 3秒）

用法:
    python scripts/export_whisper_encoder.py --model tiny --output whisper_encoder.onnx
    python scripts/export_whisper_encoder.py --model base --output whisper_encoder_base.onnx
"""

import argparse
import sys
import os
from pathlib import Path

# 必须在导入 torch 之前设置，禁用 dynamo
os.environ["TORCH_DYNAMO_DISABLE"] = "1"

import torch


def main():
    parser = argparse.ArgumentParser(description="导出 Whisper Encoder 到 ONNX")
    parser.add_argument("--model", default="tiny", choices=["tiny", "base", "small"], help="Whisper 模型大小")
    parser.add_argument("--output", default="whisper_encoder.onnx", help="输出 ONNX 文件路径")
    parser.add_argument("--verify", action="store_true", help="导出后验证 ONNX 模型")
    parser.add_argument("--opset", type=int, default=12, help="ONNX opset 版本 (默认 12，兼容 ONNX Runtime Web)")
    args = parser.parse_args()

    try:
        from transformers import WhisperModel
        import onnx
    except ImportError as e:
        print(f"错误: 缺少依赖 - {e}")
        print("请安装: pip install transformers[torch] onnx")
        sys.exit(1)

    model_name = f"openai/whisper-{args.model}"
    output_path = Path(args.output)

    print(f"加载 Whisper 模型: {model_name}")
    print(f"输出路径: {output_path}")

    # 加载模型
    model = WhisperModel.from_pretrained(model_name)
    encoder = model.encoder
    encoder.eval()

    # 获取模型配置
    d_model = model.config.d_model  # tiny=384, base=512, small=768
    print(f"隐藏层维度: {d_model}")

    # Whisper 固定参数
    num_mel_bins = 80
    target_length = 3000  # 30秒

    print(f"\n导出 Encoder (3000 帧输入)...")

    # 创建 dummy input
    dummy_input = torch.randn(1, num_mel_bins, target_length)
    print(f"输入形状: (1, {num_mel_bins}, {target_length})")

    # 导出 ONNX - 固定形状，不使用动态轴
    # 原因：PyTorch 2.5+ 的导出器与动态轴有兼容性问题
    # 唤醒词场景通常处理单个音频样本，固定 batch=1 足够
    # 使用较低的 opset 版本 (12) 以兼容 ONNX Runtime Web
    torch.onnx.export(
        encoder,
        dummy_input,
        str(output_path),
        input_names=["input_features"],
        output_names=["last_hidden_state"],
        opset_version=args.opset,
        do_constant_folding=True,
    )

    print(f"导出完成: {output_path}")

    # 验证 ONNX 模型
    print("\n验证 ONNX 模型结构...")
    onnx_model = onnx.load(str(output_path))
    onnx.checker.check_model(onnx_model)

    # 打印模型信息
    inp = onnx_model.graph.input[0]
    out = onnx_model.graph.output[0]

    print(f"IR 版本: {onnx_model.ir_version}")
    print(f"Opset: {[o.version for o in onnx_model.opset_import]}")

    inp_dims = [d.dim_value if d.dim_value else d.dim_param for d in inp.type.tensor_type.shape.dim]
    out_dims = [d.dim_value if d.dim_value else d.dim_param for d in out.type.tensor_type.shape.dim]

    print(f"输入: {inp.name}, 形状: {inp_dims}")
    print(f"输出: {out.name}, 形状: {out_dims}")
    print(f"  注意: 输出时间帧 = 输入时间帧 / 2 (Whisper 下采样)")

    # 检查模型大小
    size_mb = output_path.stat().st_size / (1024 * 1024)
    print(f"文件大小: {size_mb:.1f} MB")

    # 运行推理验证
    if args.verify:
        try:
            import onnxruntime as ort
            import numpy as np

            print("\n运行推理验证...")
            session = ort.InferenceSession(str(output_path))
            ort_input = session.get_inputs()[0]
            ort_output = session.get_outputs()[0]

            # 测试输入 (固定 3000 帧, batch=1)
            np_input = np.random.randn(1, num_mel_bins, target_length).astype(np.float32)
            torch_input = torch.from_numpy(np_input)

            # PyTorch 推理
            with torch.no_grad():
                pytorch_out = encoder(torch_input).last_hidden_state.numpy()

            # ONNX 推理
            onnx_out = session.run([ort_output.name], {ort_input.name: np_input})[0]

            # 比较
            max_diff = np.abs(pytorch_out - onnx_out).max()
            mean_diff = np.abs(pytorch_out - onnx_out).mean()
            print(f"PyTorch 输出形状: {pytorch_out.shape}")
            print(f"ONNX 输出形状: {onnx_out.shape}")
            print(f"最大差异: {max_diff:.6f}")
            print(f"平均差异: {mean_diff:.6f}")

            if max_diff < 1e-3:
                print("✓ 验证成功! ONNX 输出与 PyTorch 一致")
            else:
                print("⚠ 警告: 输出差异较大")
        except ImportError:
            print("跳过推理验证 (需要 onnxruntime)")

    # 输出模型参数统计
    print("\n模型参数:")
    total_params = sum(p.numel() for p in encoder.parameters())
    print(f"总参数量: {total_params:,}")

    # 使用说明
    print("\n使用说明:")
    print("  输入要求: (batch, 80, 3000) log-mel 特征")
    print("  短音频处理: 填充到 3000 帧，取输出前 N/2 帧")
    print("  例如: 3秒音频 (300帧) → 填充到 3000 → 输出取前 150 帧")

    return 0


if __name__ == "__main__":
    sys.exit(main())