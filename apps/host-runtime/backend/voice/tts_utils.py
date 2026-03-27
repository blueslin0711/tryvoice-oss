"""TTS text cleaning utilities (generic, no vendor dependency)."""

from __future__ import annotations

import re


def clean_for_tts(text: str) -> str:
    """Clean text for TTS reading. Display text is unaffected."""
    if not text:
        return text

    # --- 1. Remove emoji (library + fallback regex) ---
    try:
        import emoji as _emoji_mod

        text = _emoji_mod.replace_emoji(text, replace="")
    except ImportError:
        # Fallback: broad Unicode emoji ranges
        text = re.sub(
            r"[\U0001F600-\U0001F64F\U0001F300-\U0001F5FF\U0001F680-\U0001F6FF"
            r"\U0001F900-\U0001F9FF\U0001FA00-\U0001FA6F\U0001FA70-\U0001FAFF"
            r"\U00002702-\U000027B0\U0000FE00-\U0000FE0F\U00002600-\U000026FF"
            r"\U0000200D\U00002B50\U00002B55\U0000231A-\U0000231B"
            r"\U000023E9-\U000023F3\U000023F8-\U000023FA"
            r"\U00002934-\U00002935\U000025AA-\U000025AB\U000025B6\U000025C0"
            r"\U000025FB-\U000025FE\U00003030\U0000303D\U00003297\U00003299]+",
            "",
            text,
        )
    # Country flag emojis
    text = re.sub(r"[\U0001F1E0-\U0001F1FF]{2}", "", text)
    # Variation selectors / zero-width joiners that may linger
    text = re.sub(r"[\uFE0E\uFE0F\u200D\u20E3]", "", text)

    # --- 2. Remove Markdown formatting ---
    text = re.sub(r"```[\s\S]*?```", "", text)  # code blocks
    text = re.sub(r"`[^`]+`", "", text)  # inline code
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)  # headings
    text = re.sub(r"\*{1,3}([^*]+)\*{1,3}", r"\1", text)  # bold/italic
    text = re.sub(r"_{1,2}([^_]+)_{1,2}", r"\1", text)  # underscore bold/italic
    text = re.sub(r"~~([^~]+)~~", r"\1", text)  # strikethrough
    text = re.sub(r"\[([^\]]+)\]\([^)]*\)", r"\1", text)  # markdown links (before URL strip)
    text = re.sub(r"https?://\S+", "", text)  # URLs
    text = re.sub(r"^MEDIA:.*$", "", text, flags=re.MULTILINE)
    text = re.sub(r"^[-=*]{3,}\s*$", "", text, flags=re.MULTILINE)  # hr
    text = re.sub(r"^\s*[-*\u2022]\s+", "", text, flags=re.MULTILINE)  # unordered list
    text = re.sub(r"^\s*\d+\.\s+", "", text, flags=re.MULTILINE)  # ordered list
    text = re.sub(r"^>\s?", "", text, flags=re.MULTILINE)  # blockquote

    # --- 3. Markdown tables -> spoken text ---
    text = re.sub(r"^\|[-:\s|]+\|\s*$", "", text, flags=re.MULTILINE)

    def _table_row_to_text(match: re.Match) -> str:
        row = match.group(0)
        cells = [c.strip() for c in row.strip().strip("|").split("|")]
        cells = [c for c in cells if c and c not in ("---", ":---:", "---:", ":---")]
        return "\uff0c".join(cells) if cells else ""

    text = re.sub(r"^\|.+\|$", _table_row_to_text, text, flags=re.MULTILINE)

    # --- 4. Clean punctuation for natural speech ---
    text = re.sub(r"[\uff5e~]{2,}", "\uff5e", text)
    text = re.sub(r"[\uff01!]{2,}", "\uff01", text)
    text = re.sub(r"[\uff1f?]{2,}", "\uff1f", text)
    text = re.sub(r"[\u3002]{2,}", "\u3002", text)
    text = re.sub(r"\.{3,}", "\u3002", text)  # ... -> .
    text = re.sub(r"\u2026+", "\u3002", text)  # ... -> .

    # --- 5. Final whitespace cleanup ---
    text = re.sub(r"\n{3,}", "\n\n", text)
    text = re.sub(r"  +", " ", text)
    return text.strip()


def _preview_text(text: str, max_len: int = 120) -> str:
    one_line = re.sub(r"\s+", " ", (text or "").strip())
    return one_line[:max_len]
