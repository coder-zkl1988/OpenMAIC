// @vitest-environment jsdom
/**
 * The composer's @ menu (I23): typing "@" offers the people in class, the
 * keyboard picks one (Enter / Tab) without sending, Escape closes only the
 * menu, and a classmate card's "ask them" addresses the draft.
 */
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-audio-recorder', () => ({
  useAudioRecorder: () => ({
    isRecording: false,
    isProcessing: false,
    startRecording: vi.fn(),
    stopRecording: vi.fn(),
    cancelRecording: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/use-asr-available', () => ({ useASRAvailable: () => true }));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import { Composer, type ComposerHandle } from '@/components/classroom/interaction/composer';

const PEOPLE = [
  { id: 'teacher', name: 'Ms. Lin', role: 'teacher', avatar: '/t.png' },
  { id: 'mia', name: 'Mia', role: 'student', avatar: '/m.png' },
  { id: 'max', name: 'Max', role: 'student', avatar: '/x.png' },
];

describe('Composer: the @ menu', () => {
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
  const menu = () => container.querySelector('[data-testid="agent-mention-menu"]');
  const options = () =>
    [...container.querySelectorAll('[data-testid="agent-mention-option"]')].map((node) =>
      node.getAttribute('data-agent-id'),
    );

  function type(text: string) {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea(),
        text,
      );
      textarea().dispatchEvent(new Event('input', { bubbles: true }));
    });
  }
  function press(key: string) {
    const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    act(() => {
      textarea().dispatchEvent(event);
    });
    return event;
  }

  async function render(props: Record<string, unknown> = {}) {
    await act(async () =>
      root.render(createElement(Composer, { mentionCandidates: PEOPLE, ...props } as never)),
    );
  }

  it('offers the people whose name fits what follows "@", and invites it in the placeholder', async () => {
    await render();
    expect(textarea().placeholder).toBe('stage.composer.mentionPlaceholder');
    expect(menu()).toBeNull();

    type('Hey @');
    expect(options()).toEqual(['teacher', 'mia', 'max']);
    type('Hey @ma');
    expect(options()).toEqual(['max']);
    expect(textarea().getAttribute('aria-activedescendant')).toContain('option-0');
    type('Hey @zz');
    expect(menu()).toBeNull();
  });

  it('picks with the keyboard instead of sending, and puts "@Name " in the draft', async () => {
    const onMessageSend = vi.fn();
    await render({ onMessageSend });
    type('@m');
    expect(options()).toEqual(['teacher', 'mia', 'max']);
    press('ArrowDown');
    press('ArrowDown');
    const enter = press('Enter');
    expect(enter.defaultPrevented).toBe(true);
    expect(onMessageSend).not.toHaveBeenCalled();
    expect(textarea().value).toBe('@Max ');
    expect(menu()).toBeNull();

    // With the menu closed Enter sends again
    type('@Max why?');
    press('Enter');
    expect(onMessageSend).toHaveBeenCalledExactlyOnceWith('@Max why?');
  });

  it('closes only the menu on Escape (the composer keeps focus and the draft)', async () => {
    const outside = vi.fn();
    window.addEventListener('keydown', outside);
    await render();
    act(() => textarea().focus());
    type('@M');
    expect(menu()).not.toBeNull();
    press('Escape');
    expect(menu()).toBeNull();
    expect(document.activeElement).toBe(textarea());
    expect(textarea().value).toBe('@M');
    // The classroom's Escape (it would close the composer) never hears it
    expect(outside).not.toHaveBeenCalled();
    window.removeEventListener('keydown', outside);
  });

  it('picks with a click without taking focus from the textarea', async () => {
    await render();
    act(() => textarea().focus());
    type('ask @');
    const row = container.querySelector('[data-agent-id="mia"]') as HTMLElement;
    const down = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
    act(() => {
      row.dispatchEvent(down);
      row.click();
    });
    expect(down.defaultPrevented).toBe(true);
    expect(textarea().value).toBe('ask @Mia ');
  });

  it('addresses the draft from a classmate card ("ask them") and focuses it', async () => {
    const composerRef = createRef<ComposerHandle>();
    const onInputActivate = vi.fn();
    await render({ composerRef, onInputActivate });
    type('why does it cancel?');
    act(() => composerRef.current!.mention('Mia'));
    expect(textarea().value).toBe('@Mia why does it cancel?');
    expect(document.activeElement).toBe(textarea());
    expect(onInputActivate).toHaveBeenCalledWith('text');
    act(() => composerRef.current!.mention('Mia'));
    expect(textarea().value).toBe('@Mia why does it cancel?');
  });

  it('draws the names the draft addresses in the accent, over a transparent textarea ink', async () => {
    await render();
    const mirror = () => container.querySelector('[data-testid="composer-mention-mirror"]');
    type('why is it green?');
    expect(mirror()).toBeNull();
    expect(textarea().className).not.toContain('text-transparent');

    type('@Mia why is it green? @Ms. Lin');
    const names = [...mirror()!.querySelectorAll('[data-mention]')];
    expect(names.map((node) => [node.getAttribute('data-mention'), node.textContent])).toEqual([
      ['mia', '@Mia'],
      ['teacher', '@Ms. Lin'],
    ]);
    expect(names[0]!.className).toContain('text-accent-hover');
    // The mirror lays out the same string as the textarea, plus the closing newline
    expect(mirror()!.textContent).toBe('@Mia why is it green? @Ms. Lin\n');
    expect(mirror()!.getAttribute('aria-hidden')).toBe('true');
    expect(textarea().className).toContain('text-transparent');
    expect(textarea().className).toContain('caret-fg');

    // While an IME composes, the textarea draws its own ink again and the names
    // keep only their ground
    act(() => {
      textarea().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    });
    expect(textarea().className).not.toContain('text-transparent');
    expect(mirror()!.hasAttribute('data-inked')).toBe(false);
    expect(mirror()!.querySelector('[data-mention]')!.className).not.toContain('text-accent-hover');
    act(() => {
      textarea().dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    });
    expect(textarea().className).toContain('text-transparent');
  });

  it('has no menu without people to address', async () => {
    await act(async () => root.render(createElement(Composer, {})));
    type('@');
    expect(menu()).toBeNull();
    expect(textarea().placeholder).toBe('roundtable.inputPlaceholder');
  });
});
