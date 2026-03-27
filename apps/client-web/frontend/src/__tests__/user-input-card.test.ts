/**
 * User input card unit tests
 *
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock('../network/ws-client', () => ({
  send: vi.fn(),
}));

vi.mock('../ui/chat-renderer', () => ({
  addBotMsg: vi.fn(),
}));

vi.mock('../i18n', () => ({
  t: (key: string) => key,
}));

vi.mock('../logging/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { showUserInputCard, dismissUserInputCard, type UserInputRequest } from '../ui/user-input-card';
import { send } from '../network/ws-client';

const BOT = 'test-bot';

describe('user-input-card', () => {
  let transcript: HTMLDivElement;

  beforeEach(() => {
    // jsdom does not implement scrollIntoView
    Element.prototype.scrollIntoView = vi.fn();

    transcript = document.createElement('div');
    transcript.id = 'transcript';
    document.body.appendChild(transcript);
    vi.clearAllMocks();
  });

  afterEach(() => {
    transcript.remove();
  });

  // ── Helpers ──────────────────────────────────────────────────────

  function makeAskUserOptions(): UserInputRequest {
    return {
      kind: 'ask_user',
      eventKey: 'evt-1',
      questions: [
        {
          question: 'Pick a color',
          header: 'Color choice',
          options: [
            { label: 'Red', description: 'A warm color' },
            { label: 'Blue', description: 'A cool color' },
          ],
        },
      ],
    };
  }

  function makeAskUserOpen(): UserInputRequest {
    return {
      kind: 'ask_user',
      eventKey: 'evt-2',
      questions: [
        {
          question: 'What is your name?',
          options: [],
        },
      ],
    };
  }

  function makePlanOptions(): UserInputRequest {
    return {
      kind: 'plan_options',
      eventKey: 'evt-3',
      planSummary: 'Refactor the widget module',
      allowedPrompts: [
        { tool: 'approve', prompt: 'Yes, proceed' },
        { tool: 'edit', prompt: 'Edit plan' },
      ],
    };
  }

  // ── Tests ────────────────────────────────────────────────────────

  it('renders ask_user card with option buttons', () => {
    showUserInputCard(BOT, makeAskUserOptions());

    const card = transcript.querySelector('.user-input-card') as HTMLElement;
    expect(card).toBeTruthy();
    expect(card.dataset.botId).toBe(BOT);

    const btns = card.querySelectorAll('.user-input-option-btn');
    expect(btns).toHaveLength(2);
    expect(btns[0].querySelector('.option-label')!.textContent).toBe('Red');
    expect(btns[1].querySelector('.option-label')!.textContent).toBe('Blue');
  });

  it('renders ask_user card with textarea for open questions', () => {
    showUserInputCard(BOT, makeAskUserOpen());

    const card = transcript.querySelector('.user-input-card') as HTMLElement;
    expect(card).toBeTruthy();

    const textarea = card.querySelector('.user-input-textarea') as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    expect(textarea.tagName).toBe('TEXTAREA');
    // No option buttons for open questions
    expect(card.querySelectorAll('.user-input-option-btn')).toHaveLength(0);
  });

  it('renders plan_options card with prompt buttons and reject button', () => {
    showUserInputCard(BOT, makePlanOptions());

    const card = transcript.querySelector('.user-input-card') as HTMLElement;
    expect(card).toBeTruthy();

    const planBtns = card.querySelectorAll('.user-input-plan-btn');
    expect(planBtns).toHaveLength(2);
    expect(planBtns[0].textContent).toBe('Yes, proceed');
    expect(planBtns[1].textContent).toBe('Edit plan');

    const rejectBtn = card.querySelector('.user-input-reject-btn');
    expect(rejectBtn).toBeTruthy();
    expect(rejectBtn!.textContent).toBe('input_card.reject');
  });

  it('clicking an option selects it (adds .selected class)', () => {
    showUserInputCard(BOT, makeAskUserOptions());

    const btns = transcript.querySelectorAll('.user-input-option-btn');
    const redBtn = btns[0] as HTMLButtonElement;
    const blueBtn = btns[1] as HTMLButtonElement;

    // Click Red
    redBtn.click();
    expect(redBtn.classList.contains('selected')).toBe(true);
    expect(blueBtn.classList.contains('selected')).toBe(false);

    // Click Blue — single-select, Red should deselect
    blueBtn.click();
    expect(redBtn.classList.contains('selected')).toBe(false);
    expect(blueBtn.classList.contains('selected')).toBe(true);
  });

  it('clicking submit sends the correct user_input_reply message via ws', () => {
    showUserInputCard(BOT, makeAskUserOptions());

    // Select "Red"
    const redBtn = transcript.querySelector('.user-input-option-btn') as HTMLButtonElement;
    redBtn.click();

    // Click submit
    const submitBtn = transcript.querySelector('.user-input-submit-btn') as HTMLButtonElement;
    submitBtn.click();

    expect(send).toHaveBeenCalledWith({
      type: 'user_input_reply',
      botId: BOT,
      eventKey: 'evt-1',
      replyText: 'Red',
    });
  });

  it('clicking a plan option sends the correct reply', () => {
    showUserInputCard(BOT, makePlanOptions());

    const planBtns = transcript.querySelectorAll('.user-input-plan-btn');
    (planBtns[0] as HTMLButtonElement).click();

    expect(send).toHaveBeenCalledWith({
      type: 'user_input_reply',
      botId: BOT,
      eventKey: 'evt-3',
      replyText: 'Yes, proceed',
    });
  });

  it('dismissUserInputCard removes card from DOM', () => {
    showUserInputCard(BOT, makeAskUserOptions());
    expect(transcript.querySelector('.user-input-card')).toBeTruthy();

    dismissUserInputCard(BOT);
    expect(transcript.querySelector('.user-input-card')).toBeNull();
  });

  it('showing a new card for the same bot replaces the old one', () => {
    showUserInputCard(BOT, makeAskUserOptions());
    const firstCard = transcript.querySelector('.user-input-card');
    expect(firstCard).toBeTruthy();

    showUserInputCard(BOT, makePlanOptions());
    // Old card gone, new card present
    const cards = transcript.querySelectorAll('.user-input-card');
    expect(cards).toHaveLength(1);
    // New card should be plan_options (has .user-input-plan-btn)
    expect(cards[0].querySelector('.user-input-plan-btn')).toBeTruthy();
  });

  it('dismissing a non-existent card is a no-op (does not throw)', () => {
    expect(() => dismissUserInputCard('nonexistent-bot')).not.toThrow();
  });
});
