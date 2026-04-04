#!/usr/bin/env python3
"""
生成唤醒词训练样本 - 混合策略

策略：
1. 检查人工正向样本数量
2. 如果不足 target_positive (默认100)，用 TTS 补充
3. 生成 target_negative (默认500) 个负向样本
"""

import argparse
import asyncio
from pathlib import Path
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
    # 日常对话短语 (不包含唤醒词)
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
    # 更多短语
    "明天见",
    "下午好",
    "晚上好",
    "早上好",
    "再见",
    "谢谢",
    "不客气",
    "没关系",
    "对不起",
    "不好意思",
    "请问一下",
    "我想问个问题",
    "能帮我吗",
    "好的没问题",
    "我知道了",
    "明白了",
    "清楚了吗",
    "还有什么",
    "继续说",
    "停一下",
    "等一下",
    "稍等",
    "马上来",
    "正在处理",
    "已经完成",
    "还没开始",
    "正在进行",
    "马上就好",
    "很快完成",
    "需要时间",
    "请耐心等待",
    # 易混淆短语 (中文常见词)
    "大橘",
    "橘子",
    "大橘子",
    "小橘子",
    "橘橘",
    "橘子皮",
    "橙子",
    "橙",
    "小橙",
    "苹果",
    "香蕉",
    "西瓜",
    "草莓",
    "葡萄",
    "梨子",
    # 更多混淆词
    "你好吗",
    "在吗",
    "听到了",
    "听到了吗",
    "在不在",
    "有人吗",
    "谁呀",
    "什么事",
    "干嘛",
    "做什么",
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

    raw_path.unlink()


def count_wav_files(directory: Path) -> int:
    """统计目录中的 WAV 文件数量"""
    if not directory.exists():
        return 0
    return len([f for f in directory.iterdir() if f.suffix.lower() == ".wav"])


async def generate_tts_samples(keyword: str, output_dir: Path, count: int, voice: str, prefix: str = "tts"):
    """用 TTS 生成样本"""
    output_dir.mkdir(parents=True, exist_ok=True)

    # 使用不同语速和音调增加多样性
    rates = ["-0%", "-10%", "-20%", "+0%", "+10%", "+20%"]
    pitches = ["-0Hz", "-10Hz", "-20Hz", "+0Hz", "+10Hz", "+20Hz"]

    print(f"用 TTS 生成 {count} 个正向样本...")

    for i in range(count):
        # 随机选择语速和音调组合
        rate_idx = i % len(rates)
        pitch_idx = (i // len(rates)) % len(pitches)

        sample_path = output_dir / f"{prefix}_{i}.wav"

        # 创建带语速音调的 communicate
        communicate = edge_tts.Communicate(
            keyword,
            voice,
            rate=rates[rate_idx],
            pitch=pitches[pitch_idx]
        )

        raw_path = sample_path.with_suffix(".raw.wav")
        await communicate.save(str(raw_path))

        # 转换格式
        audio = AudioSegment.from_file(str(raw_path))
        audio = audio.set_frame_rate(16000).set_channels(1).set_sample_width(2)
        audio.export(str(sample_path), format="wav")

        raw_path.unlink()

        if (i + 1) % 20 == 0:
            print(f"  已生成 {i + 1}/{count}")

    print(f"TTS 样本完成: {output_dir}")


async def generate_negative_samples(output_dir: Path, count: int, voice: str):
    """生成负向样本 - 使用多种语音变化增加多样性"""
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"生成 {count} 个负向样本...")

    # 使用不同的语速音调组合
    rates = ["-0%", "-15%", "-30%", "+0%", "+15%", "+30%"]
    pitches = ["-0Hz", "-15Hz", "-30Hz", "+0Hz", "+15Hz", "+30Hz"]

    # 添加更多中文语音选项
    voices = [
        "zh-CN-XiaoxiaoNeural",  # 女声，活泼
        "zh-CN-YunxiNeural",     # 男声，年轻
        "zh-CN-YunyangNeural",   # 男声，新闻播报
        "zh-CN-XiaoyiNeural",    # 女声，温柔
        "zh-CN-YunjianNeural",   # 男声，激情
    ]

    for i in range(count):
        phrase = NEGATIVE_PHRASES[i % len(NEGATIVE_PHRASES)]

        # 组合变化
        rate_idx = i % len(rates)
        pitch_idx = (i // len(rates)) % len(pitches)
        voice_idx = (i // (len(rates) * len(pitches))) % len(voices)

        sample_path = output_dir / f"neg_{i}.wav"

        communicate = edge_tts.Communicate(
            phrase,
            voices[voice_idx],
            rate=rates[rate_idx],
            pitch=pitches[pitch_idx]
        )

        raw_path = sample_path.with_suffix(".raw.wav")
        await communicate.save(str(raw_path))

        audio = AudioSegment.from_file(str(raw_path))
        audio = audio.set_frame_rate(16000).set_channels(1).set_sample_width(2)
        audio.export(str(sample_path), format="wav")

        raw_path.unlink()

        if (i + 1) % 50 == 0:
            print(f"  已生成 {i + 1}/{count}")

    print(f"负向样本完成: {output_dir}")


async def main():
    parser = argparse.ArgumentParser(description="混合策略生成唤醒词训练样本")
    parser.add_argument("--keyword", required=True, help="唤醒词文本")
    parser.add_argument("--human-samples", default="", help="人工正向样本目录")
    parser.add_argument("--output-dir", default="training_samples", help="输出目录")
    parser.add_argument("--target-positive", type=int, default=100, help="目标正向样本数量")
    parser.add_argument("--target-negative", type=int, default=500, help="目标负向样本数量")
    parser.add_argument("--voice", default="zh-CN-XiaoxiaoNeural", help="TTS 语音")
    parser.add_argument("--skip-negative", action="store_true", help="跳过负向样本生成")
    args = parser.parse_args()

    output_dir = Path(args.output_dir)
    keyword = args.keyword

    # 统计人工样本
    human_dir = Path(args.human_samples) if args.human_samples else None
    human_count = count_wav_files(human_dir) if human_dir else 0

    print(f"\n=== 样本生成策略 ===")
    print(f"唤醒词: {keyword}")
    print(f"人工样本: {human_count}")
    print(f"目标正向: {args.target_positive}")
    print(f"目标负向: {args.target_negative}")

    # 复制人工样本到 positive 目录
    positive_dir = output_dir / "positive"
    positive_dir.mkdir(parents=True, exist_ok=True)

    if human_dir and human_count > 0:
        print(f"\n复制 {human_count} 个人工样本...")
        import shutil
        for f in sorted(human_dir.iterdir()):
            if f.suffix.lower() == ".wav":
                dest = positive_dir / f"human_{f.name}"
                shutil.copy(f, dest)

    # 计算需要 TTS 补充的数量
    tts_needed = args.target_positive - human_count

    if tts_needed > 0:
        print(f"\n需要 TTS 补充 {tts_needed} 个正向样本...")
        await generate_tts_samples(keyword, positive_dir, tts_needed, args.voice, prefix="tts")
    else:
        print(f"\n人工样本已达到目标，无需 TTS 补充")

    # 统计最终正向样本数量
    final_positive = count_wav_files(positive_dir)
    print(f"\n最终正向样本: {final_positive}")

    # 生成负向样本
    if not args.skip_negative:
        negative_dir = output_dir / "negative"
        await generate_negative_samples(negative_dir, args.target_negative, args.voice)

    print(f"\n=== 生成完成 ===")
    print(f"正向样本目录: {positive_dir} ({final_positive} 个)")
    if not args.skip_negative:
        print(f"负向样本目录: {output_dir / 'negative'} ({args.target_negative} 个)")

    print(f"\n下一步训练命令:")
    print(f"  docker build -f Dockerfile.train -t tryvoice-train .")
    print(f"  docker run --rm -v $(pwd):/app tryvoice-train \\")
    print(f"    --samples {positive_dir} \\")
    print(f"    --keyword \"{keyword}\" \\")
    print(f"    --negative-samples {output_dir / 'negative'} \\")
    print(f"    --steps 20000")


if __name__ == "__main__":
    asyncio.run(main())