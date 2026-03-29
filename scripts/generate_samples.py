#!/usr/bin/env python3
"""生成唤醒词训练样本 - 使用 edge-tts 生成正向样本"""

import argparse
import asyncio
from pathlib import Path
import subprocess
import sys

try:
    import edge_tts
except ImportError:
    print("请先安装 edge-tts: pip install edge-tts")
    sys.exit(1)

try:
    from pydub import AudioSegment
except ImportError:
    print("请先安装 pydub: pip install pydub")
    sys.exit(1)

NEGATIVE_PHRASES = [
    "你好世界",
    "今天天气不错",
    "请问有什么可以帮助你",
    "我想了解一下",
    "麻烦帮我查一下",
    "接下来我要说的是",
    "让我们开始吧",
    "你可以重复一遍吗",
    "我听不太清楚",
    "请再说一遍",
    "好的我知道了",
    "这个很有意思",
    "我需要确认一下",
    "稍等片刻",
    "马上为你处理",
    "非常感谢你的帮助",
    "没问题我来处理",
    "这个事情很重要",
    "让我们一起来看看",
    "这是我的想法",
    # 可以添加更多不包含唤醒词的中文短语
]


async def generate_sample(text: str, output_path: Path, voice: str = "zh-CN-XiaoxiaoNeural"):
    """使用 edge-tts 生成单个样本"""
    communicate = edge_tts.Communicate(text, voice)
    raw_path = output_path.with_suffix(".raw.wav")
    await communicate.save(str(raw_path))

    # 转换为正确格式: 16kHz, 16bit, mono
    audio = AudioSegment.from_file(str(raw_path))
    audio = audio.set_frame_rate(16000).set_channels(1).set_sample_width(2)
    audio.export(str(output_path), format="wav")

    raw_path.unlink()  # 删除原始文件


async def generate_positive_samples(keyword: str, output_dir: Path, count: int, voice: str):
    """生成正向样本"""
    positive_dir = output_dir / "positive"
    positive_dir.mkdir(parents=True, exist_ok=True)

    print(f"生成 {count} 个正向样本 (关键词: {keyword})...")

    for i in range(count):
        sample_path = positive_dir / f"sample_{i}.wav"
        await generate_sample(keyword, sample_path, voice)
        if (i + 1) % 10 == 0:
            print(f"  已生成 {i + 1}/{count}")

    print(f"正向样本完成: {positive_dir}")


async def generate_negative_samples(output_dir: Path, count: int, voice: str):
    """生成负向样本"""
    negative_dir = output_dir / "negative"
    negative_dir.mkdir(parents=True, exist_ok=True)

    print(f"生成 {count} 个负向样本...")

    # 循环使用短语列表
    for i in range(count):
        phrase = NEGATIVE_PHRASES[i % len(NEGATIVE_PHRASES)]
        sample_path = negative_dir / f"neg_{i}.wav"
        await generate_sample(phrase, sample_path, voice)
        if (i + 1) % 20 == 0:
            print(f"  已生成 {i + 1}/{count}")

    print(f"负向样本完成: {negative_dir}")


async def main():
    parser = argparse.ArgumentParser(description="生成唤醒词训练样本")
    parser.add_argument("--keyword", required=True, help="唤醒词文本")
    parser.add_argument("--output-dir", default="training_samples", help="输出目录")
    parser.add_argument("--positive-count", type=int, default=50, help="正向样本数量")
    parser.add_argument("--negative-count", type=int, default=120, help="负向样本数量")
    parser.add_argument("--voice", default="zh-CN-XiaoxiaoNeural", help="TTS 语音")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)

    await generate_positive_samples(args.keyword, output_dir, args.positive_count, args.voice)
    await generate_negative_samples(output_dir, args.negative_count, args.voice)

    print("\n生成完成！下一步:")
    print(f"  docker build -f Dockerfile.train -t tryvoice-train .")
    print(f"  docker run --rm -v $(pwd):/app tryvoice-train \\")
    print(f"    --samples {output_dir}/positive \\")
    print(f"    --keyword \"{args.keyword}\" \\")
    print(f"    --negative-samples {output_dir}/negative")


if __name__ == "__main__":
    asyncio.run(main())