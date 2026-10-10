// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  useClassroomShortcuts,
  type UseClassroomShortcutsOptions,
} from '@/components/classroom/interaction/use-classroom-shortcuts';

describe('useClassroomShortcuts', () => {
  let container: HTMLDivElement;
  let root: Root;
  let options: UseClassroomShortcutsOptions;

  function Probe(props: UseClassroomShortcutsOptions) {
    useClassroomShortcuts(props);
    return createElement('textarea');
  }

  function render(next: Partial<UseClassroomShortcutsOptions> = {}) {
    options = { ...options, ...next };
    act(() => root.render(createElement(Probe, options)));
  }

  /** Dispatch on `target` (bubbling to window); returns the event and its stopPropagation spy */
  function press(key: string, target: EventTarget = window, init: KeyboardEventInit = {}) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
    const stopPropagation = vi.spyOn(event, 'stopPropagation');
    act(() => {
      target.dispatchEvent(event);
    });
    return { event, stopPropagation };
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    options = {
      isComposerOpen: false,
      onDismiss: vi.fn(),
      isInLiveFlow: false,
      onToggleLivePause: vi.fn(),
      focusComposer: vi.fn(),
      toggleVoice: vi.fn(),
      canUseVoice: true,
    };
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('closes an open composer on Escape and keeps the key from exiting fullscreen', () => {
    render({ isComposerOpen: true });
    // From inside the textarea: Escape still works while typing
    const { event, stopPropagation } = press('Escape', container.querySelector('textarea')!);
    expect(options.onDismiss).toHaveBeenCalledOnce();
    expect(event.defaultPrevented).toBe(true);
    expect(stopPropagation).toHaveBeenCalledOnce();
  });

  it('leaves Escape alone when the composer is closed (fullscreen may exit)', () => {
    render();
    const { event, stopPropagation } = press('Escape');
    expect(options.onDismiss).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
    expect(stopPropagation).not.toHaveBeenCalled();
  });

  it('pauses or resumes the live answer on Space only in live flow', () => {
    render();
    const { event: lecture } = press(' ');
    expect(options.onToggleLivePause).not.toHaveBeenCalled();
    // The stage owns Space for lecture play/pause
    expect(lecture.defaultPrevented).toBe(false);

    render({ isInLiveFlow: true });
    const { event: live } = press(' ');
    expect(options.onToggleLivePause).toHaveBeenCalledOnce();
    expect(live.defaultPrevented).toBe(true);
  });

  it('opens the composer on T and voice on V when available', () => {
    render();
    press('t');
    expect(options.focusComposer).toHaveBeenCalledOnce();
    press('V');
    expect(options.toggleVoice).toHaveBeenCalledOnce();

    render({ canUseVoice: false });
    press('v');
    expect(options.toggleVoice).toHaveBeenCalledOnce();
  });

  it('ignores letters and Space typed into a field', () => {
    render({ isInLiveFlow: true });
    const textarea = container.querySelector('textarea')!;
    press('t', textarea);
    press(' ', textarea);
    expect(options.focusComposer).not.toHaveBeenCalled();
    expect(options.onToggleLivePause).not.toHaveBeenCalled();
  });

  it('acts on the latest render and stops listening when disabled', () => {
    const first = vi.fn();
    const latest = vi.fn();
    render({ focusComposer: first });
    render({ focusComposer: latest });
    press('t');
    expect(first).not.toHaveBeenCalled();
    expect(latest).toHaveBeenCalledOnce();

    render({ enabled: false });
    press('t');
    expect(latest).toHaveBeenCalledOnce();
  });

  it('leaves Space to a focused control (举手, a dock toggle) instead of pausing', () => {
    render({ isInLiveFlow: true });
    const button = document.createElement('button');
    container.appendChild(button);
    const { event } = press(' ', button);
    expect(options.onToggleLivePause).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });

  it('ignores H with Ctrl / Cmd / Alt and while the key repeats', () => {
    const toggleHand = vi.fn();
    render({ toggleHand });
    press('h', window, { ctrlKey: true });
    press('h', window, { metaKey: true });
    press('h', window, { altKey: true });
    const { event: held } = press('h', window, { repeat: true });
    expect(toggleHand).not.toHaveBeenCalled();
    expect(held.defaultPrevented).toBe(false);
    press('h');
    expect(toggleHand).toHaveBeenCalledOnce();
  });
});
