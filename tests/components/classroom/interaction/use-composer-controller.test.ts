// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const audio = vi.hoisted(() => ({
  onTranscription: undefined as ((text: string) => void) | undefined,
  startRecording: vi.fn(),
  cancelRecording: vi.fn(),
}));
vi.mock('@/lib/hooks/use-audio-recorder', () => ({
  useAudioRecorder: (options: { onTranscription: (text: string) => void }) => {
    audio.onTranscription = options.onTranscription;
    return {
      isRecording: false,
      isProcessing: false,
      startRecording: audio.startRecording,
      stopRecording: vi.fn(),
      cancelRecording: audio.cancelRecording,
    };
  },
}));
vi.mock('@/lib/hooks/use-asr-available', () => ({ useASRAvailable: () => true }));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
const toastInfo = vi.hoisted(() => vi.fn());
vi.mock('sonner', () => ({ toast: { info: toastInfo, error: vi.fn() } }));

import {
  useComposerController,
  type ComposerController,
  type UseComposerControllerOptions,
} from '@/components/classroom/interaction/use-composer-controller';

describe('useComposerController', () => {
  let container: HTMLDivElement;
  let root: Root;
  let composer: ComposerController;
  let options: UseComposerControllerOptions;

  function Probe({
    onResult,
    ...props
  }: UseComposerControllerOptions & { readonly onResult: (value: ComposerController) => void }) {
    const controller = useComposerController(props);
    onResult(controller);
    return controller.isInputOpen ? createElement('textarea', controller.textareaProps) : null;
  }

  function render(next: Partial<UseComposerControllerOptions> = {}) {
    options = { ...options, ...next };
    act(() =>
      root.render(
        createElement(Probe, {
          ...options,
          onResult: (value) => {
            composer = value;
          },
        }),
      ),
    );
  }

  function textarea() {
    return container.querySelector('textarea')!;
  }

  function type(text: string) {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea(),
        text,
      );
      textarea().dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  function pressEnter(init: KeyboardEventInit = {}) {
    act(() => {
      textarea().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, ...init }),
      );
    });
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    audio.startRecording.mockReset();
    audio.cancelRecording.mockReset();
    toastInfo.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    options = {
      onMessageSend: vi.fn(),
      onUserMessage: vi.fn(),
      onInputActivate: vi.fn(),
      onUserInputActivity: vi.fn(),
    };
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('sends on Enter, shows the question and locks a second send until the answer starts', () => {
    render();
    act(() => composer.toggleInput());
    expect(options.onInputActivate).toHaveBeenCalledExactlyOnceWith('text');
    type('Why?');
    pressEnter();

    expect(options.onMessageSend).toHaveBeenCalledExactlyOnceWith('Why?');
    expect(options.onUserMessage).toHaveBeenCalledExactlyOnceWith('Why?');
    expect(composer.draft).toBe('');
    expect(composer.isInputOpen).toBe(false);
    expect(composer.isSendCooldown).toBe(true);

    // The cooldown blocks reopening the input and a second send
    act(() => composer.toggleInput());
    expect(composer.isInputOpen).toBe(false);
    act(() => composer.setDraft('Again'));
    act(() => composer.send());
    expect(options.onMessageSend).toHaveBeenCalledOnce();
    // ...and a voice transcript arriving meanwhile
    act(() => audio.onTranscription?.('Spoken twice'));
    expect(options.onMessageSend).toHaveBeenCalledOnce();

    // The answer starts: the lock lifts
    render({ speakingAgentId: 'teacher-1' });
    expect(composer.isSendCooldown).toBe(false);
    act(() => composer.send());
    expect(options.onMessageSend).toHaveBeenLastCalledWith('Again');
  });

  it('lifts the lock when streaming ends, not while it was never on', () => {
    render();
    act(() => composer.setDraft('Why?'));
    act(() => composer.send());
    render({ isStreaming: false });
    expect(composer.isSendCooldown).toBe(true);
    render({ isStreaming: true });
    render({ isStreaming: false });
    expect(composer.isSendCooldown).toBe(false);
  });

  it('keeps a blocked question in the draft', () => {
    render({ onMessageSend: vi.fn(() => 'blocked' as const) });
    act(() => composer.toggleInput());
    type('Why?');
    pressEnter();
    expect(composer.draft).toBe('Why?');
    expect(composer.isInputOpen).toBe(true);
    expect(composer.isSendCooldown).toBe(false);
    expect(options.onUserMessage).not.toHaveBeenCalled();
  });

  it('clears a queued question without showing it as the user line', () => {
    render({ onMessageSend: vi.fn(() => 'queued' as const) });
    act(() => composer.toggleInput());
    type('Why?');
    pressEnter();
    expect(composer.draft).toBe('');
    expect(composer.isInputOpen).toBe(false);
    expect(composer.isSendCooldown).toBe(true);
    expect(options.onUserMessage).not.toHaveBeenCalled();
  });

  it('does not send on Shift+Enter or on the Enter that commits an IME composition', () => {
    render();
    act(() => composer.toggleInput());
    type('こんにちは');
    pressEnter({ shiftKey: true });
    act(() => {
      const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true });
      Object.defineProperty(event, 'isComposing', { value: true });
      textarea().dispatchEvent(event);
    });
    expect(options.onMessageSend).not.toHaveBeenCalled();
  });

  it('reports typing and composition as input activity', () => {
    render();
    act(() => composer.toggleInput());
    // jsdom has no TextEvent, so React builds onBeforeInput from a keypress
    act(() => {
      const event = new KeyboardEvent('keypress', { key: 'a', bubbles: true, cancelable: true });
      Object.defineProperty(event, 'which', { value: 97 });
      textarea().dispatchEvent(event);
    });
    expect(options.onUserInputActivity).toHaveBeenCalledWith('text_input');
    act(() => {
      textarea().dispatchEvent(new Event('compositionstart', { bubbles: true }));
    });
    expect(options.onUserInputActivity).toHaveBeenCalledWith('composition_start');
  });

  it('keeps text whose element reference cannot be sent', () => {
    const canSendMessage = vi.fn(() => false);
    render({ canSendMessage });
    act(() => composer.setDraft('About this formula'));
    act(() => composer.send());
    expect(options.onMessageSend).not.toHaveBeenCalled();
    expect(composer.draft).toBe('About this formula');
  });

  it('opens voice by pausing narration and falls back into the draft when it cannot send', () => {
    render({ canSendMessage: () => false });
    act(() => composer.voice.toggle());
    expect(options.onInputActivate).toHaveBeenCalledExactlyOnceWith('voice');
    expect(options.onUserInputActivity).toHaveBeenCalledWith('recording_start');
    expect(audio.startRecording).toHaveBeenCalledOnce();
    expect(composer.voice.isOpen).toBe(true);

    act(() => audio.onTranscription?.('Explain this'));
    expect(options.onMessageSend).not.toHaveBeenCalled();
    expect(composer.draft).toBe('Explain this');
    expect(composer.isInputOpen).toBe(true);
    expect(composer.voice.isOpen).toBe(false);
  });

  it('toasts an empty transcript and keeps nothing', () => {
    render();
    act(() => composer.voice.toggle());
    act(() => audio.onTranscription?.('   '));
    expect(toastInfo).toHaveBeenCalledExactlyOnceWith('roundtable.noSpeechDetected');
    expect(options.onMessageSend).not.toHaveBeenCalled();
    expect(composer.voice.isOpen).toBe(false);
  });

  it('gives a returned question back to the reopened input and lifts the lock', () => {
    render();
    act(() => composer.setDraft('Why?'));
    act(() => composer.send());
    act(() => composer.restoreDraft('Why?'));
    expect(composer).toMatchObject({ draft: 'Why?', isInputOpen: true, isSendCooldown: false });
  });

  it('closes everything on dismiss', () => {
    render();
    act(() => composer.toggleInput());
    expect(composer.isActive).toBe(true);
    act(() => composer.dismiss());
    expect(composer.isActive).toBe(false);
  });

  it('raises and lowers a text-less hand through the owner', () => {
    const onRaise = vi.fn(() => true);
    const onLower = vi.fn(() => true);
    render({ hand: { state: null, onRaise, onLower } });
    expect(composer.hand).toMatchObject({ state: null, isRaised: false, isCalled: false });
    expect(composer.hand.toggle()).toBe(true);
    expect(onRaise).toHaveBeenCalledOnce();

    render({ hand: { state: 'raised', onRaise, onLower } });
    expect(composer.hand.isRaised).toBe(true);
    composer.hand.toggle();
    expect(onLower).toHaveBeenCalledOnce();

    render({ hand: { state: 'called', onRaise: vi.fn(() => false) } });
    expect(composer.hand.isCalled).toBe(true);
    // No lower handler: nothing happens
    expect(composer.hand.toggle()).toBe(false);
  });
});
