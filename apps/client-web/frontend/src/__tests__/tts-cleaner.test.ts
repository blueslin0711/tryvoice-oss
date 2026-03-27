/**
 * 10.3 TTS Cleaner tests
 */
import { describe, it, expect } from 'vitest';
import { cleanForTTS, chunkForTTS } from '../audio/tts-cleaner';

describe('cleanForTTS', () => {
  it('returns empty for falsy input', () => {
    expect(cleanForTTS('')).toBe('');
    expect(cleanForTTS(undefined as unknown as string)).toBe('');
  });

  it('removes emoji', () => {
    const result = cleanForTTS('你好😀世界🌍');
    expect(result).not.toMatch(/😀/);
    expect(result).not.toMatch(/🌍/);
    expect(result).toContain('你好');
    expect(result).toContain('世界');
  });

  it('removes code blocks', () => {
    const result = cleanForTTS('看代码：```\nconst x = 1;\n```然后继续');
    expect(result).not.toContain('const x');
    expect(result).toContain('然后继续');
  });

  it('removes inline code', () => {
    const result = cleanForTTS('使用 `npm install` 安装');
    expect(result).not.toContain('`');
    expect(result).toContain('安装');
  });

  it('removes markdown headings', () => {
    const result = cleanForTTS('## 标题\n内容');
    expect(result).not.toContain('##');
    expect(result).toContain('标题');
    expect(result).toContain('内容');
  });

  it('removes bold/italic markers', () => {
    const result = cleanForTTS('这是**粗体**和*斜体*');
    expect(result).not.toContain('*');
    expect(result).toContain('粗体');
    expect(result).toContain('斜体');
  });

  it('extracts link text', () => {
    const result = cleanForTTS('点击[这里](https://example.com)查看');
    expect(result).not.toContain('https');
    expect(result).toContain('这里');
  });

  it('removes URLs', () => {
    const result = cleanForTTS('访问 https://example.com 了解更多');
    expect(result).not.toContain('https');
  });

  it('normalizes repeated punctuation', () => {
    expect(cleanForTTS('好的！！！')).toBe('好的！');
    expect(cleanForTTS('真的？？？')).toBe('真的？');
    expect(cleanForTTS('嗯...')).toBe('嗯。');
  });

  it('converts table rows to spoken text', () => {
    const table = '| 名称 | 价格 |\n|---|---|\n| 苹果 | 5元 |';
    const result = cleanForTTS(table);
    expect(result).toContain('名称');
    expect(result).toContain('价格');
    expect(result).not.toContain('|');
  });

  it('removes strikethrough markers', () => {
    const result = cleanForTTS('~~删除线~~');
    expect(result).not.toContain('~~');
    expect(result).toContain('删除线');
  });
});

describe('chunkForTTS', () => {
  it('returns empty array for empty input', () => {
    expect(chunkForTTS('')).toEqual([]);
    expect(chunkForTTS('  ')).toEqual([]);
  });

  it('short text returns single chunk', () => {
    const result = chunkForTTS('短文本');
    expect(result).toEqual(['短文本']);
  });

  it('splits on hard breaks at minChars', () => {
    const text = 'a'.repeat(100) + '。' + 'b'.repeat(50);
    const result = chunkForTTS(text, 100, 200);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('respects maxChars with soft breaks', () => {
    const text = 'a'.repeat(200) + '，' + 'b'.repeat(50);
    const result = chunkForTTS(text, 100, 200);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });

  it('force-splits very long text', () => {
    const text = 'a'.repeat(500);
    const result = chunkForTTS(text, 100, 200);
    expect(result.length).toBeGreaterThan(1);
    // Each chunk should not exceed hardLimit (maxChars + 50 = 250)
    for (const chunk of result) {
      expect(chunk.length).toBeLessThanOrEqual(250);
    }
  });
});
