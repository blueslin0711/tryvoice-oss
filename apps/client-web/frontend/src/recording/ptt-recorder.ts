// Push-to-Talk recording with chunked STT support

import { bus } from '../core/event-bus';
import { createLogger } from '../logging/logger';
import {
  getCurrentBotId,
  getInputMode, interruptBot,
  flushDeferredReads, showToast,
} from '../ui/app-state';
import { micState } from '../state/mic-state';
import { botTurnState } from '../state/bot-turn-state';
import {
  getMicStream, newRecorder, buildRecordingBlob, blobToBase64,
  createStreamAnalyser, computeRMS, createSilenceDetector,
  createChunkedTranscriptionSession,
  getChunkMinDurationMs, SILENCE_THRESHOLD, SILENCE_TRIGGER_MS,
} from './recording-utils';
import type { ChunkedTranscriptionSession } from './recording-utils';
import { audioPlayer } from '../audio/audio-player';
import * as ws from '../network/ws-client';
import { outbox } from '../network/outbox';
import { voiceHistoryStore } from '../store/voice-history-store';

const log = createLogger('recording.ptt');

function _saveToHistory(b64: string, botId: string, opts: { transcript?: string; cancelled?: boolean; status?: 'recorded' | 'transcribed' | 'sent' } = {}): void {
  voiceHistoryStore.saveRecording({
    botId,
    audioB64: b64,
    transcript: opts.transcript || '',
    status: opts.status || 'sent',
    cancelled: opts.cancelled || false,
    createdAt: Date.now(),
  }).catch(() => {});
}

let mediaRecorder: MediaRecorder | null = null;
let audioChunks: Blob[] = [];
let recordingCancelled = false;
let lastPttTouchAt = 0;
// When true, the current recorder.stop() is a chunk split, not a final stop.
// onstop handler will submit the chunk and restart the recorder.
let _chunkRestart = false;
let activeChunkSession: ChunkedTranscriptionSession | null = null;

export async function startRecording(): Promise<void> {
  if (micState.isActive) return;
  const botId = getCurrentBotId();
  // Only interrupt TTS playback, not Agent generation (INV-WW-01)
  const currentTurn = botTurnState.get(botId);
  if (currentTurn === 'speaking') {
    interruptBot(botId, 'stopped_reading');
  }
  if (!micState.startRecording({ botId, mode: 'ptt' })) return;
  bus.emit('ui:cancel-unread-announcement');
  // Stop current playback and reject new TTS enqueues while acquiring mic.
  // On iOS, getUserMedia may take 1-2s for AVAudioSession negotiation;
  // without this guard, incoming TTS could compete for the audio session.
  audioPlayer.cancelPlayback();
  audioPlayer.getAudioContext(); // ensure ctx

  try {
    const stream = await getMicStream();
    audioPlayer.resetPause(); // mic acquired — allow TTS enqueue again
    const { recorder, chunks } = newRecorder(stream);
    audioChunks = chunks;
    mediaRecorder = recorder;
    micState.setRecording();

    // Pre-check browser STT availability
    const browserSTT = (await import('../audio/browser-stt')).browserSTT;
    const useChunked = browserSTT.ready;
    const sttLang = (document.getElementById('stt-language-select') as HTMLSelectElement | null)?.value || 'en';
    const silenceDetector = useChunked
      ? createSilenceDetector(getChunkMinDurationMs(), SILENCE_THRESHOLD, SILENCE_TRIGGER_MS)
      : null;
    // Keep a full copy of all chunks for voice history (chunks gets cleared in chunked mode)
    const allChunks: Blob[] = [];
    if (useChunked) {
      activeChunkSession = createChunkedTranscriptionSession(sttLang);
      recorder.addEventListener('dataavailable', (e: BlobEvent) => {
        if (e.data.size > 0) allChunks.push(e.data);
      });
    }

    recorder.onstop = async () => {
      // Chunk split: submit chunk for background transcription and restart recorder
      if (_chunkRestart) {
        _chunkRestart = false;
        const chunkBlob = buildRecordingBlob([...chunks]);
        chunks.length = 0;
        recorder.start();
        silenceDetector!.reset();
        if (chunkBlob && activeChunkSession) {
          activeChunkSession.submitChunk(chunkBlob);
        }
        return;
      }

      stream.getTracks().forEach(t => t.stop());
      micState.setSaving();
      bus.emit('ui:voice-ripple', 0);
      bus.emit('ui:voice-feedback', recordingCancelled ? 'cancel' : 'stop');
      flushDeferredReads();

      if (recordingCancelled) {
        recordingCancelled = false;
        if (activeChunkSession) { activeChunkSession.cancel(); activeChunkSession = null; }
        const cancelBlob = buildRecordingBlob(useChunked ? allChunks : chunks);
        if (cancelBlob) {
          const recBotId = micState.context?.botId || getCurrentBotId();
          blobToBase64(cancelBlob).then(b64 => _saveToHistory(b64, recBotId, { cancelled: true, status: 'recorded' })).catch(() => {});
        }
        micState.cancelRecording();
        return;
      }

      const blob = buildRecordingBlob(chunks);

      if (useChunked && activeChunkSession) {
        const session = activeChunkSession;
        activeChunkSession = null;
        // Submit final chunk
        if (blob) session.submitChunk(blob);

        if (!session.hasChunks) {
          botTurnState.resetToIdle(getCurrentBotId(), chunks.length ? 'too_short' : undefined);
          micState.setIdle();
          return;
        }

        const recBotId = micState.context?.botId || getCurrentBotId();
        botTurnState.transition(recBotId, 'stt');
        const transcript = await session.finalize();

        if (transcript) {
          botTurnState.transition(recBotId, 'sending');
          const msgId = ws.nextMsgId();
          bus.emit('chat:add-user-msg', { botId: recBotId, text: transcript, clientMsgId: msgId });
          outbox.enqueue({ type: 'text', text: transcript, botId: recBotId }, msgId);
          const fullBlob = buildRecordingBlob(allChunks) || blob;
          if (fullBlob) blobToBase64(fullBlob).then(b64 => _saveToHistory(b64, recBotId, { transcript })).catch(() => {});
        } else {
          // All chunks failed — fallback: send full audio for server-side STT
          const fullBlob = buildRecordingBlob(allChunks);
          if (fullBlob) {
            const b64 = await blobToBase64(fullBlob);
            outbox.enqueue({ type: 'audio', audioB64: b64, botId: recBotId });
            _saveToHistory(b64, recBotId);
            botTurnState.transition(recBotId, 'sending');
          } else {
            botTurnState.resetToIdle(recBotId, 'not_heard');
          }
        }
        micState.setIdle();
        return;
      }

      // Non-chunked path (original behavior)
      activeChunkSession = null;
      if (!blob) {
        botTurnState.resetToIdle(getCurrentBotId(), chunks.length ? 'too_short' : undefined);
        micState.setIdle();
        return;
      }

      const recBotId = micState.context?.botId || getCurrentBotId();
      botTurnState.transition(recBotId, 'stt');

      if (browserSTT.ready) {
        try {
          const transcript = await browserSTT.transcribe(blob, sttLang);
          if (!transcript) {
            botTurnState.resetToIdle(recBotId, 'not_heard');
            micState.setIdle();
            return;
          }
          botTurnState.transition(recBotId, 'sending');
          const msgId = ws.nextMsgId();
          bus.emit('chat:add-user-msg', { botId: recBotId, text: transcript, clientMsgId: msgId });
          outbox.enqueue({ type: 'text', text: transcript, botId: recBotId }, msgId);
          blobToBase64(blob).then(b64 => _saveToHistory(b64, recBotId, { transcript })).catch(() => {});
        } catch (_e) {
          const b64 = await blobToBase64(blob);
          outbox.enqueue({ type: 'audio', audioB64: b64, botId: recBotId });
          _saveToHistory(b64, recBotId);
          botTurnState.transition(recBotId, 'sending');
        }
      } else {
        const b64 = await blobToBase64(blob);
        outbox.enqueue({ type: 'audio', audioB64: b64, botId: recBotId });
        _saveToHistory(b64, recBotId);
        botTurnState.transition(recBotId, 'sending');
      }
      micState.setIdle();
    };

    // W5 fix: handle MediaRecorder errors (e.g. mic permission revoked mid-recording)
    recorder.onerror = () => {
      log.warn('MediaRecorder error — cancelling recording');
      if (activeChunkSession) { activeChunkSession.cancel(); activeChunkSession = null; }
      micState.cancelRecording();
      botTurnState.resetToIdle(botId, 'mic_denied');
      bus.emit('ui:voice-ripple', 0);
    };

    recorder.start();
    bus.emit('ui:voice-feedback', 'start');
    recordingCancelled = false;

    const { analyser, buf } = createStreamAnalyser(stream);
    const tick = () => {
      if (!micState.isActive) { bus.emit('ui:voice-ripple', 0); return; }
      const rms = computeRMS(analyser, buf);
      bus.emit('ui:voice-ripple', rms);

      // Chunked STT: check for silence to trigger chunk split
      if (silenceDetector && mediaRecorder && mediaRecorder.state === 'recording') {
        if (silenceDetector.check(rms, performance.now())) {
          _chunkRestart = true;
          mediaRecorder.stop();
        }
      }

      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  } catch (e) {
    audioPlayer.resetPause(); // unblock TTS on mic failure
    micState.setIdle();
    botTurnState.resetToIdle(botId, 'mic_denied');
    log.warn('Mic access failed', { detail: String(e) });
  }
}

export function stopRecording(): void {
  if (!micState.isActive) return;
  // Cancel any pending chunk-restart so onstop treats this as final stop
  _chunkRestart = false;
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    micState.setIdle();
    mediaRecorder = null;
    bus.emit('ui:voice-ripple', 0);
    return;
  }
  micState.setStopping();
  mediaRecorder.stop();
}

export function cancelRecording(): void {
  if (audioPlayer.state !== 'idle') {
    interruptBot(getCurrentBotId(), 'stopped_reading');
    return;
  }
  _chunkRestart = false;
  if (activeChunkSession) { activeChunkSession.cancel(); activeChunkSession = null; }
  recordingCancelled = true;
  stopRecording();
}

export function pttTap(e?: Event): void {
  if (e) e.preventDefault();
  if (getInputMode() !== 'ptt') return;
  const now = Date.now();
  if (e && (e as MouseEvent).type === 'click' && now - lastPttTouchAt < 650) return;
  if (e && (e as TouchEvent).type === 'touchend') lastPttTouchAt = now;
  if (micState.isActive) { stopRecording(); audioPlayer.getAudioContext(); }
  else { startRecording(); }
}

export function isRecordingCancelled(): boolean { return recordingCancelled; }
export function setRecordingCancelled(v: boolean): void { recordingCancelled = v; }
