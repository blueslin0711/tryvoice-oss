"""Voice configuration — STT and TTS settings."""

import os

# ---- Provider selection ----
STT_PROVIDER = os.getenv("TRYVOICE_STT_PROVIDER", "groq").strip() or "groq"
TTS_PROVIDER = os.getenv("TRYVOICE_TTS_PROVIDER", "edge").strip() or "edge"

# ---- STT ----
GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_WHISPER_MODEL = os.getenv("GROQ_WHISPER_MODEL", "whisper-large-v3-turbo")

# ---- TTS ----
EDGE_VOICE = os.getenv("EDGE_TTS_VOICE", "zh-CN-XiaoxiaoNeural")

# ---- Azure Speech (browser-direct TTS) ----
AZURE_SPEECH_KEY = os.getenv("AZURE_SPEECH_KEY", "")
AZURE_SPEECH_REGION = os.getenv("AZURE_SPEECH_REGION", "eastus")
