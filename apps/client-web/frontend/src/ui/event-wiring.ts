// Event wiring — connects event bus to UI handlers

import { bus } from '../core/event-bus';
import { BOT_IDS } from '../core/types';
import { t } from '../i18n';
import {
  getCurrentBotId, getBotStreamState,
  showToast, isTurnCancelled, clearTurnCancelled,
  getUnreadCount, setUnreadCount, getBotSeenCount, setBotSeenCount,
  getLastReadSeq, setLastReadSeq,
  autoReadEnqueue, isAutoReadEnabled, shouldIncludeMsg,
  isTextAlreadyRead, markTextRead,
} from './app-state';
import { botTurnState } from '../state/bot-turn-state';
import { renderChat, addBotMsg, autoReadUnreadN, updateDeliveryStatusDOM, scrollToReadingIfNeeded, updatePlayButtons } from './chat-renderer';
import { setCancelReplyActive, setVoiceRipple, playVoiceFeedback, updateBadges } from './mic-ui';
import { audioPlayer } from '../audio/audio-player';
import { outbox } from '../network/outbox';
import { getHistorySyncTargets } from '../network/ws-dispatcher';
import { syncManager } from '../network/sync';
import * as ws from '../network/ws-client';
import { chatStore } from '../store/chat-store';
import {
  handleChatRendered, cancelUnreadAnnouncement, scheduleUnreadAnnouncement,
  consumeAnnouncementInFlight, notifyUnreadChanged, setLastPlaybackEndMs,
} from '../network/ws-dispatcher';
import { chunkForTTS } from '../audio/tts-cleaner';

/**
 * Highlight the exact text being read by wrapping matching text nodes with
 * <mark class="tts-reading">.  Uses a TreeWalker to find the chunk text
 * within .msg-text and wraps the matching range.
 */
function _highlightChunkText(msgEl: HTMLElement, chunkText: string): void {
  _clearChunkHighlights(msgEl);
  if (!chunkText) return;

  const msgTextEl = msgEl.querySelector('.msg-text');
  if (!msgTextEl) return;

  // Normalize for matching: collapse whitespace
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
  const needle = norm(chunkText);
  if (!needle) return;

  // Collect text nodes and build a concatenated string for searching
  const walker = document.createTreeWalker(msgTextEl, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  const offsets: number[] = []; // cumulative offset for each text node
  let cumLen = 0;
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    textNodes.push(node);
    offsets.push(cumLen);
    cumLen += node.textContent!.length;
  }
  if (textNodes.length === 0) return;

  // Build concatenated content and search (normalized, but we track real positions)
  const fullText = textNodes.map(n => n.textContent!).join('');
  // Find match position using normalized comparison
  const normFull = norm(fullText);
  const matchIdx = normFull.indexOf(needle);
  if (matchIdx === -1) return;

  // Map normalized match position back to raw text position.
  // Walk the raw text and track how many chars map to normalized chars.
  let rawStart = -1;
  let rawEnd = -1;
  let normPos = 0;
  // Skip leading whitespace in raw text that was trimmed by norm()
  let rawIdx = 0;
  const rawLen = fullText.length;
  // Find start of content (skip leading whitespace that norm() trims)
  while (rawIdx < rawLen && /\s/.test(fullText[rawIdx])) rawIdx++;
  for (; rawIdx < rawLen && normPos <= matchIdx + needle.length; rawIdx++) {
    if (normPos === matchIdx && rawStart === -1) rawStart = rawIdx;
    if (/\s/.test(fullText[rawIdx])) {
      // Collapse whitespace: skip extra whitespace chars
      while (rawIdx + 1 < rawLen && /\s/.test(fullText[rawIdx + 1])) rawIdx++;
      normPos++; // one space in normalized
    } else {
      normPos++;
    }
    if (normPos === matchIdx + needle.length && rawEnd === -1) rawEnd = rawIdx + 1;
  }
  if (rawStart === -1 || rawEnd === -1) return;

  // Now wrap text nodes from rawStart to rawEnd
  for (let i = 0; i < textNodes.length; i++) {
    const tNode = textNodes[i];
    const tStart = offsets[i];
    const tEnd = tStart + tNode.textContent!.length;
    // Skip nodes outside the match range
    if (tEnd <= rawStart || tStart >= rawEnd) continue;
    // Calculate overlap within this text node
    const overlapStart = Math.max(0, rawStart - tStart);
    const overlapEnd = Math.min(tNode.textContent!.length, rawEnd - tStart);
    if (overlapStart >= overlapEnd) continue;

    // Split and wrap
    const mark = document.createElement('mark');
    mark.className = 'tts-reading';
    if (overlapEnd < tNode.textContent!.length) {
      tNode.splitText(overlapEnd);
    }
    const matchNode = overlapStart > 0 ? tNode.splitText(overlapStart) : tNode;
    matchNode.parentNode!.insertBefore(mark, matchNode);
    mark.appendChild(matchNode);
    // Adjust offsets for subsequent nodes (splitting changes the array)
    // Since we only mark non-overlapping sequential ranges, we can break
    // after processing enough nodes, but it's safe to continue.
  }
}

function _clearChunkHighlights(root?: HTMLElement | Document): void {
  const container = root || document;
  container.querySelectorAll('mark.tts-reading').forEach(mark => {
    const parent = mark.parentNode;
    if (!parent) return;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    // Merge adjacent text nodes to keep DOM clean
    parent.normalize();
  });
}

export function bindAudioStateEvents(
  transcript: HTMLElement,
): void {
  // TTS failure feedback: mark the message card so the play-btn shows failure state
  bus.on('audio:tts-failed', (evt: unknown) => {
    const { element } = evt as { element: HTMLElement | null };
    if (element) {
      const card = element.closest?.('.msg') as HTMLElement | null;
      if (card) card.classList.add('tts-failed');
    }
  });

  // After N cumulative TTS failures in a session, show a toast notification
  bus.on('audio:tts-failures-exceeded', () => {
    showToast(t('toast.tts_read_failed'), { severity: 'warning' });
  });

  bus.on('audio:state', (evt: unknown) => {
    const e = evt as { state: string; msgEl: HTMLElement | null; phase: string; chunkText: string };
    if (e.phase === 'start') {
      // Refresh speaking timeout so long TTS responses aren't cut off (ISSUE-02)
      const currentBot = getCurrentBotId();
      if (botTurnState.get(currentBot) === 'speaking') {
        botTurnState.refreshTimer(currentBot);
      }
      document.querySelectorAll('.msg.reading').forEach(m => m.classList.remove('reading'));
      // msgEl is null for announcements (unread count TTS) — skip card
      // highlight entirely.  Only fall back to the last assistant card when
      // msgEl was provided but detached from the DOM (e.g. re-rendered).
      const liveEl = e.msgEl
        ? (e.msgEl.isConnected ? e.msgEl : (() => {
            const els = transcript.querySelectorAll('.msg.assistant');
            return els.length > 0 ? els[els.length - 1] : null;
          })())
        : null;
      if (liveEl) {
        liveEl.classList.add('reading');
        _highlightChunkText(liveEl as HTMLElement, e.chunkText);
        scrollToReadingIfNeeded();
      }
      updatePlayButtons();
    } else if (e.phase === 'itemEnd') {
      if (e.msgEl) {
        e.msgEl.classList.remove('reading');
        _clearChunkHighlights(e.msgEl);
      }
      setLastPlaybackEndMs(Date.now());
      updatePlayButtons();
    } else if (e.phase === 'end' || e.phase === 'pause') {
      document.querySelectorAll('.msg.reading').forEach(m => m.classList.remove('reading'));
      _clearChunkHighlights();
      setLastPlaybackEndMs(Date.now());
      updatePlayButtons();
      // When audio stops, clear speaking state across all bots
      for (const id of BOT_IDS) {
        if (botTurnState.get(id) === 'speaking') {
          botTurnState.resetToIdle(id);
        }
      }
      // Only re-schedule announcements after regular audio ends, not after
      // an announcement itself finishes — otherwise badge count increments
      // during playback cause a cascade of repeated announcements.
      if (e.phase === 'end' && !consumeAnnouncementInFlight()) scheduleUnreadAnnouncement();
    }
  });
}

export function bindChatEvents(): void {
  bus.on('chat:add-user-msg', (evt: unknown) => {
    const e = evt as { botId: string; text: string; clientMsgId: string };
    addBotMsg(e.botId, 'user', e.text, { status: 'pending', deliveryStatus: 'sending', clientMsgId: e.clientMsgId });
  });
  bus.on('ui:voice-feedback', (type: unknown) => { playVoiceFeedback(type as 'start' | 'stop' | 'cancel'); });
  bus.on('ui:voice-ripple', (rms: unknown) => { setVoiceRipple(rms as number); });
  bus.on('ui:badges', () => updateBadges());
  bus.on('ui:cancel-unread-announcement', cancelUnreadAnnouncement);
  bus.on('ui:flash-tab', (botId: unknown) => {
    const tab = document.querySelector(`.bot-tab[data-bot="${botId as string}"]`) as HTMLElement | null;
    if (!tab) return;
    tab.classList.remove('flash');
    void tab.offsetWidth; // force reflow to restart animation
    tab.classList.add('flash');
    tab.addEventListener('animationend', () => tab.classList.remove('flash'), { once: true });
  });
  bus.on('chat:render', (botId: unknown) => renderChat(botId as string));
  bus.on('chat:auto-read-unread', (evt: unknown) => {
    const { botId, count } = evt as { botId: string; count: number };
    autoReadUnreadN(botId, count);
  });
  bus.on('chat:rendered', (botId: unknown) => handleChatRendered(botId as string));
  bus.on('dispatcher:audio-complete', () => scheduleUnreadAnnouncement());
}

export function bindWsEvents(
  onWsMessage: (data: Record<string, unknown>) => void,
  onWsOpen: () => void,
  onWsClose: () => void,
): void {
  bus.on('ws:message', (data: unknown) => onWsMessage(data as Record<string, unknown>));
  bus.on('ws:open', onWsOpen);
  bus.on('ws:close', onWsClose);
  bus.on('ws:ack', (msgId: unknown, botId: unknown) => {
    void outbox.onAck(String(msgId || ''), String(botId || ''));
  });
  bus.on('ws:ack-timeout', (msgId: unknown, botId: unknown) => {
    const id = String(msgId || '');
    if (!id) return;
    void outbox.onAckTimeout(id, String(botId || ''));
  });
}

export function bindOutboxEvents(): void {
  bus.on('outbox:status', (...args: unknown[]) => {
    const msgId = args[0] as string;
    const status = args[1] as string;
    const entry = args[2] as Record<string, unknown>;
    const botId = entry.botId as string;
    if (!botId) return;
    if (status === 'sent') chatStore.updateDeliveryStatus(botId, msgId, 'sent');
    else if (status === 'acked') chatStore.updateDeliveryStatus(botId, msgId, 'delivered');
    else if (status === 'failed') {
      chatStore.updateDeliveryStatus(botId, msgId, 'failed');
      showToast(t('toast.send_failed'), {
        severity: 'error',
        action: { label: t('toast.retry'), callback: () => outbox.drain() },
      });
    }
  });
}

// Advance lastReadSeq for a bot and notify backend.
// This is the single pointer for both unread counting and TTS start position.
function _advanceLastReadSeq(botId: string, seq: number): void {
  if (seq > getLastReadSeq(botId)) {
    setLastReadSeq(botId, seq);
    ws.send({ type: 'mark_read', botId, seq });
  }
}

// Track whether we have initialized the TTS baseline for each bot.
// Before this flag is set, we skip sync-path TTS to avoid reading the
// entire history on first load.
const _ttsBaselineSet: Record<string, boolean> = {};


export function bindChatStoreChanged(): void {
  bus.on('chat:changed', (botId: unknown) => {
    const id = botId as string;

    // Non-current bots: update badge immediately regardless of stream state,
    // so the unread count increments with each arriving message.
    if (id !== getCurrentBotId()) {
      const lastRead = getLastReadSeq(id);
      if (lastRead >= 0) {
        // Seq-based: count assistant messages that pass the unified granularity filter
        const msgs = chatStore.getMessages(id);
        const unread = msgs.filter(
          m => m.role === 'assistant'
            && shouldIncludeMsg(m)
            && m.serverSeq && m.serverSeq > lastRead
            && m.sourceChannel !== 'terminal'
        ).length;
        if (unread !== getUnreadCount(id)) {
          setUnreadCount(id, unread);
          updateBadges();
          if (unread > 0) {
            bus.emit('ui:flash-tab', id);
            notifyUnreadChanged();
          }
        }
      } else {
        // Legacy fallback: count-based (before first history_revision arrives)
        const msgs = chatStore.getMessages(id);
        const newCount = msgs.filter(m => m.role === 'assistant' && shouldIncludeMsg(m)).length;
        const prevCount = getBotSeenCount(id);
        if (prevCount < 0) {
          setBotSeenCount(id, newCount);
        } else if (newCount > prevCount) {
          setBotSeenCount(id, newCount);
          setUnreadCount(id, (getUnreadCount(id) || 0) + (newCount - prevCount));
          updateBadges();
          bus.emit('ui:flash-tab', id);
          notifyUnreadChanged();
        }
      }
      return;
    }

    const st = getBotStreamState(id);
    if (st && (!st.responseDone || !st.audioDone)) return;
    if (id === getCurrentBotId()) {
      // Use lastReadSeq as the single pointer for both unread counting
      // and TTS start position. On first init (lastReadSeq not yet received
      // from server), set baseline to maxServerSeq to avoid reading history.
      const lastRead = getLastReadSeq(id);
      const prevReadSeq = lastRead >= 0 ? lastRead : chatStore.getMaxServerSeq(id);
      const wasFirstInit = !_ttsBaselineSet[id];
      if (wasFirstInit) {
        _ttsBaselineSet[id] = true;
        const maxSeq = chatStore.getMaxServerSeq(id);
        if (lastRead < 0) {
          // No server lastReadSeq yet — skip TTS, advance to maxServerSeq
          if (maxSeq > 0) _advanceLastReadSeq(id, maxSeq);
        } else if (maxSeq > lastRead) {
          // ISSUE-06 fix: server provided lastReadSeq and there are legit unread
          // messages (maxServerSeq > lastReadSeq). Treat this like a switchToBot
          // entry — trigger unread read-aloud instead of silently consuming.
          const msgs = chatStore.getMessages(id);
          const unreadCount = msgs.filter(m =>
            m.role === 'assistant' && m.serverSeq && m.serverSeq > lastRead
            && shouldIncludeMsg(m) && m.sourceChannel !== 'terminal'
          ).length;
          if (unreadCount > 0 && isAutoReadEnabled()) {
            bus.emit('chat:auto-read-unread', { botId: id, count: unreadCount });
          }
          // If autoRead is off, do NOT advance lastReadSeq — preserve the
          // server value so subsequent sync-path events count correctly.
          if (!isAutoReadEnabled()) {
            renderChat(id);
            return;
          }
        }
      }

      renderChat(id);

      // --- Sync-path TTS: read new assistant messages that arrived via
      //     history sync.  Uses lastReadSeq as the boundary — messages
      //     with serverSeq > lastReadSeq are "unread" and get read aloud.
      //     Skip on first init to avoid reading entire history.
      const turnState = botTurnState.get(id);
      const isActiveTurn = turnState === 'receiving' || turnState === 'awaiting';
      if (
        !wasFirstInit &&
        isAutoReadEnabled()
      ) {
        const msgs = chatStore.getMessages(id);
        let enqueued = false;
        let maxEnqueuedSeq = 0;
        for (const m of msgs) {
          if (m.role !== 'assistant') continue;
          if (!m.serverSeq || m.serverSeq <= prevReadSeq) continue;
          if (!shouldIncludeMsg(m)) continue;
          if (m.sourceChannel === 'terminal') continue; // tmux-originated, skip TTS
          const escapedKey = m.eventKey ? CSS.escape(m.eventKey) : '';
          const el = escapedKey
            ? document.querySelector(
                `#transcript .msg.assistant[data-event-key="${escapedKey}"]`
              ) as HTMLElement | null
            : document.querySelector(
                '#transcript .msg.assistant:last-of-type'
              ) as HTMLElement | null;
          const ttsText = m.ttsText || m.text;
          if (isTextAlreadyRead(id, ttsText)) continue;
          if (ttsText && el) {
            const chunks = chunkForTTS(ttsText);
            for (const chunk of chunks) {
              autoReadEnqueue(el, '', chunk);
            }
            markTextRead(id, ttsText);
            enqueued = true;
          }
          if (m.serverSeq > maxEnqueuedSeq) maxEnqueuedSeq = m.serverSeq;
        }
        // Advance the pointer past all messages we just enqueued/skipped
        const maxSeq = chatStore.getMaxServerSeq(id);
        if (maxSeq > prevReadSeq) _advanceLastReadSeq(id, maxSeq);
        if (enqueued && isActiveTurn) {
          botTurnState.transition(id, 'speaking');
        }
      } else {
        // Not reading aloud — still advance pointer so these messages
        // aren't retroactively read later.
        const maxSeq = chatStore.getMaxServerSeq(id);
        if (maxSeq > prevReadSeq) _advanceLastReadSeq(id, maxSeq);
      }
    }
  });
  bus.on('chat:delivery-status', (botId: unknown, clientMsgId: unknown, deliveryStatus: unknown) => {
    updateDeliveryStatusDOM(botId as string, clientMsgId as string, deliveryStatus as string);
  });
  // Show cancel-reply button during processing states so user can cancel generation
  const PROCESSING_STATES = ['sending', 'awaiting', 'receiving', 'tts'];
  bus.on('bot:turn-state-change', (evt: unknown) => {
    const { botId, to } = evt as { botId: string; from: string; to: string };
    // Clear stale turn-cancelled flag when a new turn starts, so the
    // ws-dispatcher won't silently drop messages for the new turn.
    if (to === 'sending' && isTurnCancelled(botId)) {
      clearTurnCancelled(botId);
    }
    if (botId !== getCurrentBotId()) return;
    // When a new turn starts on the CURRENT bot, advance lastReadSeq to
    // the current max so that sync-path TTS won't retroactively read old
    // messages that arrived while the user was away (e.g. tmux activity).
    // Only for current bot — non-current bots' unread must stay intact
    // until the user switches to them (INV-BADGE-05).
    if (to === 'sending') {
      const maxSeq = chatStore.getMaxServerSeq(botId);
      _advanceLastReadSeq(botId, maxSeq);
    }
    if (PROCESSING_STATES.includes(to)) {
      setCancelReplyActive(true);
    } else if (to === 'idle') {
      setCancelReplyActive(false);
      // When a turn ends (especially after user interrupt/cancel), advance
      // lastReadSeq so cancelled messages aren't re-read by sync-path TTS.
      const maxSeq = chatStore.getMaxServerSeq(botId);
      _advanceLastReadSeq(botId, maxSeq);
      // Drain deferred history sync — revisions received while bot was busy
      const targets = getHistorySyncTargets();
      if (targets[botId]) {
        syncManager.schedule(botId, 60, targets[botId]);
      }
    }
  });

  // When a bot's turn ends (idle), clear any stale delivery statuses after a delay.
  // Delay ensures we don't prematurely clear statuses for queued messages whose
  // server response hasn't arrived yet (the next turn would start within ~2s).
  const _deliveryCleanupTimers: Record<string, ReturnType<typeof setTimeout>> = {};
  bus.on('bot:turn-state-change', (evt: unknown) => {
    const { botId, to } = evt as { botId: string; from: string; to: string };
    if (to === 'idle') {
      clearTimeout(_deliveryCleanupTimers[botId]);
      _deliveryCleanupTimers[botId] = setTimeout(() => {
        // Only clean up if bot is STILL idle (no new turn started)
        if (botTurnState.get(botId) === 'idle') {
          chatStore.clearProcessingDeliveryStatuses(botId);
        }
      }, 3000);
    } else {
      // New turn started — cancel pending cleanup
      clearTimeout(_deliveryCleanupTimers[botId]);
    }
  });
}
