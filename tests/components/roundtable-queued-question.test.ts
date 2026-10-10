// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const audio = vi.hoisted(() => ({
  onTranscription: undefined as ((text: string) => void) | undefined,
}));
vi.mock('@/lib/hooks/use-audio-recorder', () => ({
  useAudioRecorder: (options: { onTranscription: (text: string) => void }) => {
    audio.onTranscription = options.onTranscription;
    return {
      isRecording: false,
      isProcessing: false,
      startRecording: vi.fn(),
      stopRecording: vi.fn(),
      cancelRecording: vi.fn(),
    };
  },
}));
vi.mock('@/lib/hooks/use-asr-available', () => ({ useASRAvailable: () => true }));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/canvas/canvas-toolbar', () => ({ CanvasToolbar: () => null }));
vi.mock('@/components/ui/avatar-display', () => ({ AvatarDisplay: () => null }));
vi.mock('@/components/chat/proactive-card', () => ({ ProactiveCard: () => null }));
vi.mock('@/components/roundtable/presentation-speech-overlay', () => ({
  PresentationSpeechOverlay: () => null,
}));
import { Roundtable, type QueuedQuestionState } from '@/components/roundtable';

const QUESTION = 'Why does the curve flatten?';

describe('Roundtable raised hand (queued question)', () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: Record<string, unknown>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    props = {
      onMessageSend: vi.fn(() => 'queued'),
      onInputActivate: vi.fn(),
      onCancelQueuedQuestion: vi.fn(),
    };
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render(next: Record<string, unknown> = {}) {
    props = { ...props, ...next };
    await act(async () => root.render(createElement(Roundtable, props)));
  }

  function setQueued(
    status: QueuedQuestionState['status'],
    text = QUESTION,
    extra: Partial<QueuedQuestionState> = {},
  ) {
    return render({
      queuedQuestion: { id: 1, text, status, ...extra } satisfies QueuedQuestionState,
    });
  }

  function cancelButton() {
    return [...indicator()!.querySelectorAll('button')].find(
      (button) => button.textContent === 'roundtable.cancelQueuedQuestion',
    )!;
  }

  function textInputToggle() {
    return container.querySelector('button[aria-label="roundtable.textInput"]') as HTMLElement;
  }

  /** Open the input, send a question that raises a hand (starts the send cooldown), focus Cancel. */
  async function raiseHandAndFocusCancel() {
    await render();
    act(() => iconButton('message-square').click());
    typeAndSend(QUESTION);
    await setQueued('queued');
    act(() => cancelButton().focus());
    expect(document.activeElement).toBe(cancelButton());
  }

  function iconButton(icon: string) {
    return container.querySelector(`svg.lucide-${icon}`)!.closest('button') as HTMLElement;
  }

  function typeAndSend(text: string) {
    const input = container.querySelector('textarea')!;
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        input,
        text,
      );
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  }

  function pressWindowKey(key: string) {
    act(() => window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })));
  }

  function indicator() {
    return container.querySelector('[data-testid="roundtable-queued-question"]');
  }

  /** Speech bubble text (a textarea mirrors its value into textContent). */
  function bubbleText() {
    return [...container.querySelectorAll('p')].map((p) => p.textContent).join('\n');
  }

  it('reports which input opened: text keeps the lecture, voice pauses it', async () => {
    await render();
    act(() => iconButton('message-square').click());
    expect(props.onInputActivate).toHaveBeenLastCalledWith('text');

    pressWindowKey('Escape');
    act(() => iconButton('mic').click());
    expect(props.onInputActivate).toHaveBeenLastCalledWith('voice');
  });

  it('holds a queued question: no user bubble yet, one question at a time', async () => {
    await render();
    act(() => iconButton('message-square').click());
    typeAndSend(QUESTION);

    expect(props.onMessageSend).toHaveBeenCalledExactlyOnceWith(QUESTION);
    // The teacher's line keeps the bubble until the question is delivered
    expect(bubbleText()).not.toContain(QUESTION);
    // The send cooldown blocks reopening the input (T) or a second send
    pressWindowKey('t');
    expect(props.onInputActivate).toHaveBeenCalledOnce();
  });

  it('keeps a live region mounted before the hand goes up, then announces it', async () => {
    await render();
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.textContent).toBe('');

    await setQueued('queued');
    expect(container.querySelector('[role="status"]')).toBe(status);
    expect(status?.textContent).toBe('roundtable.handRaisedQueued');
  });

  it('shows the indicator with a cancel control that does not leak clicks or keys', async () => {
    await setQueued('queued');
    expect(indicator()?.textContent).toContain('roundtable.handRaisedQueued');
    expect(indicator()?.textContent).toContain(QUESTION);
    const cancel = [...indicator()!.querySelectorAll('button')].find(
      (button) => button.textContent === 'roundtable.cancelQueuedQuestion',
    )!;
    expect(cancel.getAttribute('aria-describedby')).toBeTruthy();
    expect(document.getElementById(cancel.getAttribute('aria-describedby')!)?.textContent).toBe(
      'roundtable.handRaisedQueued',
    );

    const windowClick = vi.fn();
    const windowKeyDown = vi.fn();
    window.addEventListener('click', windowClick);
    window.addEventListener('keydown', windowKeyDown);
    try {
      // Space on Cancel must not reach the window play/pause shortcut (which
      // would deliver the question instead of cancelling it)
      act(() => {
        cancel.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
      });
      expect(windowKeyDown).not.toHaveBeenCalled();

      act(() => cancel.click());
      expect(props.onCancelQueuedQuestion).toHaveBeenCalledOnce();
      expect(windowClick).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('click', windowClick);
      window.removeEventListener('keydown', windowKeyDown);
    }
  });

  it('puts a cancelled question back into the input and lets it be sent again', async () => {
    await render();
    act(() => iconButton('message-square').click());
    typeAndSend(QUESTION);
    await setQueued('queued');

    await setQueued('cancelled');
    expect(indicator()).toBeNull();
    expect(container.querySelector('textarea')?.value).toBe(QUESTION);
    expect(props.onInputActivate).toHaveBeenCalledOnce();

    vi.mocked(props.onMessageSend as () => string).mockReturnValue(undefined as never);
    typeAndSend(`${QUESTION} (edited)`);
    expect(props.onMessageSend).toHaveBeenLastCalledWith(`${QUESTION} (edited)`);
    expect(props.onMessageSend).toHaveBeenCalledTimes(2);
  });

  it('shows the user bubble once the question is delivered', async () => {
    await render();
    act(() => iconButton('message-square').click());
    typeAndSend(QUESTION);
    await setQueued('queued');

    await setQueued('delivered');
    expect(indicator()).toBeNull();
    expect(bubbleText()).toContain(QUESTION);
    // The closed input fades out on animation frames, still showing the sent
    // text until its exit ends: wait for it rather than for a set render count
    await vi.waitFor(async () => {
      await act(() => new Promise((resolve) => setTimeout(resolve, 16)));
      expect(container.querySelector('textarea')?.value ?? '').toBe('');
    });
  });

  it('hands a user on Cancel to the text-input toggle when the question is delivered', async () => {
    await setQueued('queued');
    act(() => cancelButton().focus());

    await setQueued('delivered');
    // Ready to follow up, but the input stays closed (opening it would pause the answer)
    expect(document.activeElement).toBe(textInputToggle());
    expect(container.querySelector('textarea')).toBeNull();
    expect(props.onInputActivate).not.toHaveBeenCalled();
    expect(container.querySelector('[role="status"]')?.textContent).toBe(
      'roundtable.handRaisedDelivered',
    );
  });

  it('parks focus on the announcement until the send cooldown shows the toggle again', async () => {
    await raiseHandAndFocusCancel();

    await setQueued('delivered');
    const status = container.querySelector('[role="status"]');
    expect(document.activeElement).toBe(status);
    expect(status?.textContent).toBe('roundtable.handRaisedDelivered');

    // The answer starts: the cooldown ends and the toggle is back
    await render({ speakingAgentId: 'agent-1' });
    expect(document.activeElement).toBe(textInputToggle());
    expect(textInputToggle().className).not.toContain('bg-purple-600');
    expect(props.onInputActivate).toHaveBeenCalledOnce();
  });

  it('does not take focus back from a user who moved on during the cooldown', async () => {
    await raiseHandAndFocusCancel();
    await setQueued('delivered');
    const elsewhere = document.createElement('button');
    document.body.appendChild(elsewhere);
    try {
      act(() => elsewhere.focus());
      await render({ speakingAgentId: 'agent-1' });
      expect(document.activeElement).toBe(elsewhere);
    } finally {
      elsewhere.remove();
    }
  });

  it('does not move focus on a later send when no cooldown hid the toggle', async () => {
    // Presenting with the dock hidden: no toggle to hand focus to
    await render({ isPresenting: true, controlsVisible: false });
    await setQueued('queued');
    act(() => cancelButton().focus());
    await setQueued('delivered');
    const status = container.querySelector('[role="status"]');
    expect(document.activeElement).toBe(status);

    // A later, unrelated send/cooldown cycle
    await render({ controlsVisible: true, onMessageSend: vi.fn() });
    act(() => audio.onTranscription?.('A follow-up'));
    await render({ speakingAgentId: 'agent-1' });
    expect(textInputToggle()).not.toBeNull();
    expect(document.activeElement).toBe(status);
  });

  it('says "after this step" when no spoken line was playing', async () => {
    await setQueued('queued', QUESTION, { waitsFor: 'step' });
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toBe('roundtable.handRaisedQueuedStep');
    const label = indicator()!.querySelector('span[id]')!;
    expect(label.textContent).toBe('roundtable.handRaisedQueuedStep');
    expect(label.getAttribute('title')).toBe('roundtable.handRaisedQueuedStep');
    expect(document.getElementById(cancelButton().getAttribute('aria-describedby')!)).toBe(label);

    await setQueued('queued', QUESTION, { id: 2, waitsFor: 'sentence' });
    expect(status?.textContent).toBe('roundtable.handRaisedQueued');
    expect(indicator()!.querySelector('span[id]')?.textContent).toBe('roundtable.handRaisedQueued');
  });

  it('puts a restored question into the opened input without pausing or sending', async () => {
    // The owner restores after mount (a state passed on mount is not replayed)
    await render({ queuedQuestion: null });
    await setQueued('restored', 'Left behind');

    const input = container.querySelector('textarea');
    expect(input?.value).toBe('Left behind');
    expect(document.activeElement).toBe(input);
    expect(props.onInputActivate).not.toHaveBeenCalled();
    expect(props.onMessageSend).not.toHaveBeenCalled();
    expect(indicator()).toBeNull();
    expect(container.querySelector('[role="status"]')?.textContent).toBe('');
  });

  it('leaves focus alone when the delivered pill did not have it', async () => {
    await render();
    act(() => iconButton('message-square').click());
    const input = container.querySelector('textarea')!;
    expect(document.activeElement).toBe(input);
    await setQueued('queued');

    await setQueued('delivered');
    expect(document.activeElement).toBe(input);
  });

  it('keeps a blocked question in the input', async () => {
    await render({ onMessageSend: vi.fn(() => 'blocked') });
    act(() => iconButton('message-square').click());
    typeAndSend(QUESTION);

    expect(container.querySelector('textarea')?.value).toBe(QUESTION);
    expect(bubbleText()).not.toContain(QUESTION);
  });

  it('defers the bubble of a queued voice question, and keeps a blocked one editable', async () => {
    await render();
    act(() => audio.onTranscription?.(QUESTION));
    expect(props.onMessageSend).toHaveBeenCalledExactlyOnceWith(QUESTION);
    expect(bubbleText()).not.toContain(QUESTION);

    act(() => root.unmount());
    root = createRoot(container);
    await render({ onMessageSend: vi.fn(() => 'blocked') });
    act(() => audio.onTranscription?.(QUESTION));
    expect(container.querySelector('textarea')?.value).toBe(QUESTION);
  });
});
