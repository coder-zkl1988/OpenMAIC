// @vitest-environment jsdom
/**
 * The stage column in board mode (ClassroomWhiteboard.dc.html): the board card
 * takes the slide's slot, the caption narrows beside a 192×108 PiP and the
 * still-mounted slide is FLIP-transformed into it — never resized, so the
 * global canvasScale stays put. The PiP is a real button over an inert slide;
 * reduced motion swaps instantly.
 */
import { act, createElement, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ reduced: false }));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));
// Motion's targets and timings land in data attributes, where the test reads them
vi.mock('motion/react', async () => {
  const React = await import('react');
  const div = React.forwardRef<HTMLDivElement, Record<string, unknown>>(
    function MotionDiv(props, ref) {
      const { initial, animate, exit, transition, ...rest } = props;
      void initial;
      void exit;
      return React.createElement('div', {
        ...rest,
        ref,
        'data-animate': JSON.stringify(animate ?? null),
        'data-transition': JSON.stringify(transition ?? null),
      });
    },
  );
  return {
    AnimatePresence: ({ children }: { children: ReactNode }) => children,
    MotionConfig: ({ children }: { children: ReactNode }) => children,
    motion: { div },
    useReducedMotion: () => mocks.reduced,
  };
});

import {
  CAPTION_HEIGHT,
  FLOATING_INSET,
  FLOATING_STRIP,
  PIP_HEIGHT,
  PIP_WIDTH,
  StageColumn,
  computeStageGeometry,
  type StageColumnProps,
} from '@/components/classroom/stage-column';

describe('computeStageGeometry', () => {
  it('lands the slide box on the PiP to the right of the caption, at 192px wide', () => {
    // 1000 × 700 column: the slide slot is 700 − 92 − 12 = 596 tall, so the
    // 16:9 box is width-bound (1000 × 562.5) and centred 16.75px down
    const { flip, card } = computeStageGeometry({
      width: 1000,
      height: 700,
      hasCaption: true,
      floatingPip: false,
    });
    expect(flip.scale * 1000).toBeCloseTo(PIP_WIDTH);
    expect(flip.x).toBeCloseTo(1000 - PIP_WIDTH);
    expect(flip.y).toBeCloseTo(700 - PIP_HEIGHT - flip.scale * 16.75);
    // The board slot is 700 − 108 − 12 = 580 tall: the card fills it and hugs
    // its 16:9 sheet (+ 44px header, 12px padding and the border)
    expect(card?.height).toBeCloseTo(580);
    expect(((card!.width - 26) * 9) / 16).toBeCloseTo(card!.height - 70);
  });

  it('floats the PiP top left, in a strip the board card leaves it, without a caption row', () => {
    // Fullscreen: the presentation dock owns the bottom corners (the teacher's
    // line bottom left), so the PiP sits top left and the card gives it room
    const { flip, card } = computeStageGeometry({
      width: 1600,
      height: 900,
      hasCaption: false,
      floatingPip: true,
    });
    expect(FLOATING_INSET).toBe(16);
    expect(FLOATING_STRIP).toBe(16 + PIP_WIDTH + 12);
    expect(flip.scale * 1600).toBeCloseTo(PIP_WIDTH);
    expect(flip.x).toBeCloseTo(FLOATING_INSET);
    // The 1600 × 900 slide box fills the column: no centring offset
    expect(flip.y).toBeCloseTo(FLOATING_INSET);
    // The card fits the column minus the strip (and its full height)
    expect(card!.width).toBeLessThanOrEqual(1600 - FLOATING_STRIP + 1e-6);
    expect(card!.height).toBeLessThanOrEqual(900 + 1e-6);
    expect(Math.max(card!.width - (1600 - FLOATING_STRIP), card!.height - 900)).toBeCloseTo(0);
  });

  it('is an identity morph before the column has been measured', () => {
    const geometry = computeStageGeometry({
      width: 0,
      height: 0,
      hasCaption: true,
      floatingPip: false,
    });
    expect(geometry.flip).toEqual({ x: 0, y: 0, scale: 1 });
    expect(geometry.card).toBeNull();
  });
});

describe('StageColumn', () => {
  let container: HTMLDivElement;
  let root: Root;
  let renderScene: ReturnType<typeof vi.fn<StageColumnProps['renderScene']>>;
  let onReturn: ReturnType<typeof vi.fn<() => void>>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    vi.useFakeTimers();
    mocks.reduced = false;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    renderScene = vi.fn(({ docked }) =>
      createElement('div', { 'data-testid': 'slide', 'data-docked': String(docked) }),
    );
    onReturn = vi.fn<() => void>();
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function render(props: Partial<StageColumnProps> = {}) {
    act(() =>
      root.render(
        createElement(StageColumn, {
          boardOpen: false,
          pipKind: 'slide',
          pageNumber: 3,
          onReturn,
          renderScene,
          board: createElement('section', { 'aria-label': 'board' }),
          caption: createElement('div', { 'data-testid': 'caption' }),
          ...props,
        }),
      ),
    );
  }

  const byTestId = (id: string) => container.querySelector<HTMLElement>(`[data-testid="${id}"]`);
  const sceneLayer = () => byTestId('stage-scene')!;
  const sceneBody = () => sceneLayer().firstElementChild as HTMLElement;

  it('slide mode: the live slide, a full-width 92px caption and no PiP', () => {
    render();
    expect(byTestId('slide')?.dataset.docked).toBe('false');
    expect(sceneBody().hasAttribute('inert')).toBe(false);
    expect(byTestId('whiteboard-pip')).toBeNull();
    const caption = byTestId('stage-caption')!;
    expect(caption.style.width).toBe('100%');
    expect(caption.style.height).toBe(`${CAPTION_HEIGHT}px`);
    // The slide keeps the slot above the caption in both modes
    expect(sceneLayer().style.bottom).toBe(`${CAPTION_HEIGHT + 12}px`);
  });

  it('board mode: the slide stays mounted but inert, under a labelled PiP button', () => {
    render({ boardOpen: true });
    const slide = byTestId('slide')!;
    expect(slide.dataset.docked).toBe('true');
    expect(sceneBody().hasAttribute('inert')).toBe(true);
    expect(sceneBody().getAttribute('aria-hidden')).toBe('true');
    // Same layout box: only a transform moves it
    expect(sceneLayer().style.bottom).toBe(`${CAPTION_HEIGHT + 12}px`);
    expect(JSON.parse(sceneLayer().dataset.animate!)).toMatchObject({ opacity: 1 });
    expect(JSON.parse(sceneLayer().dataset.transition!)).toMatchObject({ duration: 0.55 });

    const pip = byTestId('whiteboard-pip')!;
    expect(pip.tagName).toBe('BUTTON');
    expect(pip.getAttribute('aria-label')).toBe('stage.pip.returnLabel:{"n":3}');
    expect(pip.getAttribute('title')).toBe('stage.pip.return');
    expect(byTestId('stage-pip')!.textContent).toContain('stage.pip.badge:{"n":3}');
    act(() => pip.click());
    expect(onReturn).toHaveBeenCalledTimes(1);

    const caption = byTestId('stage-caption')!;
    expect(caption.style.width).toBe(`calc(100% - ${PIP_WIDTH + 12}px)`);
    expect(caption.style.height).toBe(`${PIP_HEIGHT}px`);
  });

  it('keeps the slide docked until it has flown back, then releases it', () => {
    render({ boardOpen: true });
    render({ boardOpen: false });
    expect(byTestId('whiteboard-pip')).toBeNull();
    expect(byTestId('slide')?.dataset.docked).toBe('true');
    expect(sceneBody().hasAttribute('inert')).toBe(true);
    act(() => vi.advanceTimersByTime(550));
    expect(byTestId('slide')?.dataset.docked).toBe('false');
    expect(sceneBody().hasAttribute('inert')).toBe(false);
  });

  it('reduced motion: an instant swap both ways', () => {
    mocks.reduced = true;
    render({ boardOpen: true });
    expect(JSON.parse(sceneLayer().dataset.transition!)).toEqual({ duration: 0 });
    expect(JSON.parse(byTestId('stage-pip')!.dataset.animate!)).toMatchObject({
      transition: { duration: 0 },
    });
    render({ boardOpen: false });
    // No flight back to wait for
    expect(byTestId('slide')?.dataset.docked).toBe('false');
  });

  it('a non-slide scene fades out and the PiP shows its card instead', () => {
    render({
      boardOpen: true,
      pipKind: 'card',
      pipCard: createElement('span', { 'data-testid': 'pip-card' }, 'Quiz'),
    });
    expect(JSON.parse(sceneLayer().dataset.animate!)).toMatchObject({ opacity: 0, scale: 1 });
    expect(byTestId('stage-pip')!.contains(byTestId('pip-card'))).toBe(true);
  });

  it('without a caption row the PiP floats top left and the board leaves it a strip', () => {
    render({ boardOpen: true, caption: undefined, floatingPip: true });
    expect(byTestId('stage-caption')).toBeNull();
    expect(sceneLayer().style.bottom).toBe('0px');
    // top-4 left-4 is FLOATING_INSET, as computeStageGeometry flies the slide
    expect(byTestId('stage-pip')!.className).toContain('top-4');
    expect(byTestId('stage-pip')!.className).toContain('left-4');
    expect(byTestId('stage-pip')!.className).not.toContain('bottom-');
    const boardSlot = container.querySelector<HTMLElement>('section[aria-label="board"]')!
      .parentElement!.parentElement!;
    expect(boardSlot.style.left).toBe(`${FLOATING_STRIP}px`);
    expect(boardSlot.style.bottom).toBe('0px');
  });

  it('puts the scene layer class on the scene only, not on the column', () => {
    render({ boardOpen: true, className: 'col', sceneClassName: 'overflow-hidden' });
    expect(sceneLayer().className).toContain('overflow-hidden');
    expect(byTestId('stage-column')!.className).not.toContain('overflow-hidden');
  });

  it('scales the docked slide corners so they match the PiP ring at its real size', () => {
    const width = vi
      .spyOn(HTMLElement.prototype, 'clientWidth', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'stage-column' ? 1000 : 0;
      });
    const height = vi
      .spyOn(HTMLElement.prototype, 'clientHeight', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return this.dataset.testid === 'stage-column' ? 700 : 0;
      });
    try {
      render();
      expect(sceneBody().style.getPropertyValue('--stage-scene-radius')).toBe('10px');
      render({ boardOpen: true });
      // 192 / 1000 scale: 10 / 0.192 at full size is 10px once docked
      const radius = parseFloat(sceneBody().style.getPropertyValue('--stage-scene-radius'));
      expect(radius * (PIP_WIDTH / 1000)).toBeCloseTo(10);
    } finally {
      width.mockRestore();
      height.mockRestore();
    }
  });

  it('a keyboard return from the PiP lands focus on the slide, not on <body>', () => {
    onReturn.mockImplementation(() => render({ boardOpen: false }));
    render({ boardOpen: true });
    const pip = byTestId('whiteboard-pip')!;
    act(() => pip.focus());
    expect(document.activeElement).toBe(pip);
    // Enter / Space on a <button> dispatch a click
    act(() => pip.click());
    expect(onReturn).toHaveBeenCalledTimes(1);
    expect(byTestId('whiteboard-pip')).toBeNull();
    // The slide is inert while it flies back; focus waits for it to land
    act(() => vi.advanceTimersByTime(550));
    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(sceneBody());
    expect(sceneBody().getAttribute('aria-label')).toBe('stage.currentScene');
  });

  it('reduced motion: the keyboard return focuses the slide at once', () => {
    mocks.reduced = true;
    onReturn.mockImplementation(() => render({ boardOpen: false }));
    render({ boardOpen: true });
    const pip = byTestId('whiteboard-pip')!;
    act(() => pip.focus());
    act(() => pip.click());
    expect(document.activeElement).toBe(sceneBody());
  });
});
