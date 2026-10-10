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
const translate = vi.hoisted(() => vi.fn((key: string, _options?: Record<string, unknown>) => key));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: translate }) }));

import { Composer } from '@/components/classroom/interaction/composer';
import { describeElementReferenceChip } from '@/components/classroom/interaction/element-reference-chip';

const CHIP = { sceneLabel: '互动白板', elementType: '公式', displaySummary: 'E = mc^2' };

describe('Composer: the element-reference chip and sending with it', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const textarea = () => container.querySelector('textarea') as HTMLTextAreaElement;

  function typeAndSend(text: string) {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea(),
        text,
      );
      textarea().dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() =>
      textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
  }

  it('shows the chip inside the box, above the textarea, and clears it with 取消引用', async () => {
    const onClearElementReference = vi.fn();
    await act(async () =>
      root.render(createElement(Composer, { elementReferencePill: CHIP, onClearElementReference })),
    );
    const chip = container.querySelector('[data-testid="slide-element-reference-pill"]')!;
    expect(chip.textContent).toContain('互动白板 · 公式 ·');
    expect(chip.textContent).toContain('E = mc^2');
    // Inside the bordered box, before the textarea
    const box = textarea().parentElement!;
    expect(box.contains(chip)).toBe(true);
    expect(
      chip.compareDocumentPosition(textarea()) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    const clear = chip.querySelector('button[aria-label="chat.elementReference.clear"]')!;
    act(() => (clear as HTMLButtonElement).click());
    expect(onClearElementReference).toHaveBeenCalledOnce();
  });

  it('frames the placeholder by the referenced element, under the cue and the follow-up', async () => {
    await act(async () => root.render(createElement(Composer, { elementReferencePill: CHIP })));
    // 关于这个公式，你想问什么？
    expect(textarea().placeholder).toBe('stage.composer.referencePlaceholder');
    expect(translate).toHaveBeenCalledWith('stage.composer.referencePlaceholder', {
      type: '公式',
    });

    await act(async () =>
      root.render(createElement(Composer, { elementReferencePill: CHIP, isFollowUp: true })),
    );
    expect(textarea().placeholder).toBe('stage.composer.followUpPlaceholder');
    await act(async () =>
      root.render(createElement(Composer, { elementReferencePill: CHIP, isCueUser: true })),
    );
    expect(textarea().placeholder).toBe('stage.composer.cuePlaceholder');

    await act(async () => root.render(createElement(Composer, {})));
    expect(textarea().placeholder).toBe('roundtable.inputPlaceholder');
  });

  it('keeps typed text and allows sending it after the reference is fixed', async () => {
    const canSendMessage = vi.fn(() => false);
    const onMessageSend = vi.fn();
    await act(async () =>
      root.render(
        createElement(Composer, { canSendMessage, onMessageSend, elementReferencePill: CHIP }),
      ),
    );
    typeAndSend('Why this formula?');
    expect(onMessageSend).not.toHaveBeenCalled();
    expect(textarea().value).toBe('Why this formula?');

    canSendMessage.mockReturnValue(true);
    act(() =>
      textarea().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    );
    // The shell attaches the frozen reference to this send (onMessageSend)
    expect(onMessageSend).toHaveBeenCalledExactlyOnceWith('Why this formula?');
    expect(textarea().value).toBe('');
  });

  it('moves a rejected voice question into the editable composer without sending', async () => {
    const onMessageSend = vi.fn();
    await act(async () =>
      root.render(createElement(Composer, { canSendMessage: () => false, onMessageSend })),
    );
    act(() => audio.onTranscription?.('Explain the selected equation.'));
    expect(onMessageSend).not.toHaveBeenCalled();
    expect(textarea().value).toBe('Explain the selected equation.');
  });
});

describe('describeElementReferenceChip', () => {
  const t = (key: string, options?: Record<string, unknown>) =>
    ({
      'whiteboard.title': '互动白板',
      'edit.element.latex': '公式',
      'edit.element.text': '文本',
      'edit.sceneType.interactive': '互动',
    })[key] ?? (key === 'chat.lectureNotes.pageLabel' ? `第 ${options?.n} 页` : key);

  it('labels a whiteboard element 互动白板 · type · summary', () => {
    expect(
      describeElementReferenceChip(
        {
          reference: { kind: 'whiteboard_element', whiteboardId: 'wb', elementId: 'f1' },
          elementType: 'latex',
          displaySummary: 'E = mc^2',
        },
        t,
      ),
    ).toEqual({ sceneLabel: '互动白板', elementType: '公式', displaySummary: 'E = mc^2' });
  });

  it('labels slide elements and interactive components by page', () => {
    expect(
      describeElementReferenceChip(
        {
          reference: { kind: 'slide_element', sceneId: 's', elementId: 'e' },
          sceneOrder: 1,
          elementType: 'text',
          displaySummary: 'Fact',
        },
        t,
      ),
    ).toEqual({ sceneLabel: '第 2 页', elementType: '文本', displaySummary: 'Fact' });
    expect(
      describeElementReferenceChip(
        {
          reference: { kind: 'interactive_component', sceneId: 's', selector: '#result' },
          sceneOrder: 0,
          elementType: 'interactive',
          displaySummary: '#result',
        },
        t,
      ).elementType,
    ).toBe('互动');
  });
});
