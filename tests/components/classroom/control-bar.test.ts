// @vitest-environment jsdom

/**
 * The shell-owned 48px control bar (Classroom.dc.html): the localized page
 * counter, prev / primary play / next, the red stop pill that replaces play
 * during a Q&A / discussion (prev / next disabled), the speed cycle, the
 * labeled whiteboard toggle and the "Reference content" entry.
 */
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => ({ whiteboardElements: 0 }));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}(${Object.values(options).join('/')})` : key,
  }),
}));
vi.mock('@/lib/store', () => ({
  useStageStore: (
    selector: (state: { stage: { whiteboard: { elements: unknown[] }[] } }) => unknown,
  ) => selector({ stage: { whiteboard: [{ elements: new Array(store.whiteboardElements) }] } }),
}));

import { ControlBar, type ControlBarProps } from '@/components/classroom/control-bar';
import { getNextPlaybackSpeed } from '@/components/canvas/use-playback-controls';

describe('ControlBar', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    store.whiteboardElements = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function baseProps(overrides: Partial<ControlBarProps> = {}): ControlBarProps {
    return {
      currentSceneIndex: 1,
      scenesCount: 4,
      engineState: 'idle',
      onPrev: vi.fn(),
      onNext: vi.fn(),
      onPlayPause: vi.fn(),
      whiteboardOpen: false,
      onToggleWhiteboard: vi.fn(),
      onStop: vi.fn(),
      onTogglePresentation: vi.fn(),
      onToggleMute: vi.fn(),
      ttsEnabled: true,
      onToggleAutoPlay: vi.fn(),
      onCycleSpeed: vi.fn(),
      ...overrides,
    };
  }

  function render(props: ControlBarProps) {
    act(() => root.render(createElement(ControlBar, props)));
  }

  const button = (label: string) =>
    container.querySelector(`button[aria-label="${label}"]`) as HTMLButtonElement | null;
  const buttonWithText = (text: string) =>
    [...container.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) ?? null;

  it('shows the localized page counter and the primary play circle', () => {
    const props = baseProps();
    render(props);
    expect(container.querySelector('[data-testid="page-counter"]')?.textContent).toBe(
      'stage.pageCounter(2/4)',
    );

    const play = button('stage.play')!;
    expect(play.className).toContain('rounded-full');
    expect(play.className).toContain('bg-primary');
    act(() => play.click());
    expect(props.onPlayPause).toHaveBeenCalledOnce();

    render(baseProps({ engineState: 'playing' }));
    expect(button('stage.pause')).not.toBeNull();
    expect(button('stage.play')).toBeNull();
  });

  it.each([
    ['qa', 'roundtable.stopQA'],
    ['discussion', 'roundtable.stopDiscussion'],
  ] as const)('replaces play with the %s stop pill', (stopKind, label) => {
    const props = baseProps({ showStop: true, stopKind });
    render(props);

    expect(button('stage.play')).toBeNull();
    expect(button('stage.pause')).toBeNull();
    const stop = buttonWithText(label)!;
    expect(stop.className).toContain('bg-danger-soft');
    expect(stop.className).toContain('text-danger');
    act(() => stop.click());
    expect(props.onStop).toHaveBeenCalledOnce();
  });

  it('disables prev / next during a session (the stop pill is the way out)', () => {
    render(baseProps());
    expect(button('stage.previousScene')!.disabled).toBe(false);
    expect(button('stage.nextScene')!.disabled).toBe(false);

    render(baseProps({ showStop: true }));
    expect(button('stage.previousScene')!.disabled).toBe(true);
    expect(button('stage.nextScene')!.disabled).toBe(true);
    expect(button('stage.nextScene')!.className).toContain('disabled:opacity-30');
  });

  it('disables prev on the first page and next on the last', () => {
    render(baseProps({ currentSceneIndex: 0 }));
    expect(button('stage.previousScene')!.disabled).toBe(true);
    render(baseProps({ currentSceneIndex: 3 }));
    expect(button('stage.nextScene')!.disabled).toBe(true);
  });

  it('offers a pause / resume button for the live answer beside the stop pill', () => {
    // No handler, no button (the fullscreen pill and older callers)
    render(baseProps({ showStop: true }));
    expect(button('stage.pauseAnswer')).toBeNull();
    expect(button('stage.resumeAnswer')).toBeNull();

    // Before any text arrives the answer cannot be paused yet
    const onToggleLivePause = vi.fn();
    render(baseProps({ showStop: true, onToggleLivePause, canToggleLivePause: false }));
    expect(button('stage.pauseAnswer')!.disabled).toBe(true);

    render(baseProps({ showStop: true, onToggleLivePause, canToggleLivePause: true }));
    const pause = button('stage.pauseAnswer')!;
    expect(pause.disabled).toBe(false);
    act(() => pause.click());
    expect(onToggleLivePause).toHaveBeenCalledOnce();

    // Paused: the same button resumes (always allowed)
    render(baseProps({ showStop: true, onToggleLivePause, livePaused: true }));
    const resume = button('stage.resumeAnswer')!;
    expect(resume.disabled).toBe(false);
    act(() => resume.click());
    expect(onToggleLivePause).toHaveBeenCalledTimes(2);

    // Outside a session the primary play circle is the only play control
    render(baseProps({ onToggleLivePause, canToggleLivePause: true }));
    expect(button('stage.pauseAnswer')).toBeNull();
  });

  it('cycles the playback speed through 1x → 1.25x → 1.5x → 2x → 1x', () => {
    function Harness() {
      const [speed, setSpeed] = useState(1);
      return createElement(
        ControlBar,
        baseProps({
          playbackSpeed: speed,
          onCycleSpeed: () => setSpeed((s) => getNextPlaybackSpeed(s)),
        }),
      );
    }
    act(() => root.render(createElement(Harness)));
    const speed = () => button('stage.playbackSpeed')!;
    const seen = [speed().textContent];
    for (let i = 0; i < 4; i++) {
      act(() => speed().click());
      seen.push(speed().textContent);
    }
    expect(seen).toEqual(['1x', '1.25x', '1.5x', '2x', '1x']);
    // A non-default speed is highlighted
    act(() => speed().click());
    expect(speed().className).toContain('text-accent-text');
  });

  it('labels the whiteboard toggle and reports its pressed state', () => {
    const props = baseProps();
    render(props);
    const closed = container.querySelector('button[title="whiteboard.open"]') as HTMLButtonElement;
    expect(closed.textContent).toContain('stage.whiteboardToggle');
    expect(closed.getAttribute('aria-pressed')).toBe('false');
    act(() => closed.click());
    expect(props.onToggleWhiteboard).toHaveBeenCalledOnce();

    render(baseProps({ whiteboardOpen: true }));
    const open = container.querySelector('button[title="whiteboard.minimize"]')!;
    expect(open.getAttribute('aria-pressed')).toBe('true');
    expect(open.className).toContain('bg-accent-soft');
    expect(open.className).toContain('ring-accent-line');
  });

  it('marks a closed whiteboard that has content', () => {
    render(baseProps());
    const toggle = () => container.querySelector('button[title="whiteboard.open"]')!;
    expect(toggle().querySelector('span[aria-hidden="true"]')).toBeNull();
    store.whiteboardElements = 2;
    render(baseProps({ currentSceneIndex: 2 }));
    expect(toggle().querySelector('span[aria-hidden="true"]')).not.toBeNull();
  });

  it('hides the "Reference content" entry when the feature is off', () => {
    render(baseProps({ showElementReference: false }));
    expect(button('chat.elementReference.button')).toBeNull();

    const onToggleElementPick = vi.fn();
    render(
      baseProps({
        showElementReference: true,
        canPickElement: true,
        elementPickActive: true,
        onToggleElementPick,
      }),
    );
    const reference = button('chat.elementReference.button')!;
    expect(reference.getAttribute('aria-pressed')).toBe('true');
    act(() => reference.click());
    expect(onToggleElementPick).toHaveBeenCalledOnce();

    render(baseProps({ showElementReference: true, canPickElement: false }));
    expect(button('chat.elementReference.button')!.disabled).toBe(true);
  });

  it('labels mute by state and disables it without narration', () => {
    render(baseProps({ ttsMuted: true }));
    expect(button('stage.unmute')).not.toBeNull();
    render(baseProps({ ttsEnabled: false }));
    expect(button('stage.mute')!.disabled).toBe(true);
  });

  it('renders the fullscreen pill variant while presenting', () => {
    render(baseProps({ variant: 'floating', isPresenting: true }));
    const bar = container.querySelector('[data-testid="control-bar"]')!;
    expect(bar.getAttribute('data-variant')).toBe('floating');
    expect(bar.className).toContain('rounded-full');
    expect(button('stage.exitFullscreen')).not.toBeNull();
  });
});
