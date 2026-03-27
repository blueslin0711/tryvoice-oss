"""
WebSocket transport-layer helpers.

Contains STT variant tables, end-word trimming, echo detection, and text
preview utilities used by ``ws/handler.py``.

The core turn-processing logic (``process_bot_message``) has been moved
to ``backend.session.turn_executor``.
"""

from __future__ import annotations

import difflib
import json
import re
from pathlib import Path

from loguru import logger

# Re-export set_runtime_adapter so callers that still reference
# ``ws.processing.set_runtime_adapter`` keep working during transition.
from backend.session.turn_executor import set_runtime_adapter  # noqa: F401

# ============================================================
# Constants
# ============================================================

# STT misheard variants — loaded from external JSON so new keywords can be
# added without code changes.  The file is re-read when its mtime changes.
_STT_VARIANTS_PATH = Path(__file__).resolve().parent.parent / "wakeword" / "stt_variants.json"
_stt_variants_cache: dict[str, list[str]] = {}
_stt_variants_mtime: float = 0.0


def _load_stt_variants() -> dict[str, list[str]]:
    """Return the STT variants dict, reloading from disk when the file changes."""
    global _stt_variants_cache, _stt_variants_mtime
    try:
        mt = _STT_VARIANTS_PATH.stat().st_mtime
    except OSError:
        return _stt_variants_cache
    if mt != _stt_variants_mtime:
        try:
            with open(_STT_VARIANTS_PATH, "r", encoding="utf-8") as f:
                raw = json.load(f)
            _stt_variants_cache = {k: v for k, v in raw.items() if isinstance(v, list) and not k.startswith("_")}
            _stt_variants_mtime = mt
            logger.bind(component="ws.processing").info("Reloaded STT variants ({} keywords)", len(_stt_variants_cache))
        except Exception as exc:
            logger.bind(component="ws.processing").warning("Failed to load {}: {}", _STT_VARIANTS_PATH, exc)
    return _stt_variants_cache


# ============================================================
# Helper functions
# ============================================================


def _trim_endword(text: str, ew: str) -> str:
    """Remove the end-word from the tail of an STT transcript.

    Two strategies:
    * Chinese end words - char-by-char regex with optional spaces / particles.
    * English (ASCII) end words (PV presets) - known-variant match (case-
      insensitive) then fuzzy SequenceMatcher fallback so STT mis-spellings
      like "Peak Voice" still match "Picovoice".
    """
    t = (text or "").rstrip()
    ew = (ew or "").strip()
    if not ew or not t:
        return t
    if len(t) < 6:
        return t

    is_english = ew.isascii()
    tail_window = 30 if is_english else 24
    tail = t[-tail_window:]

    if is_english:
        ew_lower = ew.lower()

        # 1. Build candidate strings (original + known variants)
        candidates = [ew_lower]
        candidates.extend(_load_stt_variants().get(ew_lower, []))

        # 2. Exact / variant regex match (case-insensitive)
        for cand in candidates:
            pat = re.escape(cand) + r"[\s.,!?\u3002\uff01\uff1f\uff0c\u3001]*$"
            m = re.search(pat, tail, re.IGNORECASE)
            if m:
                cut_at = len(t) - len(tail) + m.start()
                return t[:cut_at].rstrip()

        # 3. Fuzzy fallback - compare last 1-3 words to end word.
        tail_clean = re.sub(r"[\s.,!?\u3002\uff01\uff1f\uff0c\u3001]+$", "", tail)
        words = tail_clean.split()
        ew_norm = re.sub(r"\s+", "", ew_lower)  # "Pico Voice" -> "picovoice"

        for n in range(min(3, len(words)), 0, -1):
            chunk_words = words[-n:]
            chunk_norm = re.sub(r"\s+", "", "".join(chunk_words).lower())
            if not chunk_norm:
                continue
            # First char must match (phonetic guard against false positives)
            if chunk_norm[0] != ew_norm[0]:
                continue
            # Length ratio guard
            len_ratio = len(chunk_norm) / len(ew_norm)
            if not (0.7 <= len_ratio <= 1.4):
                continue
            ratio = difflib.SequenceMatcher(None, chunk_norm, ew_norm).ratio()
            if ratio >= 0.7:
                first_word = chunk_words[0]
                hits = list(re.finditer(re.escape(first_word), tail, re.IGNORECASE))
                if hits:
                    pos = hits[-1].start()
                    cut_at = len(t) - len(tail) + pos
                    logger.debug(f"Fuzzy endword match: {chunk_words!r} \u2248 '{ew}' (ratio={ratio:.2f})")
                    return t[:cut_at].rstrip()
        return t

    # --- Chinese end word: char-by-char with optional spaces ---
    chars = [re.escape(ch) for ch in ew]
    core = r"\s*".join(chars)
    suffix = r"(?:\s*[\u554a\u5440\u5427\u5462\u561b\u5566\u54c8]*\s*[\u3002\uff01\uff1f!,\uff0c\u3001]*)?\s*$"
    pattern = core + suffix

    patterns = [pattern]
    if ew.startswith("\u6211\u8bf4") and len(ew) > 2:
        ew2 = ew[2:]
        chars2 = [re.escape(ch) for ch in ew2]
        patterns.append(r"\s*".join(chars2) + suffix)

    for p in patterns:
        m = re.search(p, tail)
        if m:
            cut_at = len(t) - len(tail) + m.start()
            return t[:cut_at].rstrip()
    return t


def _normalize_loop_text(text: str) -> str:
    t = (text or "").lower()
    t = re.sub(r"^\[\u8bed\u97f3\u6d88\u606f[^\]]*\]\s*", "", t)
    t = re.sub(r"\s+", "", t)
    t = re.sub(
        r"[`*_#>\-\[\]\(\)\"'\u201c\u201d\u2018\u2019\u3002\uff0c\u3001\uff01\uff1f!?,.\uff1a\uff1b;~\uff5e]+",
        "",
        t,
    )
    return t
