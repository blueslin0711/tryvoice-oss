// Azure browser-direct TTS — port of azure-tts.js

import { createLogger } from '../logging/logger';
import { ensureSpeechSdk } from '../core/script-loader';

const log = createLogger('audio.tts');

declare const SpeechSDK: {
  SpeechConfig: {
    fromAuthorizationToken(token: string, region: string): {
      speechSynthesisVoiceName: string;
      speechSynthesisOutputFormat: number;
    };
  };
  SpeechSynthesisOutputFormat: {
    Audio16Khz32KBitRateMonoMp3: number;
  };
  SpeechSynthesizer: new (config: unknown, audioConfig: null) => {
    speakSsmlAsync(ssml: string, onSuccess: (result: { reason: number; audioData: ArrayBuffer; errorDetails?: string }) => void, onError: (err: unknown) => void): void;
    close(): void;
  };
  ResultReason: {
    SynthesizingAudioCompleted: number;
  };
};

let _token: string | null = null;
let _tokenExpiry = 0;
let _region: string | null = null;
let _defaultVoice = 'zh-CN-XiaoxiaoNeural';

const LOCALE_DEFAULT_VOICES: Record<string, string> = {
  'zh-CN': 'zh-CN-XiaoxiaoNeural',
  'en': 'en-US-AriaNeural',
};

/** Extract IETF language tag from voice name, e.g. "zh-CN-XiaoxiaoNeural" → "zh-CN" */
function _voiceToXmlLang(voice: string): string {
  const m = voice.match(/^([a-z]{2}-[A-Z]{2})-/);
  return m ? m[1] : 'zh-CN';
}

let _enabled = false;
let _ready = false;
let _rate = '1.0';

// Reusable synthesizer instance — avoids per-chunk connection overhead.
let _synthesizer: InstanceType<typeof SpeechSDK.SpeechSynthesizer> | null = null;
let _synthesizerToken: string | null = null;

const TOKEN_REFRESH_MS = 8 * 60 * 1000;

async function _fetchToken(): Promise<boolean> {
  try {
    const resp = await fetch('/speech-token');
    if (!resp.ok) return false;
    const data = await resp.json();
    if (data.token && data.region) {
      _token = data.token;
      _region = data.region;
      _tokenExpiry = Date.now() + TOKEN_REFRESH_MS;
      return true;
    }
  } catch (e) {
    log.warn('Token fetch failed', { detail: String(e) });
  }
  return false;
}

async function _ensureToken(): Promise<boolean> {
  if (_token && Date.now() < _tokenExpiry) return true;
  return await _fetchToken();
}

function _ensureSynthesizer(): InstanceType<typeof SpeechSDK.SpeechSynthesizer> | null {
  if (typeof SpeechSDK === 'undefined' || !_token || !_region) return null;
  // Reuse existing synthesizer if token hasn't changed
  if (_synthesizer && _synthesizerToken === _token) return _synthesizer;
  // Close stale synthesizer
  if (_synthesizer) {
    try { _synthesizer.close(); } catch (_e) { /* ignore */ }
  }
  const config = SpeechSDK.SpeechConfig.fromAuthorizationToken(_token, _region);
  config.speechSynthesisOutputFormat = SpeechSDK.SpeechSynthesisOutputFormat.Audio16Khz32KBitRateMonoMp3;
  _synthesizer = new SpeechSDK.SpeechSynthesizer(config, null);
  _synthesizerToken = _token;
  return _synthesizer;
}

function _escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;')
          .replace(/"/g, '&quot;')
          .replace(/'/g, '&apos;');
}

export const azureTTS = {
  get enabled(): boolean { return _enabled; },
  get ready(): boolean { return _ready; },

  async init(): Promise<void> {
    try {
      const resp = await fetch('/speech-config');
      if (!resp.ok) return;
      const config = await resp.json();
      if (!config.azureEnabled) {
        log.info('Azure not configured, using server-side TTS');
        return;
      }
      _defaultVoice = config.defaultVoice || _defaultVoice;
      _region = config.region;
      _enabled = true;
    } catch (e) {
      log.warn('Config fetch failed', { detail: String(e) });
      return;
    }
    await ensureSpeechSdk();
    const ok = await _fetchToken();
    if (ok) {
      _ready = true;
      log.info('Azure TTS ready', { voice: _defaultVoice, region: _region });
    }
  },

  setVoice(voice: string): void {
    if (voice) _defaultVoice = voice;
  },

  setRate(rate: string): void {
    _rate = rate || '1.0';
  },

  setDefaultVoiceForLocale(locale: string): void {
    const voice = LOCALE_DEFAULT_VOICES[locale];
    if (voice) _defaultVoice = voice;
  },

  // requestTTS callback for audioPlayer
  requestTTS(text: string, callback: (b64: string | null) => void): void {
    // Resolve per-bot voice/rate for the currently active bot
    const resolveVoice = async () => {
      const { getCurrentBotId, getBotVoiceSelections, getDefaultVoice, getBotTtsRates } = await import('../ui/app-state');
      const botId = getCurrentBotId();
      const voice = getBotVoiceSelections()[botId] || getDefaultVoice() || _defaultVoice;
      const rate = getBotTtsRates()[botId] || _rate;
      return { botId, voice, rate };
    };

    if (!_ready) {
      // Fallback: use server-side TTS
      resolveVoice().then(({ botId, voice, rate }) =>
        fetch('/tts', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ text, botId, voice, rate }),
        })
          .then(r => r.ok ? r.json() : null)
          .then(d => callback(d?.audio || null))
          .catch(() => callback(null))
      );
      return;
    }
    resolveVoice()
      .then(({ botId, voice, rate }) =>
        this.speak(text, { voice, rate }).then(b64 => {
          if (b64) return callback(b64);
          // Azure synthesis failed — fallback to server-side Edge TTS
          log.warn('Azure synthesis returned null, falling back to server-side TTS', { voice });
          fetch('/tts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ text, botId, voice, rate }),
          })
            .then(r => r.ok ? r.json() : null)
            .then(d => callback(d?.audio || null))
            .catch(() => callback(null));
        })
      )
      .catch(() => callback(null));
  },

  async speak(text: string, opts?: { voice?: string; rate?: string }): Promise<string | null> {
    if (!_enabled || !text) return null;
    const tokenOk = await _ensureToken();
    if (!tokenOk) return null;

    const voice = opts?.voice || _defaultVoice;
    const rate = opts?.rate || _rate;

    const synthesizer = _ensureSynthesizer();
    if (!synthesizer) return null;

    const rateF = parseFloat(rate) || 1.0;
    const ratePct = Math.round((rateF - 1) * 100);
    const rateStr = (ratePct >= 0 ? '+' : '') + ratePct + '%';
    const xmlLang = _voiceToXmlLang(voice);
    const ssml = `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${xmlLang}">
  <voice name="${voice}">
    <prosody rate="${rateStr}">${_escapeXml(text)}</prosody>
  </voice>
</speak>`;

    return new Promise((resolve) => {
      synthesizer.speakSsmlAsync(
        ssml,
        (result) => {
          if (result.reason === SpeechSDK.ResultReason.SynthesizingAudioCompleted) {
            const bytes = new Uint8Array(result.audioData);
            let binary = '';
            for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
            resolve(btoa(binary));
          } else {
            log.warn('Synthesis failed', { reason: result.reason, detail: result.errorDetails });
            // Invalidate synthesizer on failure so next call creates a fresh one
            _synthesizer = null;
            _synthesizerToken = null;
            resolve(null);
          }
        },
        (err) => {
          log.warn('Synthesis error', { detail: String(err) });
          // Invalidate synthesizer on error
          _synthesizer = null;
          _synthesizerToken = null;
          resolve(null);
        }
      );
    });
  },
};
