// Slot/tab management — bootstrap from server, render tabs, handle switching
// Includes bot management UI: add, edit (delete), drag-and-drop reorder

import { BOT_IDS, setRuntimeBotIds, STORAGE_KEY } from '../core/types';
import {
  getCurrentBotId, setCurrentBotId, getBotNames, setBotNames,
  getBotSuffixes, setBotSuffix,
  getInputMode, ensureRuntimeBotState, interruptBot,
} from './app-state';
import { micState } from '../state/mic-state';
import { syncManager } from '../network/sync';
import { prefetchVoiceFeedback, updateBadges } from './mic-ui';
import { restartWakeWordListening, removeWwMappingForBot } from '../wakeword/wakeword-manager';
import { t } from '../i18n';
import { openSetupWizard } from './setup-wizard';
import { bus } from '../core/event-bus';
import { botTurnState } from '../state/bot-turn-state';

type SlotInfo = {
  slotId: string;
  name: string;
  sessionKey?: string;
};

type SlotStatus = 'connected' | 'warming' | 'disconnected' | 'stale' | 'unknown'
  | 'turn-recording' | 'turn-processing' | 'turn-speaking';

const botTabsRoot = document.getElementById('bot-tabs');
let _editMode = false;
let _onSwitchCb: ((botId: string) => void) | null = null;
let _lastSlots: SlotInfo[] = [];
let _statusPollTimer: ReturnType<typeof setInterval> | null = null;

const TAB_ORDER_KEY = STORAGE_KEY + 'botTabOrder';

/** Persist current bot tab order to localStorage */
function _saveTabOrder(): void {
  try { localStorage.setItem(TAB_ORDER_KEY, JSON.stringify([...BOT_IDS])); } catch (_e) { /* silent */ }
}

/** Load saved bot tab order from localStorage, returns null if none saved */
function _loadTabOrder(): string[] | null {
  try {
    const raw = localStorage.getItem(TAB_ORDER_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch (_e) { return null; }
}

/**
 * Apply saved tab order to a set of bot IDs.
 * IDs present in saved order come first (in saved order),
 * followed by any new IDs not in the saved order (preserving server order).
 * IDs in the saved order but not in the current set are ignored.
 */
function _applySavedOrder(ids: string[]): string[] {
  const saved = _loadTabOrder();
  if (!saved || saved.length === 0) return ids;
  const idSet = new Set(ids);
  const ordered: string[] = [];
  // Add IDs from saved order that still exist
  for (const id of saved) {
    if (idSet.has(id)) {
      ordered.push(id);
      idSet.delete(id);
    }
  }
  // Append any new IDs not in the saved order
  for (const id of ids) {
    if (idSet.has(id)) ordered.push(id);
  }
  return ordered;
}

export function currentDefaultBotId(): string {
  return BOT_IDS[0] || 'main';
}

export function renderBotTabs(): void {
  if (!botTabsRoot) return;
  const names = getBotNames();
  const current = getCurrentBotId();
  botTabsRoot.innerHTML = '';

  for (const botId of BOT_IDS) {
    const tab = document.createElement('div');
    tab.className = 'bot-tab' + (botId === current ? ' active' : '');
    tab.dataset.bot = botId;
    tab.draggable = true;
    const suffix = getBotSuffixes()[botId] || '';
    tab.innerHTML = `
      <img class="tab-avatar" alt="${t('tab.avatar_alt', { name: names[botId] || botId })}" style="display:none">
      <span class="tab-avatar-emoji">\u{1F916}</span>
      <span class="tab-name">${names[botId] || botId}</span>${suffix ? `<span class="tab-suffix">(${suffix})</span>` : ''}
      <span class="badge"></span>
      <span class="bot-status-dot" data-status="unknown"></span>
    `;

    // Edit mode: add red delete button
    if (_editMode) {
      const delBtn = document.createElement('button');
      delBtn.className = 'bot-tab-delete';
      delBtn.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16"><line x1="4" y1="8" x2="12" y2="8" stroke="#fff" stroke-width="2" stroke-linecap="round"/></svg>';
      delBtn.title = 'Remove bot';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        _removeBot(botId);
      });
      tab.style.position = 'relative';
      tab.appendChild(delBtn);
    }

    // Drag-and-drop events
    tab.addEventListener('dragstart', (e) => {
      if (!e.dataTransfer) return;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', botId);
      tab.classList.add('dragging');
    });
    tab.addEventListener('dragend', () => {
      tab.classList.remove('dragging');
      document.querySelectorAll('.bot-tab.drag-over').forEach(el => el.classList.remove('drag-over'));
    });
    tab.addEventListener('dragover', (e) => {
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      tab.classList.add('drag-over');
    });
    tab.addEventListener('dragleave', () => {
      tab.classList.remove('drag-over');
    });
    tab.addEventListener('drop', (e) => {
      e.preventDefault();
      tab.classList.remove('drag-over');
      const draggedBotId = e.dataTransfer?.getData('text/plain');
      if (!draggedBotId || draggedBotId === botId) return;
      _reorderBot(draggedBotId, botId);
    });

    botTabsRoot.appendChild(tab);
  }

  // Add management buttons
  _renderManagementButtons();
  _bindTabClicks();
  // Restore unread badges after DOM rebuild
  updateBadges();
}

function _renderManagementButtons(): void {
  if (!botTabsRoot) return;
  const container = document.createElement('div');
  container.className = 'bot-tab-actions';
  container.innerHTML = `
    <button class="bot-tab-action-btn bot-tab-add-btn" title="Add bot">
      <svg width="14" height="14" viewBox="0 0 14 14"><line x1="7" y1="2" x2="7" y2="12" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><line x1="2" y1="7" x2="12" y2="7" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
    </button>
    <button class="bot-tab-action-btn bot-tab-edit-btn ${_editMode ? 'active' : ''}" title="Edit bots">
      <svg width="14" height="14" viewBox="0 0 14 14"><path d="M2 10.5V12h1.5l5.9-5.9-1.5-1.5L2 10.5zM12.7 4.3a.5.5 0 000-.7l-1.3-1.3a.5.5 0 00-.7 0L9.5 3.5l1.5 1.5 1.7-1.7z" fill="currentColor"/></svg>
    </button>
  `;

  container.querySelector('.bot-tab-add-btn')!.addEventListener('click', (e) => {
    e.stopPropagation();
    openSetupWizard();
  });
  container.querySelector('.bot-tab-edit-btn')!.addEventListener('click', (e) => {
    e.stopPropagation();
    _editMode = !_editMode;
    renderBotTabs();
  });

  botTabsRoot.appendChild(container);
}

function _bindTabClicks(): void {
  if (!_onSwitchCb) return;
  const cb = _onSwitchCb;
  document.querySelectorAll('.bot-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      if (_editMode) return; // In edit mode, don't switch
      const botId = (tab as HTMLElement).dataset.bot;
      if (!botId) return;
      cb(botId);
      syncManager.schedule(botId, 60);
      if (getInputMode() === 'wakeword') prefetchVoiceFeedback(botId);
      if (getInputMode() === 'wakeword') restartWakeWordListening('bot tab click');
    });
  });
}

async function _removeBot(botId: string): Promise<void> {
  const idx = BOT_IDS.indexOf(botId);
  if (idx === -1) return;

  // Clean up active state before deletion (ISSUE-15)
  if (micState.isActive && micState.context?.botId === botId) {
    micState.cancelRecording();
  }
  interruptBot(botId);

  // Call backend API
  try {
    await fetch(`/slots/${encodeURIComponent(botId)}`, { method: 'DELETE' });
  } catch (_e) { /* proceed with local removal */ }

  const newIds = BOT_IDS.filter(id => id !== botId);
  setRuntimeBotIds(newIds);
  _saveTabOrder();
  ensureRuntimeBotState(newIds);

  // If active bot was removed, perform full switch (not just setCurrentBotId)
  // so that renderChat, syncStatusDisplay, resetScrollSession, badge clear,
  // and auto-read-unread all fire. Emit before setCurrentBotId so
  // switchToBot's same-bot guard doesn't block.
  if (getCurrentBotId() === botId) {
    bus.emit('bot:switch', currentDefaultBotId());
  }
  _lastSlots = _lastSlots.filter(s => s.slotId !== botId);

  // Clean up wake word mapping and restart listener
  removeWwMappingForBot(botId);
  if (getInputMode() === 'wakeword') restartWakeWordListening('bot removed');

  renderBotTabs();

  // Notify slot order change
  _syncSlotOrder();

  // No bots left — open setup wizard so user can add one
  if (BOT_IDS.length === 0) {
    setTimeout(() => openSetupWizard(), 300);
  }
}

async function _reorderBot(draggedId: string, targetId: string): Promise<void> {
  const fromIdx = BOT_IDS.indexOf(draggedId);
  const toIdx = BOT_IDS.indexOf(targetId);
  if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;

  const ids = [...BOT_IDS];
  ids.splice(fromIdx, 1);
  ids.splice(toIdx, 0, draggedId);
  setRuntimeBotIds(ids);
  _saveTabOrder();
  renderBotTabs();
  _syncSlotOrder();
}

async function _syncSlotOrder(): Promise<void> {
  const names = getBotNames();
  const slots = BOT_IDS.map(id => ({ slotId: id, name: names[id] || id }));
  try {
    await fetch('/slots', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ slots }),
    });
  } catch (_e) { /* silent — backend may not support this yet */ }
}

function _isDefaultEchoBotOnly(slots: SlotInfo[]): boolean {
  if (slots.length === 0) return true;
  if (slots.length === 1 && slots[0].slotId === 'echo') return true;
  return false;
}

export function bindBotTabs(onSwitch: (botId: string) => void): void {
  _onSwitchCb = onSwitch;
  _bindTabClicks();
}

export async function bootstrapSlots(): Promise<void> {
  let needsWizard = false;
  try {
    const resp = await fetch('/slots');
    if (!resp.ok) throw new Error('/slots fetch failed');
    const data = await resp.json();
    const slots = Array.isArray(data?.slots) ? data.slots : [];
    const normalized: SlotInfo[] = [];
    for (const item of slots) {
      const slotId = String(item?.slotId || '').trim();
      if (!slotId) continue;
      const name = String(item?.name || slotId).trim() || slotId;
      const sessionKey = String(item?.sessionKey || '').trim();
      normalized.push({ slotId, name, sessionKey });
    }
    _lastSlots = normalized;

    if (_isDefaultEchoBotOnly(normalized)) {
      needsWizard = true;
    }

    if (!normalized.length) throw new Error('empty slots');

    const ids = _applySavedOrder(normalized.map((s) => s.slotId));
    setRuntimeBotIds(ids);
    ensureRuntimeBotState(ids);

    const names: Record<string, string> = {};
    for (const slot of normalized) {
      names[slot.slotId] = slot.name;
      // For Claude Code bots, store the short tmux session ID as a
      // non-editable suffix so users can match the tab to the visible
      // "vs-claude-XXXXXXXX" Terminal.app window.
      if (slot.sessionKey?.startsWith('claude:')) {
        const shortId = slot.sessionKey.slice(7, 15); // first 8 chars of UUID
        setBotSuffix(slot.slotId, shortId);
      }
    }
    setBotNames(names);
    if (!BOT_IDS.includes(getCurrentBotId())) {
      setCurrentBotId(currentDefaultBotId());
    }
  } catch (_e) {
    // Don't populate fake bots — show error state with retry
    _renderSlotsError();
    return;
  }

  renderBotTabs();
  _startStatusPolling();
  _wireTurnIndicator();

  // Show wizard if only default/echo bot configured
  if (needsWizard) {
    setTimeout(() => openSetupWizard(), 300);
  }
}

function _renderSlotsError(): void {
  if (!botTabsRoot) return;
  botTabsRoot.innerHTML = '';
  const msg = document.createElement('div');
  msg.className = 'slots-error';
  msg.innerHTML = `
    <span>${t('slots.load_failed')}</span>
    <button class="slots-retry-btn">${t('slots.retry')}</button>
  `;
  msg.querySelector('.slots-retry-btn')!.addEventListener('click', () => {
    bootstrapSlots();
  });
  botTabsRoot.appendChild(msg);
}

export function setActiveTab(botId: string): void {
  document.querySelectorAll('.bot-tab').forEach(t => t.classList.remove('active'));
  const tab = document.querySelector(`.bot-tab[data-bot="${botId}"]`);
  tab?.classList.add('active');
  tab?.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
}

function _applyStatusDots(statuses: Record<string, string>): void {
  document.querySelectorAll<HTMLElement>('.bot-tab').forEach(tab => {
    const botId = tab.dataset.bot;
    if (!botId) return;
    const dot = tab.querySelector<HTMLElement>('.bot-status-dot');
    if (!dot) return;
    const raw = statuses[botId] ?? 'unknown';
    // Backend reports "processing" when bot is in an active turn — map to turn-processing
    if (raw === 'processing') {
      if (!_isTurnDotStatus(dot.dataset.status)) {
        dot.dataset.status = 'turn-processing';
      }
      return;
    }
    const status = raw as SlotStatus;
    _lastConnectionStatus[botId] = status;
    // Don't overwrite turn indicators set by turn-state-change event
    if (!_isTurnDotStatus(dot.dataset.status)) {
      dot.dataset.status = status;
    }
  });
}

async function _pollSlotStatuses(): Promise<void> {
  try {
    const resp = await fetch('/slots/status');
    if (!resp.ok) return;
    const data = await resp.json();
    if (data?.statuses) _applyStatusDots(data.statuses);
  } catch {
    // Silent — status dots just stay in last known state
  }
}

function _startStatusPolling(): void {
  if (_statusPollTimer) clearInterval(_statusPollTimer);
  // Immediate first fetch, then every 5s
  _pollSlotStatuses();
  _statusPollTimer = setInterval(_pollSlotStatuses, 5000);
}

// --- Turn state indicator on bot status dot ---
// Mirrors the mic area visual states as a miniature on each bot card:
//   recording (red) / processing (orange spinner) / speaking (green)
// Reverts to connection status when bot returns to idle.

const TURN_DOT_STATUSES = ['turn-recording', 'turn-processing', 'turn-speaking'] as const;
type TurnDotStatus = typeof TURN_DOT_STATUSES[number];

// Map BotTurnState values to dot visual states (same logic as projectCssClass)
function _turnStateToDot(turnState: string): TurnDotStatus | null {
  if (turnState === 'listening') return 'turn-recording';
  if (['stt', 'sending', 'awaiting', 'receiving', 'tts'].includes(turnState)) return 'turn-processing';
  if (turnState === 'speaking') return 'turn-speaking';
  return null; // idle
}

const _lastConnectionStatus: Record<string, SlotStatus> = {};
let _turnWired = false;

function _isTurnDotStatus(status: string | undefined): boolean {
  return TURN_DOT_STATUSES.includes(status as TurnDotStatus);
}

// Track which bot is currently being read aloud by the audio player.
// Set on audio:state 'start' (from msgEl's closest bot tab), cleared on 'end'/'pause'.
const _audioPlayingBot: { id: string | null } = { id: null };

function _setDot(botId: string, status: string): void {
  const tab = document.querySelector<HTMLElement>(`.bot-tab[data-bot="${botId}"]`);
  const dot = tab?.querySelector<HTMLElement>('.bot-status-dot');
  if (!dot) return;
  const cur = dot.dataset.status;
  if (cur && !_isTurnDotStatus(cur)) _lastConnectionStatus[botId] = cur as SlotStatus;
  dot.dataset.status = status;
}

function _restoreDot(botId: string): void {
  const tab = document.querySelector<HTMLElement>(`.bot-tab[data-bot="${botId}"]`);
  const dot = tab?.querySelector<HTMLElement>('.bot-status-dot');
  if (!dot) return;
  dot.dataset.status = _lastConnectionStatus[botId] || 'connected';
}

function _wireTurnIndicator(): void {
  if (_turnWired) return;
  _turnWired = true;

  bus.on('bot:turn-state-change', (evt: unknown) => {
    const { botId, to } = evt as { botId: string; from: string; to: string };
    // If audio is playing for this bot, speaking state takes priority —
    // don't let turn state changes (e.g. receiving) override the dot.
    if (_audioPlayingBot.id === botId && to !== 'idle') return;

    const dotStatus = _turnStateToDot(to);
    if (dotStatus) {
      _setDot(botId, dotStatus);
    } else {
      _restoreDot(botId);
    }
  });

  // Audio player state overrides: when audio is actively playing,
  // show turn-speaking regardless of botTurnState (which may be 'receiving'
  // if the agent is still generating while TTS reads earlier chunks).
  bus.on('audio:state', (evt: unknown) => {
    const e = evt as { state: string; msgEl: HTMLElement | null; phase: string };
    if (e.phase === 'start' && e.msgEl) {
      // Determine which bot this message belongs to
      const msgBotId = getCurrentBotId();
      _audioPlayingBot.id = msgBotId;
      _setDot(msgBotId, 'turn-speaking');
    } else if (e.phase === 'end' || e.phase === 'pause') {
      const prevBot = _audioPlayingBot.id;
      _audioPlayingBot.id = null;
      if (prevBot) {
        // Restore to current turn state or connection status
        const turnDot = _turnStateToDot(botTurnState.get(prevBot));
        if (turnDot) {
          _setDot(prevBot, turnDot);
        } else {
          _restoreDot(prevBot);
        }
      }
    }
  });
}
