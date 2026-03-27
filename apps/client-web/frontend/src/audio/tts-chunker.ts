/**
 * Split text into stream-friendly chunks for TTS synthesis.
 * Mirrors backend _chunk_for_stream (turn_executor.py).
 *
 * All punctuation is treated as a soft break — a chunk is only flushed
 * when the buffer has accumulated at least `minChars` characters AND
 * the current character is a break character.  Segments that exceed
 * `hardLimit` without encountering any break are force-split.
 */
export function chunkForTTS(text: string, minChars = 60, hardLimit = 200): string[] {
  const src = (text || '').trim();
  if (!src) return [];

  const softBreaks = new Set([
    '\n', '\u3002', '\uff01', '\uff1f', '!', '?', '\uff1b', ';',
    ',', '\uff0c', '\u3001', ' ',
  ]);

  const chunks: string[] = [];
  const buf: string[] = [];

  for (const ch of src) {
    buf.push(ch);
    if (buf.length >= minChars && softBreaks.has(ch)) {
      const seg = buf.join('').trim();
      if (seg) chunks.push(seg);
      buf.length = 0;
    }
  }
  if (buf.length) {
    const seg = buf.join('').trim();
    if (seg) chunks.push(seg);
  }

  // Force-split segments that exceed the hard limit.
  const out: string[] = [];
  for (const seg of chunks) {
    if (seg.length <= hardLimit) {
      out.push(seg);
      continue;
    }
    for (let i = 0; i < seg.length; i += hardLimit) {
      const part = seg.slice(i, i + hardLimit).trim();
      if (part) out.push(part);
    }
  }

  // Merge tiny trailing fragments to avoid choppy playback.
  const merged: string[] = [];
  for (const seg of out) {
    if (merged.length && seg.length <= 3) {
      merged[merged.length - 1] += seg;
    } else {
      merged.push(seg);
    }
  }
  return merged;
}
