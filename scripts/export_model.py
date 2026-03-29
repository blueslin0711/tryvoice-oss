#!/usr/bin/env python3
"""在 Docker 中导出 ONNX 模型"""
import sys
import torch
import torch.nn as nn
import onnx
from pathlib import Path

class WakeWordModel(nn.Module):
    def __init__(self):
        super().__init__()
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

if __name__ == "__main__":
    if len(sys.argv) < 4:
        print("用法: python export_model.py <weights.pt> <keyword> <output_dir>")
        sys.exit(1)

    weights_path = sys.argv[1]
    keyword = sys.argv[2]
    output_dir = Path(sys.argv[3])

    # 加载权重
    model = WakeWordModel()
    model.load_state_dict(torch.load(weights_path, map_location='cpu'))
    model.eval()

    # 导出 ONNX
    safe_name = keyword.replace(" ", "_")
    onnx_path = output_dir / f"{safe_name}.onnx"

    dummy_input = torch.randn(1, 16, 96)

    torch.onnx.export(
        model,
        dummy_input,
        str(onnx_path),
        opset_version=13,
        input_names=['input'],
        output_names=['output'],
        dynamic_axes={'input': {0: 'batch'}, 'output': {0: 'batch'}},
    )

    # 验证
    onnx_model = onnx.load(str(onnx_path))
    onnx.checker.check_model(onnx_model)
    print(f"导出成功: {onnx_path}")
    print(f"IR={onnx_model.ir_version}, opset={[o.version for o in onnx_model.opset_import]}")