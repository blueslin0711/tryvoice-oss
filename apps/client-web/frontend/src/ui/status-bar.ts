// Status bar — compact text display with animated dots

import { t } from '../i18n';

const statusEl = document.getElementById('status');

let _statusWriteLocked = false;
let _statusBaseText = '';
let _statusDotsPhase = 1;
let _statusDotsTimer: ReturnType<typeof setInterval> | null = null;
let _revertTimer: ReturnType<typeof setTimeout> | null = null;
let _defaultText = '';
const REVERT_DELAY_MS = 2500;

// Transient statuses auto-revert to default after REVERT_DELAY_MS
function _isTransient(text: string): boolean {
  const TRANSIENT = [
    t('status.stopped_reading'), t('status.not_heard'), t('status.stt_failed'),
    t('status.recording_too_short'), t('status.cancelled'),
    t('status.reset_done'), t('status.reset_failed'),
    t('status.reset_timeout'), t('status.sync_failed'),
    t('status.echo_suspected'),
  ];
  return TRANSIENT.includes(text);
}

function _isStatusAnimating(base: string): boolean {
  if (!base) return false;
  const ANIMATED_STATUSES = [
    t('status.processing'), t('status.generating'), t('status.speaking'),
    t('status.thinking'), t('status.recognizing'), t('status.listening'),
    t('status.reconnecting'), t('status.waiting_mic'), t('status.waiting_wakeword'),
    t('status.initializing'),
  ];
  return ANIMATED_STATUSES.includes(base);
}

function _renderStatusText(base: string): string {
  const b = String(base || '').trim();
  if (!b) return '';
  if (!_isStatusAnimating(b)) return b;
  const dots = '.'.repeat(Math.max(1, Math.min(3, _statusDotsPhase)));
  return `${b}${dots}`;
}

function _startStatusDots(): void {
  if (_statusDotsTimer) return;
  _statusDotsTimer = setInterval(() => {
    if (!statusEl) return;
    if (!_isStatusAnimating(_statusBaseText)) return;
    _statusDotsPhase = (_statusDotsPhase % 3) + 1;
    _statusWriteLocked = true;
    statusEl.textContent = _renderStatusText(_statusBaseText);
    _statusWriteLocked = false;
  }, 420);
}

function _stopStatusDots(): void {
  if (_statusDotsTimer) clearInterval(_statusDotsTimer);
  _statusDotsTimer = null;
}

export function compactStatusText(raw: string, defaultText: string): string {
  const src = String(raw || '').trim();
  if (!src) return defaultText;
  const txt = src.replace(/\s+/g, '').replace(/[.。…]+$/g, '');

  if (txt.includes('前面还有一条在处理') && txt.includes('重置')) return t('status.processing');
  if (txt.includes('前面还有一条在处理') || txt.includes('已排队')) return t('status.processing');
  if (txt.includes('会话已重置') || /sessionreset/i.test(txt)) return t('status.reset_done');
  if (txt.includes('重置失败') || /resetfailed/i.test(txt)) return t('status.reset_failed');
  if (txt.includes('重置确认超时') || /resettimeout/i.test(txt)) return t('status.reset_timeout');
  if (txt.includes('连接断开') || txt.includes('重连中') || /reconnecting|disconnected/i.test(txt)) return t('status.reconnecting');
  if (txt.includes('已切换到') || /switchedto/i.test(txt)) return defaultText;
  if (txt.includes('思考中') || /thinking/i.test(txt)) return t('status.thinking');
  if (txt.includes('生成语音') || txt.includes('生成回复') || txt.includes('生成中') || txt.includes('生成') || /generating/i.test(txt)) return t('status.generating');
  if (txt.includes('还在处理') || txt.includes('处理中') || /processing/i.test(txt)) return t('status.processing');
  if (txt.includes('识别中') || /recognizing/i.test(txt)) return t('status.recognizing');
  if (txt.includes('正在听') || /listening/i.test(txt)) return t('status.listening');
  if (txt.includes('在说') || txt.includes('朗读中') || /speaking/i.test(txt)) return t('status.speaking');
  if (txt.includes('已停止朗读') || /stoppedreading/i.test(txt)) return t('status.stopped_reading');
  if (txt.includes('会话重置后同步失败') || /syncfailed/i.test(txt)) return t('status.sync_failed');
  if (txt.includes('没听清') || /notheard/i.test(txt)) return t('status.not_heard');
  if (txt.includes('语音识别失败') || /sttfailed|speechrecognitionfailed/i.test(txt)) return t('status.stt_failed');
  if (txt.includes('录音太短') || /recordingtooshort/i.test(txt)) return t('status.recording_too_short');
  if (txt.includes('麦克风权限被拒绝') || /microphonepermissiondenied/i.test(txt)) return t('status.no_mic_permission');
  if (txt.includes('请求麦克风权限') || /requestingmicrophone/i.test(txt)) return t('status.waiting_mic');
  if (txt.includes('已取消录音') || /cancelled|canceled/i.test(txt)) return t('status.cancelled');
  if (txt.includes('疑似回声') || /echosuspected/i.test(txt)) return t('status.echo_suspected');
  if (txt.includes('唤醒词失败') || /wakeworkfailed/i.test(txt)) return t('status.wakeword_failed');
  if (
    /^\[\d+\/\d+\]/.test(txt)
    || txt.includes('准备唤醒词')
    || txt.includes('加载唤醒词')
    || txt.includes('加载openWakeWord')
    || txt.includes('加载语言模型')
    || txt.includes('初始化唤醒词')
    || txt.includes('正在初始化')
    || txt.includes('Initializing')
    || txt.includes('启动语音监听')
  ) return t('status.initializing');
  if ((txt.includes('说"') && txt.includes('开始')) || /say".*tostart/i.test(txt)) return t('status.waiting_wakeword');
  if ((txt.includes('点击') && txt.includes('说话')) || /clicktotalk/i.test(txt)) return t('status.click_to_talk');

  const cleaned = txt
    .replace(/^🔴|^🔊|^🔄/g, '')
    .replace(/[.。!！?？…]+$/g, '')
    .trim();
  if (!cleaned) return defaultText;
  if (cleaned.length <= 5) return cleaned;
  return cleaned.slice(0, 5);
}

export function setStatusText(raw: string, defaultText: string): void {
  if (!statusEl) return;
  _defaultText = defaultText;
  const next = compactStatusText(raw, defaultText);
  if (_statusBaseText === next) return;
  _statusBaseText = next;
  _statusDotsPhase = 1;
  if (_isStatusAnimating(_statusBaseText)) _startStatusDots();
  else _stopStatusDots();
  _statusWriteLocked = true;
  statusEl.textContent = _renderStatusText(_statusBaseText);
  _statusWriteLocked = false;

  // Auto-revert transient statuses
  if (_revertTimer) { clearTimeout(_revertTimer); _revertTimer = null; }
  if (_isTransient(next)) {
    _revertTimer = setTimeout(() => {
      _revertTimer = null;
      setStatusText(_defaultText, _defaultText);
    }, REVERT_DELAY_MS);
  }
}

export function bindStatusCompactor(getDefaultText: () => string): void {
  if (!statusEl) return;
  const observer = new MutationObserver(() => {
    if (_statusWriteLocked) return;
    setStatusText(statusEl.textContent || '', getDefaultText());
  });
  observer.observe(statusEl, { childList: true, characterData: true, subtree: true });
  setStatusText(statusEl.textContent || getDefaultText(), getDefaultText());
}
