// Clean text for TTS reading — port of tts-cleaner.js

const EMOJI_RE = /\p{Extended_Pictographic}/gu;
const FLAG_RE = /\p{Regional_Indicator}{2}/gu;
const VARIATION_RE = /[\uFE0E\uFE0F\u20E3]|\u200D/g;

export function cleanForTTS(text: string): string {
  if (!text) return '';

  // 1. Remove emoji
  text = text.replace(EMOJI_RE, '');
  text = text.replace(FLAG_RE, '');
  text = text.replace(VARIATION_RE, '');

  // 2. Remove Markdown formatting
  text = text.replace(/```[\s\S]*?```/g, '');
  text = text.replace(/`[^`]+`/g, '');
  text = text.replace(/^#{1,6}\s+/gm, '');
  text = text.replace(/\*{1,3}([^*]+)\*{1,3}/g, '$1');
  text = text.replace(/_{1,2}([^_]+)_{1,2}/g, '$1');
  text = text.replace(/~~([^~]+)~~/g, '$1');
  text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1');
  text = text.replace(/https?:\/\/\S+/g, '');
  text = text.replace(/^MEDIA:.*$/gm, '');
  text = text.replace(/^[-=*]{3,}\s*$/gm, '');
  text = text.replace(/^\s*[-*•]\s+/gm, '');
  text = text.replace(/^\s*\d+\.\s+/gm, '');
  text = text.replace(/^>\s?/gm, '');

  // 3. Markdown tables → spoken text
  text = text.replace(/^\|[-:\s|]+\|\s*$/gm, '');
  text = text.replace(/^\|.+\|$/gm, (row) => {
    const cells = row.trim().replace(/^\||\|$/g, '').split('|')
      .map(c => c.trim())
      .filter(c => c && !/^[-:]+$/.test(c));
    return cells.length ? cells.join('，') : '';
  });

  // 4. Clean punctuation for natural speech
  text = text.replace(/[～~]{2,}/g, '～');
  text = text.replace(/[！!]{2,}/g, '！');
  text = text.replace(/[？?]{2,}/g, '？');
  text = text.replace(/[。]{2,}/g, '。');
  text = text.replace(/\.{3,}/g, '。');
  text = text.replace(/…+/g, '。');

  // 5. Final whitespace cleanup
  text = text.replace(/\n{3,}/g, '\n\n');
  text = text.replace(/  +/g, ' ');

  return text.trim();
}

// Split text into TTS-friendly chunks
export function chunkForTTS(text: string, minChars = 100, maxChars = 200): string[] {
  const src = (text || '').trim();
  if (!src) return [];
  const hardBreaks = new Set(['\n', '。', '！', '？', '!', '?', '；', ';']);
  const softBreaks = new Set([',', '，', '、', ' ', ':', '：']);
  const chunks: string[] = [];
  let buf: string[] = [];
  for (const ch of src) {
    buf.push(ch);
    if (buf.length >= minChars && hardBreaks.has(ch)) {
      const seg = buf.join('').trim();
      if (seg) chunks.push(seg);
      buf = [];
      continue;
    }
    if (buf.length >= maxChars && (softBreaks.has(ch) || hardBreaks.has(ch))) {
      const seg = buf.join('').trim();
      if (seg) chunks.push(seg);
      buf = [];
    }
  }
  if (buf.length) { const seg = buf.join('').trim(); if (seg) chunks.push(seg); }
  const hardLimit = maxChars + 50;
  const out: string[] = [];
  for (const seg of chunks) {
    if (seg.length <= hardLimit) { out.push(seg); continue; }
    for (let i = 0; i < seg.length; i += hardLimit) {
      const part = seg.slice(i, i + hardLimit).trim();
      if (part) out.push(part);
    }
  }
  const merged: string[] = [];
  for (const seg of out) {
    if (merged.length && seg.length <= 5) merged[merged.length - 1] += seg;
    else merged.push(seg);
  }
  return merged;
}
