// Browser-direct Groq Whisper STT — port of browser-stt.js

import { createLogger } from '../logging/logger';
import { STORAGE_KEY } from '../core/types';

const log = createLogger('audio.stt');

let _apiKey: string | null = null;
let _model = 'whisper-large-v3-turbo';
let _endpoint = 'https://api.groq.com/openai/v1/audio/transcriptions';
let _ready = false;

export const browserSTT = {
  get ready(): boolean { return _ready; },

  async init(): Promise<void> {
    try {
      const resp = await fetch('/stt-config');
      if (!resp.ok) return;
      const data = await resp.json();
      if (data.enabled && data.apiKey) {
        _apiKey = data.apiKey;
        _model = data.model || _model;
        _endpoint = data.endpoint || _endpoint;
        _ready = true;
        log.info('Browser STT initialized', { model: _model });
      }
    } catch (e) {
      log.warn('Browser STT init failed', { detail: String(e) });
    }
  },

  async transcribe(audioBlob: Blob, language = 'zh'): Promise<string> {
    if (!_ready) return '';
    const formData = new FormData();
    formData.append('file', audioBlob, 'audio.webm');
    formData.append('model', _model);
    if (language && language !== 'auto') {
      formData.append('language', language);
    }
    formData.append('response_format', 'json');

    // Custom vocabulary → Whisper prompt parameter
    const vocabRaw = (() => { try { return localStorage.getItem(STORAGE_KEY + 'sttVocab') || ''; } catch (_e) { return ''; } })();
    const prompt = vocabRaw.split('\n').map(w => w.trim()).filter(Boolean).join(', ');
    if (prompt) {
      formData.append('prompt', prompt);
    }

    const resp = await fetch(_endpoint, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${_apiKey}` },
      body: formData,
    });
    if (resp.ok) {
      const data = await resp.json();
      return (data.text || '').trim();
    }
    const err = await resp.text();
    log.error('Groq STT error', { status: resp.status, detail: err });
    // Auth failure: disable browser STT so subsequent calls fall back to server
    if (resp.status === 401 || resp.status === 403) {
      _ready = false;
      log.warn('Browser STT disabled due to auth failure — falling back to server STT');
    }
    // Throw so callers (wakeword, PTT) fall back to server-side STT
    throw new Error(`Groq STT ${resp.status}`);
  },
};
