/**
 * ChunkedTranscriptionSession tests
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createChunkedTranscriptionSession } from '../recording/recording-utils';

const mockTranscribe = vi.fn<(blob: Blob, lang: string) => Promise<string>>();

beforeEach(() => {
  mockTranscribe.mockReset();
});

describe('ChunkedTranscriptionSession', () => {
  it('returns null when no chunks submitted', async () => {
    const session = createChunkedTranscriptionSession('zh', mockTranscribe);
    expect(session.hasChunks).toBe(false);
    expect(await session.finalize()).toBeNull();
  });

  it('concatenates successful transcriptions in order', async () => {
    mockTranscribe
      .mockResolvedValueOnce('hello')
      .mockResolvedValueOnce('world')
      .mockResolvedValueOnce('test');

    const session = createChunkedTranscriptionSession('zh', mockTranscribe);
    session.submitChunk(new Blob(['a']));
    session.submitChunk(new Blob(['b']));
    session.submitChunk(new Blob(['c']));

    expect(session.hasChunks).toBe(true);
    const result = await session.finalize();
    expect(mockTranscribe).toHaveBeenCalledTimes(3);
    expect(result).toBe('hello world test');
  });

  it('tolerates partial failures', async () => {
    mockTranscribe
      .mockResolvedValueOnce('first')
      .mockRejectedValueOnce(new Error('network error'))
      .mockResolvedValueOnce('third');

    const session = createChunkedTranscriptionSession('zh', mockTranscribe);
    session.submitChunk(new Blob(['a']));
    session.submitChunk(new Blob(['b']));
    session.submitChunk(new Blob(['c']));

    const result = await session.finalize();
    expect(result).toBe('first third');
  });

  it('returns null when ALL chunks fail', async () => {
    mockTranscribe
      .mockRejectedValueOnce(new Error('fail1'))
      .mockRejectedValueOnce(new Error('fail2'));

    const session = createChunkedTranscriptionSession('zh', mockTranscribe);
    session.submitChunk(new Blob(['a']));
    session.submitChunk(new Blob(['b']));

    const result = await session.finalize();
    expect(result).toBeNull();
  });

  it('returns null when all transcriptions return empty string', async () => {
    mockTranscribe
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('');

    const session = createChunkedTranscriptionSession('zh', mockTranscribe);
    session.submitChunk(new Blob(['a']));
    session.submitChunk(new Blob(['b']));

    const result = await session.finalize();
    expect(result).toBeNull();
  });

  it('cancel discards all results', async () => {
    mockTranscribe.mockResolvedValue('should not appear');

    const session = createChunkedTranscriptionSession('zh', mockTranscribe);
    session.submitChunk(new Blob(['a']));
    session.cancel();

    expect(await session.finalize()).toBeNull();
    // After cancel, submitChunk is a no-op
    session.submitChunk(new Blob(['b']));
    expect(mockTranscribe).toHaveBeenCalledTimes(1); // only the pre-cancel call
  });

  it('passes sttLang to transcribe', async () => {
    mockTranscribe.mockResolvedValueOnce('ok');

    const session = createChunkedTranscriptionSession('en', mockTranscribe);
    session.submitChunk(new Blob(['a']));
    await session.finalize();

    expect(mockTranscribe).toHaveBeenCalledWith(expect.any(Blob), 'en');
  });
});
