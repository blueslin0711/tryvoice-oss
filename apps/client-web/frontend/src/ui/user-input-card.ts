// User input card — renders interactive prompts from Claude Code
// (AskUserQuestion / ExitPlanMode) in the chat transcript

import { createLogger } from '../logging/logger';
import { t } from '../i18n';
import * as ws from '../network/ws-client';
import { addBotMsg } from './chat-renderer';

const log = createLogger('ui.user-input-card');

// Track active cards per bot to support auto-dismiss
const _activeCards: Record<string, HTMLElement> = {};

// ── Types ───────────────────────────────────────────────────────────

interface AskUserQuestion {
  question: string;
  header?: string;
  options: Array<{ label: string; description: string }>;
  multiSelect?: boolean;
}

interface PlanPrompt {
  tool: string;
  prompt: string;
}

export type UserInputRequest =
  | { kind: 'ask_user'; questions: AskUserQuestion[]; eventKey: string }
  | { kind: 'plan_options'; planSummary: string; allowedPrompts: PlanPrompt[]; eventKey: string }
  | { kind: 'permission'; toolName: string; toolDescription: string; eventKey: string };

// ── Public API ──────────────────────────────────────────────────────

export function showUserInputCard(botId: string, req: UserInputRequest): void {
  // Dismiss any existing card for this bot first
  dismissUserInputCard(botId);

  log.info('Showing user input card', { botId, kind: req.kind });

  const card = document.createElement('div');
  card.className = 'user-input-card';
  card.dataset.botId = botId;

  const header = document.createElement('div');
  header.className = 'user-input-card-header';
  header.textContent = t('input_card.waiting_header') || 'Claude is waiting for your input';
  card.appendChild(header);

  if (req.kind === 'ask_user') {
    _renderAskUser(card, botId, req);
  } else if (req.kind === 'permission') {
    _renderPermission(card, botId, req);
  } else {
    _renderPlanOptions(card, botId, req);
  }

  // Insert card into transcript
  const transcript = document.getElementById('transcript');
  if (transcript) {
    transcript.appendChild(card);
    card.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }
  _activeCards[botId] = card;
}

export function dismissUserInputCard(botId: string): void {
  const card = _activeCards[botId];
  if (card) {
    card.remove();
    delete _activeCards[botId];
  }
}

// ── Renderers ───────────────────────────────────────────────────────

function _renderAskUser(
  card: HTMLElement,
  botId: string,
  req: Extract<UserInputRequest, { kind: 'ask_user' }>,
): void {
  const selections: Record<number, string[]> = {};
  const textInputs: Record<number, HTMLTextAreaElement> = {};

  req.questions.forEach((q, idx) => {
    const qBlock = document.createElement('div');
    qBlock.className = 'user-input-question';

    if (q.header) {
      const hdr = document.createElement('div');
      hdr.className = 'user-input-question-header';
      hdr.textContent = q.header;
      qBlock.appendChild(hdr);
    }

    const qText = document.createElement('div');
    qText.className = 'user-input-question-text';
    qText.textContent = q.question;
    qBlock.appendChild(qText);

    if (q.options && q.options.length > 0) {
      selections[idx] = [];
      const optGroup = document.createElement('div');
      optGroup.className = 'user-input-options';

      q.options.forEach((opt) => {
        const btn = document.createElement('button');
        btn.className = 'user-input-option-btn';
        btn.type = 'button';

        const labelSpan = document.createElement('span');
        labelSpan.className = 'option-label';
        labelSpan.textContent = opt.label;
        btn.appendChild(labelSpan);

        if (opt.description) {
          const descSpan = document.createElement('span');
          descSpan.className = 'option-description';
          descSpan.textContent = opt.description;
          btn.appendChild(descSpan);
        }

        btn.addEventListener('click', () => {
          if (q.multiSelect) {
            btn.classList.toggle('selected');
            const sel = selections[idx]!;
            const i = sel.indexOf(opt.label);
            if (i >= 0) sel.splice(i, 1);
            else sel.push(opt.label);
          } else {
            // Single select: deselect siblings
            optGroup.querySelectorAll('.user-input-option-btn').forEach((b) => b.classList.remove('selected'));
            btn.classList.add('selected');
            selections[idx] = [opt.label];
          }
        });

        optGroup.appendChild(btn);
      });
      qBlock.appendChild(optGroup);
    } else {
      // Free-text input
      const textarea = document.createElement('textarea');
      textarea.className = 'user-input-textarea';
      textarea.placeholder = t('input_card.type_answer') || 'Type your answer...';
      textarea.rows = 2;
      textInputs[idx] = textarea;
      qBlock.appendChild(textarea);
    }

    card.appendChild(qBlock);
  });

  // Submit button
  const submitBtn = document.createElement('button');
  submitBtn.className = 'user-input-submit-btn';
  submitBtn.type = 'button';
  submitBtn.textContent = t('input_card.submit') || 'Submit';
  submitBtn.addEventListener('click', () => {
    const parts: string[] = [];
    req.questions.forEach((q, idx) => {
      if (selections[idx] && selections[idx].length > 0) {
        parts.push(selections[idx].join(', '));
      } else if (textInputs[idx]) {
        parts.push(textInputs[idx].value.trim() || '(no answer)');
      }
    });
    const replyText = parts.join('\n');
    _submitReply(botId, req.eventKey, replyText);
  });
  card.appendChild(submitBtn);
}

function _renderPlanOptions(
  card: HTMLElement,
  botId: string,
  req: Extract<UserInputRequest, { kind: 'plan_options' }>,
): void {
  // Show plan summary if present
  if (req.planSummary) {
    const summary = document.createElement('pre');
    summary.className = 'user-input-plan-summary';
    summary.textContent = req.planSummary.length > 500
      ? req.planSummary.slice(0, 500) + '...'
      : req.planSummary;
    card.appendChild(summary);
  }

  const optGroup = document.createElement('div');
  optGroup.className = 'user-input-plan-options';

  req.allowedPrompts.forEach((ap) => {
    const btn = document.createElement('button');
    btn.className = 'user-input-plan-btn';
    btn.type = 'button';
    btn.textContent = ap.prompt;
    btn.addEventListener('click', () => {
      _submitReply(botId, req.eventKey, ap.prompt);
    });
    optGroup.appendChild(btn);
  });

  // Reject button
  const rejectBtn = document.createElement('button');
  rejectBtn.className = 'user-input-reject-btn';
  rejectBtn.type = 'button';
  rejectBtn.textContent = t('input_card.reject') || 'Reject';
  rejectBtn.addEventListener('click', () => {
    _submitReply(botId, req.eventKey, 'reject');
  });
  optGroup.appendChild(rejectBtn);

  card.appendChild(optGroup);
}

function _renderPermission(
  card: HTMLElement,
  botId: string,
  req: Extract<UserInputRequest, { kind: 'permission' }>,
): void {
  const desc = document.createElement('div');
  desc.className = 'user-input-permission-desc';
  desc.innerHTML = `<strong>${_escapeHtml(req.toolName)}</strong>: <code>${_escapeHtml(req.toolDescription)}</code>`;
  card.appendChild(desc);

  const actions = document.createElement('div');
  actions.className = 'user-input-card-actions';

  const allowBtn = document.createElement('button');
  allowBtn.className = 'user-input-btn user-input-btn-primary';
  allowBtn.textContent = t('input_card.allow') || 'Allow';
  allowBtn.onclick = () => _submitReply(botId, req.eventKey, 'allow');

  const denyBtn = document.createElement('button');
  denyBtn.className = 'user-input-btn user-input-btn-danger';
  denyBtn.textContent = t('input_card.deny') || 'Deny';
  denyBtn.onclick = () => _submitReply(botId, req.eventKey, 'deny');

  actions.appendChild(allowBtn);
  actions.appendChild(denyBtn);
  card.appendChild(actions);
}

function _escapeHtml(s: string): string {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

// ── Submit ──────────────────────────────────────────────────────────

function _submitReply(botId: string, eventKey: string, replyText: string): void {
  log.info('Submitting user input reply', { botId, len: replyText.length });
  ws.send({
    type: 'user_input_reply',
    botId,
    eventKey,
    replyText,
  });
  dismissUserInputCard(botId);
  addBotMsg(botId, 'user', replyText, { persist: true });
}
