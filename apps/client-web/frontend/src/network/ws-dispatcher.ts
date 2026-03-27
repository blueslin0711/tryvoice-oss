// WebSocket message dispatcher — routes incoming WS messages to appropriate handlers

import { bus } from '../core/event-bus';
import { createLogger } from '../logging/logger';
import { BOT_IDS } from '../core/types';
import { chunkForTTS } from '../audio/tts-chunker';

const log = createLogger('ws.dispatcher');
import { t } from '../i18n';
import { chatStore } from '../store/chat-store';
import {
  getCurrentBotId, getBotNames, setBotStatus,
  getBotStreamState, setBotStreamState,
  getUnreadCount, setUnreadCount, getLastReadSeq, setLastReadSeq,
  getAnnounceVoice, getAnnounceRate,
  showToast, autoReadEnqueue, markTextRead,
  classifyServerStatus, isTurnCancelled, clearTurnCancelled,
  isAutoReadEnabled,
  resetBotToIdle, setServerStatusText, interruptBot,
  setSlashCommands,
} from '../ui/app-state';
import { botTurnState } from '../state/bot-turn-state';
import { remoteAgentState, classifyToAgentState } from '../state/remote-agent-state';
import type { ContentKind } from '../core/types';
import {
  addBotMsg, completeStreamAudio, scrollToLatestSessionBoundary,
} from '../ui/chat-renderer';
import { onResetConfirmed, onResetFailed } from '../settings/slide-reset';
import { syncManager } from './sync';
import { updateBadges } from '../ui/mic-ui';
import { audioPlayer } from '../audio/audio-player';
import { showUserInputCard, dismissUserInputCard } from '../ui/user-input-card';

// Module-local state
const historySyncTargets: Record<string, number> = {};
const _lastAssistantPerBot: Record<string, { el: HTMLElement | null; idx: number }> = {};
const _pendingSessionBoundaryFocus: Record<string, boolean> = {};
let _lastAdapterHintSignature = '';
let _turnTimeoutHints: Record<string, number> = {};
let lastPlaybackEndMs = 0;

export function getLastPlaybackEndMs(): number { return lastPlaybackEndMs; }
export function setLastPlaybackEndMs(ms: number): void { lastPlaybackEndMs = ms; }
export function getHistorySyncTargets(): Record<string, number> { return historySyncTargets; }
export function getPendingSessionBoundaryFocus(): Record<string, boolean> { return _pendingSessionBoundaryFocus; }
export function getTurnTimeoutHints(): Record<string, number> { return _turnTimeoutHints; }

export type SetStatusFn = (raw: string) => void;

export function createWsDispatcher() {
  return function onWsMessage(data: Record<string, unknown>): void {
    const botId = data.botId as string;
    const type = data.type as string;

    // Auto-dismiss stale input cards when agent resumes
    if (botId && type === 'message_sync') {
      dismissUserInputCard(botId);
    }

    // Strict botId enforcement: drop messages without explicit botId
    // to prevent cross-bot contamination (RC-5 in bot-session-stability spec)
    if (!botId) {
      console.warn('[ws-dispatcher] dropping message without botId, type:', type);
      return;
    }

    // Turn cancellation guard — ignore stale server messages after user interrupt
    if (isTurnCancelled(botId)) {
      if (type === 'audio_complete') {
        clearTurnCancelled(botId);
        completeStreamAudio(botId);
        resetBotToIdle(botId);
        return;
      }
      if (type === 'transcript') {
        clearTurnCancelled(botId);
        // Fall through to normal processing — new turn
      } else if (type === 'cancel_ack') {
        // Always process cancel_ack — it is the response to the cancel we initiated
      } else if (type === 'message_sync') {
        // Always process message_sync — authoritative server data
      } else {
        return; // Ignore stale status/audio messages
      }
    }

    switch (data.type) {
      case 'bot_switched': {
        const switchCmds = (data.slashCommands as Array<{ cmd: string; description: string; label?: string }>) || [];
        setSlashCommands(botId, switchCmds.map(c => ({ cmd: c.cmd, desc: c.description, label: c.label })));
        break;
      }

      case 'adapter_status': {
        const adapterId = String(data.adapterId || '');
        const hints = Array.isArray(data.degradeHints)
          ? data.degradeHints.map((h: unknown) => String(h || ''))
          : [];
        const signature = `${adapterId}:${hints.join(',')}`;
        if (signature && signature !== _lastAdapterHintSignature) {
          _lastAdapterHintSignature = signature;
          if (hints.includes('non_streaming_reply')) {
            showToast(`Adapter ${adapterId}: ${t('toast.adapter_non_streaming')}`);
          }
          if (hints.includes('tts_only_stop')) {
            showToast(`Adapter ${adapterId}: ${t('toast.adapter_no_cancel')}`);
          }
        }
        // Store turn timeout hints for per-adapter processing timeout
        const th = (data.turnTimeoutHints || {}) as Record<string, number>;
        _turnTimeoutHints = th;
        // Cache slash commands from adapter if present
        if (data.slashCommands) {
          const adapterCmds = (data.slashCommands as Array<{ cmd: string; description: string; label?: string }>) || [];
          const currentBot = getCurrentBotId();
          if (currentBot) {
            setSlashCommands(currentBot, adapterCmds.map(c => ({ cmd: c.cmd, desc: c.description, label: c.label })));
          }
        }
        break;
      }

      case 'status': {
        const rawTxt = String(data.text || '');
        if (data.detail) log.error('STT error', { text: rawTxt, detail: String(data.detail) });

        // Stale warning: turn has been running for >10 minutes with no response.
        // Show ⚠️ on the bot card's status dot without disrupting the connection.
        if (rawTxt === 'stale') {
          const tab = document.querySelector<HTMLElement>(`.bot-tab[data-bot="${botId}"]`);
          const dot = tab?.querySelector<HTMLElement>('.bot-status-dot');
          if (dot) dot.dataset.status = 'stale';
          break;
        }

        setBotStatus(botId, rawTxt);

        // Update Layer 3: remote agent state
        const agentState = classifyToAgentState(rawTxt);
        if (agentState) remoteAgentState.update(botId, agentState);

        // Update Layer 2: bot turn state (keep processing reason for legacy sync)
        const reason = classifyServerStatus(rawTxt);
        if (reason) {
          // Ensure bot is in awaiting/receiving (processing states)
          const current = botTurnState.get(botId);
          if (current === 'idle' || current === 'sending') {
            botTurnState.transition(botId, 'awaiting');
          }
        } else {
          // Informational/transient status — store per-bot for projection layer
          setServerStatusText(botId, rawTxt);
        }
        break;
      }

      case 'transcript':
        audioPlayer.resetPause();
        setBotStreamState(botId, null);
        addBotMsg(botId, 'user', data.text as string, { eventKey: (data.eventKey as string) || '', clientMsgId: (data.clientMsgId as string) || '' });
        if (data.clientMsgId) chatStore.updateDeliveryStatus(botId, data.clientMsgId as string, 'processing');
        botTurnState.transition(botId, 'awaiting');
        remoteAgentState.update(botId, 'processing');
        setBotStatus(botId, t('status.processing'));
        break;

      case 'agent_started':
        if (data.clientMsgId) chatStore.updateDeliveryStatus(botId, data.clientMsgId as string, 'agent_processing');
        break;

      case 'user_input_request': {
        const inputKind = (data.inputKind as string) || '';
        const eventKey = (data.eventKey as string) || '';
        if (inputKind === 'ask_user') {
          showUserInputCard(botId, {
            kind: 'ask_user',
            questions: data.questions as Array<{
              question: string;
              header?: string;
              options: Array<{ label: string; description: string }>;
              multiSelect?: boolean;
            }>,
            eventKey,
          });
        } else if (inputKind === 'plan_options') {
          showUserInputCard(botId, {
            kind: 'plan_options',
            planSummary: (data.planSummary as string) || '',
            allowedPrompts: data.allowedPrompts as Array<{ tool: string; prompt: string }>,
            eventKey,
          });
        } else if (inputKind === 'permission') {
          showUserInputCard(botId, {
            kind: 'permission',
            toolName: (data.toolName as string) || '',
            toolDescription: (data.toolDescription as string) || '',
            eventKey,
          });
        }
        break;
      }

      case 'audio_chunk': {
        // Only set 'speaking' for the active bot when audio will actually play.
        // When autoRead is off, audio data is still attached for manual playback
        // but we skip the speaking state transition to avoid a stuck animation.
        if (botId === getCurrentBotId() && isAutoReadEnabled()) {
          botTurnState.transition(botId, 'speaking');
          setBotStatus(botId, t('status.speaking'));
        }
        const st = getBotStreamState(botId);
        const last = _lastAssistantPerBot[botId];
        const targetEl = (st?.el && st.el.isConnected) ? st.el : (last?.el || null);
        if (data.data) {
          if (botId === getCurrentBotId() && targetEl) autoReadEnqueue(targetEl, data.data as string, '');
        }
        break;
      }

      case 'audio_complete': {
        completeStreamAudio(botId);
        botTurnState.resetToIdle(botId);
        remoteAgentState.resetToIdle(botId);
        bus.emit('dispatcher:audio-complete', botId);
        if (historySyncTargets[botId]) syncManager.schedule(botId, 300, historySyncTargets[botId]);
        break;
      }

      case 'audio': {
        botTurnState.resetToIdle(botId);
        remoteAgentState.resetToIdle(botId);
        if (botId === getCurrentBotId()) {
          const last = _lastAssistantPerBot[botId];
          const el = last?.el || document.querySelector('#transcript .msg.assistant:last-of-type') as HTMLElement | null;
          if (el) autoReadEnqueue(el, data.data as string, '');
        }
        break;
      }

      case 'speak': {
        const isStreamingSpeak = !!(data.streaming);

        if (isStreamingSpeak) {
          // Streaming speak: backend already chunked the text, enqueue directly
          if (botId === getCurrentBotId() && isAutoReadEnabled()) {
            botTurnState.transition(botId, 'speaking');
          }
          const stSp = getBotStreamState(botId);
          const targetElSp = (stSp?.el && stSp.el.isConnected)
            ? stSp.el
            : (_lastAssistantPerBot[botId]?.el || null);
          if (botId === getCurrentBotId() && targetElSp) {
            const spText = (data.text as string) || '';
            autoReadEnqueue(targetElSp, '', spText);
            markTextRead(botId, spText);
          }
        } else {
          // Full-text speak: chunk on frontend
          botTurnState.resetToIdle(botId);
          remoteAgentState.resetToIdle(botId);
          const targetElSpeak = _lastAssistantPerBot[botId]?.el
            || document.querySelector('#transcript .msg.assistant:last-of-type') as HTMLElement | null;
          if (botId === getCurrentBotId() && targetElSpeak) {
            const speakText = (data.text as string) || '';
            const chunks = chunkForTTS(speakText);
            for (const chunk of chunks) {
              autoReadEnqueue(targetElSpeak, '', chunk);
            }
            markTextRead(botId, speakText);
          }
        }
        break;
      }

      case 'voice_set':
        break;

      case 'history_revision': {
        // Store server-authoritative lastReadSeq for unread tracking
        const serverLastRead = Number(data.lastReadSeq || 0);
        if (serverLastRead > 0 || getLastReadSeq(botId) < 0) {
          setLastReadSeq(botId, serverLastRead);
        }
        const rev = Number(data.revision || 0);
        if (rev > chatStore.getRevision(botId)) {
          historySyncTargets[botId] = rev;
          const _st = getBotStreamState(botId);
          const isBusy = (_st && (!_st.responseDone || !_st.audioDone)) ||
            ['awaiting', 'receiving', 'stt', 'sending'].includes(botTurnState.get(botId) || '');
          if (!isBusy) {
            syncManager.schedule(botId, 60, rev);
          }
          // When busy, historySyncTargets[botId] is still recorded.
          // The deferred sync fires when bot returns to idle
          // (see event-wiring.ts turn-state-change → idle handler).
        }
        // Recompute unread count from lastReadSeq for non-current bots
        if (botId !== getCurrentBotId()) {
          const maxSeq = Number(data.maxServerSeq || 0);
          if (maxSeq > serverLastRead) {
            // Approximate: exact count requires message data, but
            // maxServerSeq - lastReadSeq gives the upper bound.
            // The precise count is computed after sync delivers messages.
          }
        }
        break;
      }

      case 'active_turns': {
        const turns = (data.turns || []) as Array<Record<string, unknown>>;
        for (const turn of turns) {
          const tid = String(turn.botId || '');
          if (!tid) continue;
          const elapsed = Math.round(Number(turn.elapsedSec || 0));
          botTurnState.transition(tid, 'awaiting');
          setBotStatus(tid, `处理中 (${elapsed}s)...`);
        }
        break;
      }

      case 'cancel_ack': {
        const mode = String(data.mode || 'tts_only_stop');
        // Suppress cancel message when a new turn is already in progress
        // (auto-cancel from sending a new message, not user pressing stop)
        const currentState = botTurnState.get(botId);
        const isAutoCancel = currentState !== 'idle';
        if (!isAutoCancel) {
          const label = mode === 'generation_cancelled'
            ? t('status.generation_interrupted')
            : t('status.tts_stopped');
          addBotMsg(botId, 'assistant', label, {
            intermediate: true,
            contentKind: 'intermediate' as ContentKind,
            eventKey: `cancel_ack_${Date.now()}`,
          });
          bus.emit('chat:render', botId);
        }
        log.info('cancel_ack received', { botId, mode, ok: data.ok, suppressed: isAutoCancel });
        break;
      }

      case 'tool_idle': {
        // Cancel cleared all tool_active state — reset to idle if still processing
        const current = botTurnState.get(botId);
        if (current === 'awaiting' || current === 'receiving') {
          // Don't force idle here — cancel_ack handler does that
        }
        // Clear any visual "tool running" indicator
        setBotStatus(botId, '');
        break;
      }

      case 'session_reset_detected': {
        // Organic /clear typed directly in tmux — boundary event handled by canonical_store
        // Advance lastReadSeq so pre-reset messages are not counted as unread
        const maxSeqDet = chatStore.getMaxServerSeq(botId);
        if (maxSeqDet > 0) {
          setLastReadSeq(botId, maxSeqDet);
          setUnreadCount(botId, 0);
          updateBadges();
        }
        bus.emit('chat:render', botId);
        syncManager.schedule(botId, 30);
        break;
      }

      case 'session_reset_confirmed': {
        // Stop any active TTS playback and reset bot state before clearing session
        interruptBot(botId);
        const rev = Number(data.revision || 0);
        // Boundary event handled by canonical_store; advance lastReadSeq so pre-reset messages are not counted as unread
        const maxSeqConf = chatStore.getMaxServerSeq(botId);
        if (maxSeqConf > 0) {
          setLastReadSeq(botId, maxSeqConf);
          setUnreadCount(botId, 0);
          updateBadges();
        }
        bus.emit('chat:render', botId);  // show divider immediately, before sync completes
        historySyncTargets[botId] = rev;
        _pendingSessionBoundaryFocus[botId] = true;
        syncManager.schedule(botId, 30, rev);
        showToast(getBotNames()[botId] + ' ' + t('toast.session_reset_history_kept'));
        onResetConfirmed(botId);
        break;
      }

      case 'session_reset_failed': {
        showToast(getBotNames()[botId] + ' ' + t('toast.session_reset_failed'));
        syncManager.schedule(botId, 120);
        onResetFailed(botId);
        break;
      }

      case 'compact_confirmed': {
        // Boundary event handled by canonical_store
        bus.emit('chat:render', botId);
        showToast(t('toast.compact_confirmed'));
        break;
      }

      case 'compact_failed': {
        showToast(t('toast.compact_failed'));
        break;
      }

      case 'message_sync': {
        const ek = data.eventKey as string;
        const role = data.role as string;
        const text = data.text as string;
        const seq = data.serverSeq as number;
        const ts = (data.timestamp || '') as string;
        const cmid = (data.clientMsgId || '') as string;
        const srcCh = (data.sourceChannel || 'web') as string;
        const isIntermediate = !!data.intermediate;
        const ck = (data.contentKind || 'result') as string;
        if (ek && role && seq != null) {
          chatStore.upsertMessage(botId, {
            eventKey: ek, role, text, serverSeq: seq, timestamp: ts,
            clientMsgId: cmid, sourceChannel: srcCh,
            intermediate: isIntermediate, contentKind: ck,
          });
        }
        break;
      }
    }
  };
}

// Handle session boundary focus after chat render
export function handleChatRendered(botId: string): void {
  if (!_pendingSessionBoundaryFocus[botId]) return;
  if (botId !== getCurrentBotId()) return;
  if (scrollToLatestSessionBoundary(true)) {
    _pendingSessionBoundaryFocus[botId] = false;
  }
}

// Unread announcement system — double-slot queue
//
// Slot 1 (in-flight): the announcement currently being TTS'd / played.
// Slot 2 (pending):   if badge updates arrive while Slot 1 is active,
//                     the latest announcement text overwrites Slot 2.
// When Slot 1 finishes, Slot 2 (if any) promotes to Slot 1.
// This caps the queue at one pending announcement regardless of how
// frequently badge updates arrive.

let _lastAnnouncedSnapshot = '';
let _unreadAnnouncementTimer: ReturnType<typeof setTimeout> | null = null;
let _announcementInFlight = false;
let _pendingSlotDirty = false; // Slot 2: new badge update arrived while Slot 1 active
const UNREAD_ANNOUNCE_DELAY_MS = 2000;

export function cancelUnreadAnnouncement(): void {
  if (_unreadAnnouncementTimer) { clearTimeout(_unreadAnnouncementTimer); _unreadAnnouncementTimer = null; }
}

/** Returns true (and clears the flag) if the audio that just finished was an announcement. */
export function consumeAnnouncementInFlight(): boolean {
  if (!_announcementInFlight) return false;
  _announcementInFlight = false;
  log.info('announce: consumed in-flight flag');
  // Slot 1 just finished — if Slot 2 is dirty, promote it
  if (_pendingSlotDirty) {
    _pendingSlotDirty = false;
    log.info('announce: promoting pending slot');
    scheduleUnreadAnnouncement();
  }
  return true;
}

export function resetAnnouncedSnapshot(): void {
  log.info('announce: snapshot reset', { prev: _lastAnnouncedSnapshot });
  _lastAnnouncedSnapshot = '';
}

/**
 * Called when badge updates (new unread message on a non-current bot).
 * If Slot 1 is active, marks Slot 2 dirty instead of scheduling immediately.
 */
export function notifyUnreadChanged(): void {
  if (_announcementInFlight) {
    // Slot 1 playing — park the update in Slot 2
    _pendingSlotDirty = true;
    log.info('announce: badge changed while in-flight, marked pending slot dirty');
    return;
  }
  // No announcement in flight — schedule normally
  scheduleUnreadAnnouncement();
}

function _canAnnounce(): boolean {
  const currentBot = getCurrentBotId();
  const currentTurnIdle = botTurnState.get(currentBot) === 'idle';
  const audioIdle = audioPlayer.state === 'idle';
  return currentTurnIdle && audioIdle;
}

function _buildUnreadAnnouncement(): string {
  const parts: string[] = [];
  const currentBot = getCurrentBotId();
  const names = getBotNames();
  for (const id of BOT_IDS) {
    if (id === currentBot) continue;
    const count = getUnreadCount(id);
    if (count > 0) parts.push(t('unread.count', { name: names[id], count }));
  }
  return parts.join('，');
}

async function _requestAnnounceTTS(text: string): Promise<string | null> {
  try {
    const resp = await fetch('/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, voice: getAnnounceVoice?.() || 'zh-CN-XiaoxiaoNeural', rate: getAnnounceRate?.() || '1.0' }),
    });
    if (!resp.ok) return null;
    const data = await resp.json();
    return (data.audio as string) || null;
  } catch (_e) { return null; }
}

export function scheduleUnreadAnnouncement(): void {
  cancelUnreadAnnouncement();
  const caller = new Error().stack?.split('\n')[2]?.trim() || 'unknown';
  log.info('announce: scheduled', { caller });
  _unreadAnnouncementTimer = setTimeout(async () => {
    _unreadAnnouncementTimer = null;
    if (!_canAnnounce()) { log.info('announce: skipped (not ready)', { currentBot: getCurrentBotId(), turnState: botTurnState.get(getCurrentBotId()), audioState: audioPlayer.state }); return; }
    const text = _buildUnreadAnnouncement();
    if (!text) { log.info('announce: skipped (no unread)'); return; }
    if (text === _lastAnnouncedSnapshot) { log.info('announce: skipped (same snapshot)', { text }); return; }
    log.info('announce: firing', { text, prevSnapshot: _lastAnnouncedSnapshot });
    _lastAnnouncedSnapshot = text;
    const audioB64 = await _requestAnnounceTTS(text);
    if (!_canAnnounce()) { log.info('announce: skipped after TTS (not ready)', { currentBot: getCurrentBotId(), turnState: botTurnState.get(getCurrentBotId()), audioState: audioPlayer.state }); return; }
    _announcementInFlight = true;
    if (audioB64) {
      audioPlayer.enqueue(null, audioB64, text);
    } else {
      audioPlayer.enqueue(null, '', text);
    }
    log.info('announce: enqueued', { text, hasTTS: !!audioB64 });
  }, UNREAD_ANNOUNCE_DELAY_MS);
}
