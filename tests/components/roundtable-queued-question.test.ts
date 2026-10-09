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

  function setQueued(status: QueuedQuestionState['status'], text = QUESTION) {
    return render({ queuedQuestion: { id: 1, text, status } satisfies QueuedQuestionState });
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
    expect(container.querySelector('textarea')?.value ?? '').toBe('');
  });

  it('keeps the place of a user on Cancel when the question is delivered', async () => {
    await setQueued('queued');
    const cancel = [...indicator()!.querySelectorAll('button')].find(
      (button) => button.textContent === 'roundtable.cancelQueuedQuestion',
    )!;
    act(() => cancel.focus());
    expect(document.activeElement).toBe(cancel);

    await setQueued('delivered');
    const status = container.querySelector('[role="status"]');
    expect(document.activeElement).toBe(status);
    expect(status?.textContent).toBe('roundtable.handRaisedDelivered');
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
