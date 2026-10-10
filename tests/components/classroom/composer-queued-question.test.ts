// @vitest-environment jsdom
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const audio = vi.hoisted(() => ({
  onTranscription: undefined as ((text: string) => void) | undefined,
  isRecording: false,
  isProcessing: false,
  startRecording: undefined as unknown as () => void,
  stopRecording: undefined as unknown as () => void,
  cancelRecording: undefined as unknown as () => void,
  asrAvailable: true,
}));
vi.mock('@/lib/hooks/use-audio-recorder', () => ({
  useAudioRecorder: (options: { onTranscription: (text: string) => void }) => {
    audio.onTranscription = options.onTranscription;
    return {
      isRecording: audio.isRecording,
      isProcessing: audio.isProcessing,
      startRecording: audio.startRecording,
      stopRecording: audio.stopRecording,
      cancelRecording: audio.cancelRecording,
    };
  },
}));
vi.mock('@/lib/hooks/use-asr-available', () => ({ useASRAvailable: () => audio.asrAvailable }));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import {
  Composer,
  type ComposerHandle,
  type ComposerProps,
} from '@/components/classroom/interaction/composer';
import type { QueuedQuestionState } from '@/components/classroom/interaction/use-queued-question-effects';

const QUESTION = 'Why does the curve flatten?';

describe('Composer: raised hand (queued question), activation and voice', () => {
  let container: HTMLDivElement;
  let root: Root;
  let props: Partial<ComposerProps> & Record<string, unknown>;
  const handle = createRef<ComposerHandle>();

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    audio.isRecording = false;
    audio.isProcessing = false;
    audio.asrAvailable = true;
    audio.startRecording = vi.fn(() => {
      audio.isRecording = true;
    });
    audio.stopRecording = vi.fn(() => {
      audio.isRecording = false;
    });
    audio.cancelRecording = vi.fn(() => {
      audio.isRecording = false;
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    props = {
      composerRef: handle,
      onMessageSend: vi.fn(() => 'queued' as const),
      onInputActivate: vi.fn(),
      onCancelQueuedQuestion: vi.fn(),
      onInteractionChange: vi.fn(),
    };
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  async function render(next: Record<string, unknown> = {}) {
    props = { ...props, ...next };
    await act(async () => root.render(createElement(Composer, props as ComposerProps)));
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

  const textarea = () => container.querySelector('textarea') as HTMLTextAreaElement;
  const row = () => container.querySelector('[data-testid="composer-queued-question"]');
  const liveRegion = () => container.querySelector('span[role="status"]');
  const button = (label: string) =>
    container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
  const cancelButton = () =>
    [...(row()?.querySelectorAll('button') ?? [])].find(
      (b) => b.textContent === 'roundtable.cancelQueuedQuestion',
    )!;

  function type(text: string) {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea(),
        text,
      );
      textarea().dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function typeAndSend(text: string) {
    act(() => textarea().focus());
    type(text);
    act(() =>
      textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
  }

  /** Send a question that raises a hand (starts the send cooldown), focus 撤回. */
  async function raiseHandAndFocusCancel() {
    await render();
    typeAndSend(QUESTION);
    await setQueued('queued');
    act(() => cancelButton().focus());
    expect(document.activeElement).toBe(cancelButton());
  }

  it('keeps the textarea always visible and reports focus as text activation (no pause)', async () => {
    await render();
    expect(textarea()).not.toBeNull();
    expect(textarea().placeholder).toBe('roundtable.inputPlaceholder');
    expect(props.onInputActivate).not.toHaveBeenCalled();

    act(() => textarea().focus());
    expect(props.onInputActivate).toHaveBeenCalledExactlyOnceWith('text');
    // An empty focused box is not composing yet: it holds nothing
    expect(props.onInteractionChange).not.toHaveBeenCalledWith(true);
    type('half a question');
    expect(props.onInteractionChange).toHaveBeenLastCalledWith(true);

    act(() => textarea().blur());
    expect(props.onInteractionChange).toHaveBeenLastCalledWith(false);
    // A draft left in an unfocused box holds nothing
    type('half a question, more');
    expect(props.onInteractionChange).toHaveBeenLastCalledWith(false);
  });

  it('stops composing once a send empties the box, though focus stays in it', async () => {
    await render({ onMessageSend: vi.fn(() => undefined) });
    typeAndSend(QUESTION);
    expect(document.activeElement).toBe(textarea());
    // Focus left behind by a send must not hold auto-play's scene advance
    expect(props.onInteractionChange).toHaveBeenLastCalledWith(false);

    // Escape still leaves the empty box (the shell does not count it as open)
    act(() =>
      textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(document.activeElement).not.toBe(textarea());
  });

  it('reports voice (which pauses) and replaces the textarea with the recording row', async () => {
    await render();
    act(() => button('roundtable.voiceInput')!.click());
    expect(props.onInputActivate).toHaveBeenCalledExactlyOnceWith('voice');
    expect(audio.startRecording).toHaveBeenCalledOnce();
    expect(textarea()).toBeNull();
    // Announced through an always-mounted live region, not one that mounts with its text
    const recording = [...container.querySelectorAll('[role="status"]')].find((node) =>
      node.textContent?.includes('roundtable.listening'),
    );
    expect(recording?.className).toContain('sr-only');
    expect(props.onInteractionChange).toHaveBeenLastCalledWith(true);

    // 取消 drops the recording; the textarea comes back
    act(() => button('stage.composer.cancelRecording')!.click());
    expect(audio.cancelRecording).toHaveBeenCalledOnce();
    expect(textarea()).not.toBeNull();

    // Stop transcribes
    act(() => button('roundtable.voiceInput')!.click());
    act(() => button('roundtable.stopRecording')!.click());
    expect(audio.stopRecording).toHaveBeenCalledOnce();
  });

  it('shows the processing state and MicOff when speech input is unavailable', async () => {
    // Transcribing: the box keeps the voice surface, with 取消 and no stop
    audio.isProcessing = true;
    await render();
    expect(textarea()).toBeNull();
    expect(container.textContent).toContain('roundtable.processing');
    expect(button('stage.composer.cancelRecording')).not.toBeNull();
    expect(button('roundtable.stopRecording')).toBeNull();

    act(() => root.unmount());
    root = createRoot(container);
    audio.isProcessing = false;
    audio.asrAvailable = false;
    await render();
    const mic = button('roundtable.voiceInputDisabled')!;
    expect(mic.disabled).toBe(true);
    expect(mic.querySelector('svg.lucide-mic-off')).not.toBeNull();
  });

  it('holds a queued question: the draft clears and the cooldown blocks a second send', async () => {
    await render();
    expect(button('stage.composer.send')!.disabled).toBe(true);
    typeAndSend(QUESTION);

    expect(props.onMessageSend).toHaveBeenCalledExactlyOnceWith(QUESTION);
    expect(textarea().value).toBe('');
    // Cooling down: the send circle spins and stays disabled
    const send = button('stage.composer.send')!;
    expect(send.disabled).toBe(true);
    expect(send.querySelector('svg.animate-spin')).not.toBeNull();
    typeAndSend('A second one');
    expect(props.onMessageSend).toHaveBeenCalledOnce();

    // The answer starts: the lock lifts
    await render({ speakingAgentId: 'agent-1' });
    expect(button('stage.composer.send')!.disabled).toBe(false);
  });

  it('tells the owner a send went out, and when a question becomes the learner line', async () => {
    const onSent = vi.fn();
    const onUserMessage = vi.fn();
    // Raised: the box empties, but the line waits for delivery
    await render({ onSent, onUserMessage });
    typeAndSend(QUESTION);
    expect(onSent).toHaveBeenCalledOnce();
    expect(onUserMessage).not.toHaveBeenCalled();
    await setQueued('queued');
    await setQueued('delivered');
    expect(onUserMessage).toHaveBeenCalledExactlyOnceWith(QUESTION);

    // Sent now: both at once; a blocked send is neither
    await render({ speakingAgentId: 'agent-1', onMessageSend: vi.fn(() => undefined) });
    typeAndSend('Right now');
    expect(onSent).toHaveBeenCalledTimes(2);
    expect(onUserMessage).toHaveBeenLastCalledWith('Right now');
    await render({ speakingAgentId: 'agent-2', onMessageSend: vi.fn(() => 'blocked' as const) });
    await render({ speakingAgentId: 'agent-3' });
    typeAndSend('Blocked');
    expect(onSent).toHaveBeenCalledTimes(2);
    expect(onUserMessage).toHaveBeenCalledTimes(2);
  });

  it('keeps a live region mounted before the hand goes up, then announces it', async () => {
    await render();
    const status = liveRegion();
    expect(status?.textContent).toBe('');

    await setQueued('queued');
    expect(liveRegion()).toBe(status);
    expect(status?.textContent).toBe('roundtable.handRaisedQueued');
  });

  it('shows the 已举手 row with 撤回 that does not leak clicks or keys, and 放下 in the 举手 slot', async () => {
    await setQueued('queued');
    expect(row()?.textContent).toContain('roundtable.handRaisedQueued');
    expect(row()?.textContent).toContain(QUESTION);
    const cancel = cancelButton();
    expect(document.getElementById(cancel.getAttribute('aria-describedby')!)?.textContent).toBe(
      'roundtable.handRaisedQueued',
    );

    const windowClick = vi.fn();
    const windowKeyDown = vi.fn();
    window.addEventListener('click', windowClick);
    window.addEventListener('keydown', windowKeyDown);
    try {
      // Space on 撤回 must not reach the window play/pause shortcut (which
      // would deliver the question instead of cancelling it)
      act(() => {
        cancel.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
        cancel.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      expect(windowKeyDown).not.toHaveBeenCalled();

      act(() => cancel.click());
      expect(props.onCancelQueuedQuestion).toHaveBeenCalledOnce();
      expect(windowClick).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener('click', windowClick);
      window.removeEventListener('keydown', windowKeyDown);
    }

    // The hand slot reads 放下 while the question waits, and takes it back too
    const lower = container.querySelector('button[aria-pressed="true"]') as HTMLButtonElement;
    expect(lower.textContent).toBe('stage.composer.lowerHand');
    act(() => lower.click());
    expect(props.onCancelQueuedQuestion).toHaveBeenCalledTimes(2);
  });

  it('draws the line progress while the question waits', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] });
    await render({ getSpeechProgress: () => 0.64 });
    expect(container.querySelector('[data-testid="composer-queued-progress"]')).toBeNull();
    await setQueued('queued');
    act(() => vi.advanceTimersToNextFrame());
    const bar = container.querySelector('[data-testid="composer-queued-progress"]');
    expect(bar?.getAttribute('aria-hidden')).toBe('true');
    expect((bar?.firstElementChild as HTMLElement).style.width).toBe('64%');
  });

  it('puts a cancelled question back into the focused textarea without activating, and sends it again', async () => {
    await render();
    typeAndSend(QUESTION);
    await setQueued('queued');
    act(() => textarea().blur());

    await setQueued('cancelled');
    expect(row()).toBeNull();
    expect(textarea().value).toBe(QUESTION);
    expect(document.activeElement).toBe(textarea());
    // Only the first, user-made focus reported activation
    expect(props.onInputActivate).toHaveBeenCalledOnce();

    vi.mocked(props.onMessageSend as () => string).mockReturnValue(undefined as never);
    type(`${QUESTION} (edited)`);
    act(() =>
      textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    expect(props.onMessageSend).toHaveBeenLastCalledWith(`${QUESTION} (edited)`);
    expect(props.onMessageSend).toHaveBeenCalledTimes(2);
  });

  it('hands a user on 撤回 to the textarea when the question is delivered, without pausing anything', async () => {
    await raiseHandAndFocusCancel();
    vi.mocked(props.onInputActivate!).mockClear();

    await setQueued('delivered');
    expect(row()).toBeNull();
    // Focus did not fall to <body>: ready to follow up, and focusing it did
    // not report activation (which would pause the answer that is starting)
    expect(document.activeElement).toBe(textarea());
    expect(props.onInputActivate).not.toHaveBeenCalled();
    expect(liveRegion()?.textContent).toBe('roundtable.handRaisedDelivered');

    // Once the answer starts (the cooldown ends), a later focus reports again
    await render({ speakingAgentId: 'agent-1' });
    act(() => textarea().blur());
    act(() => textarea().focus());
    expect(props.onInputActivate).toHaveBeenCalledExactlyOnceWith('text');
  });

  it('parks focus on the announcement when the textarea is replaced by a recording', async () => {
    await setQueued('queued');
    act(() => cancelButton().focus());
    // Recording replaces the textarea, so there is no focus target
    act(() => button('roundtable.voiceInput')!.click());
    expect(textarea()).toBeNull();
    // Still focusable through the row? The row stays: move focus back onto it
    act(() => cancelButton().focus());

    await setQueued('delivered');
    expect(document.activeElement).toBe(liveRegion());
  });

  it('leaves focus alone when the delivered row did not have it', async () => {
    await render();
    act(() => textarea().focus());
    await setQueued('queued');

    await setQueued('delivered');
    expect(document.activeElement).toBe(textarea());
  });

  it('says "after this step" when no spoken line was playing', async () => {
    await setQueued('queued', QUESTION, { waitsFor: 'step' });
    expect(liveRegion()?.textContent).toBe('roundtable.handRaisedQueuedStep');
    const label = row()!.querySelector('span[id]')!;
    expect(label.textContent).toBe('roundtable.handRaisedQueuedStep');
    expect(label.getAttribute('title')).toBe('roundtable.handRaisedQueuedStep');
    expect(document.getElementById(cancelButton().getAttribute('aria-describedby')!)).toBe(label);
  });

  it('puts a restored question into the focused textarea without pausing or sending', async () => {
    // The owner restores after mount (a state passed on mount is not replayed)
    await render({ queuedQuestion: null });
    await setQueued('restored', 'Left behind');

    expect(textarea().value).toBe('Left behind');
    expect(document.activeElement).toBe(textarea());
    expect(props.onInputActivate).not.toHaveBeenCalled();
    expect(props.onMessageSend).not.toHaveBeenCalled();
    expect(row()).toBeNull();
    expect(liveRegion()?.textContent).toBe('');
  });

  it('keeps a blocked question in the textarea', async () => {
    await render({ onMessageSend: vi.fn(() => 'blocked') });
    typeAndSend(QUESTION);
    expect(textarea().value).toBe(QUESTION);
    expect(button('stage.composer.send')!.disabled).toBe(false);
  });

  it('defers a queued voice question, and keeps a blocked one editable', async () => {
    await render();
    act(() => audio.onTranscription?.(QUESTION));
    expect(props.onMessageSend).toHaveBeenCalledExactlyOnceWith(QUESTION);
    expect(textarea().value).toBe('');

    act(() => root.unmount());
    root = createRoot(container);
    await render({ onMessageSend: vi.fn(() => 'blocked') });
    act(() => audio.onTranscription?.(QUESTION));
    expect(textarea().value).toBe(QUESTION);
    // Back for editing, quietly focused
    expect(document.activeElement).toBe(textarea());
  });

  it('举手 focuses the textarea (the text raise), and is disabled during a Q&A', async () => {
    await render();
    const raise = container.querySelector(
      '[data-testid="composer-raise-hand"]',
    ) as HTMLButtonElement;
    expect(raise.title).toBe('stage.composer.raiseHandHint');
    act(() => raise.click());
    expect(document.activeElement).toBe(textarea());
    expect(props.onInputActivate).toHaveBeenCalledExactlyOnceWith('text');

    await render({ isLiveSession: true });
    const disabled = container.querySelector(
      '[data-testid="composer-raise-hand"]',
    ) as HTMLButtonElement;
    expect(disabled.disabled).toBe(true);
    expect(disabled.title).toBe('stage.composer.raiseHandInLiveSession');
  });

  it('turns the box to the cue: status row, warning border and the cue placeholder', async () => {
    await render({ isCueUser: true });
    expect(container.querySelector('[data-testid="composer-cue"]')?.textContent).toContain(
      'stage.composer.cueStatus',
    );
    expect(textarea().placeholder).toBe('stage.composer.cuePlaceholder');
    const box = container.querySelector('[data-testid="composer-box"]')!;
    expect(box.getAttribute('data-state')).toBe('cue');
    expect(box.className).toContain('border-warning');
  });

  it('exposes focus (activating), openTextInput (quiet) and dismiss to the shell', async () => {
    await render();
    act(() => handle.current!.openTextInput());
    await render();
    expect(document.activeElement).toBe(textarea());
    expect(props.onInputActivate).not.toHaveBeenCalled();

    act(() => handle.current!.dismiss());
    expect(document.activeElement).not.toBe(textarea());

    act(() => handle.current!.focus());
    expect(document.activeElement).toBe(textarea());
    expect(props.onInputActivate).toHaveBeenCalledExactlyOnceWith('text');

    act(() => handle.current!.toggleVoice());
    expect(audio.startRecording).toHaveBeenCalledOnce();
  });

  it('T over a recording drops it and focuses the textarea as the user would', async () => {
    await render();
    act(() => handle.current!.toggleVoice());
    expect(textarea()).toBeNull();
    expect(props.onInputActivate).toHaveBeenCalledExactlyOnceWith('voice');

    act(() => handle.current!.focus());
    expect(audio.cancelRecording).toHaveBeenCalledOnce();
    expect(textarea()).not.toBeNull();
    expect(document.activeElement).toBe(textarea());
    expect(props.onInputActivate).toHaveBeenLastCalledWith('text');
  });

  it('carries keyboard focus through the voice controls instead of dropping it to <body>', async () => {
    await render();
    // Mic → stop: focus moves onto the recording's stop circle
    const mic = button('roundtable.voiceInput')!;
    act(() => mic.focus());
    act(() => mic.click());
    expect(document.activeElement).toBe(button('roundtable.stopRecording'));

    // Stop → the textarea, quietly (no text activation)
    act(() => button('roundtable.stopRecording')!.click());
    expect(audio.stopRecording).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(textarea());
    expect(props.onInputActivate).toHaveBeenCalledExactlyOnceWith('voice');

    // Mic → 取消 → the textarea
    act(() => button('roundtable.voiceInput')!.focus());
    act(() => button('roundtable.voiceInput')!.click());
    const cancel = button('stage.composer.cancelRecording')!;
    act(() => cancel.focus());
    act(() => cancel.click());
    expect(audio.cancelRecording).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(textarea());
    expect(props.onInputActivate).not.toHaveBeenCalledWith('text');
  });

  it('leaves focus alone when the recording was started away from the composer (V)', async () => {
    await render();
    act(() => handle.current!.toggleVoice());
    expect(document.activeElement).toBe(document.body);
    act(() => handle.current!.toggleVoice());
    expect(document.activeElement).toBe(document.body);
  });
});
