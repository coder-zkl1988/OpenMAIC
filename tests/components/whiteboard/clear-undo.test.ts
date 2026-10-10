// @vitest-environment jsdom
import { act, createElement, forwardRef, useImperativeHandle } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';

import type { AgentConfig } from '@/lib/orchestration/registry/types';
import { useAgentRegistry } from '@/lib/orchestration/registry/store';
import { useCanvasStore } from '@/lib/store/canvas';
import { useSettingsStore } from '@/lib/store/settings';
import { useStageStore } from '@/lib/store/stage';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';

type ViewChange = (view: { zoom: number; modified: boolean }) => void;

const canvas = vi.hoisted(() => ({
  zoomBy: vi.fn(),
  fit: vi.fn(),
  /** Called with the canvas props on every render. */
  render: vi.fn(),
}));

/** The latest `onViewChange` the board handed the canvas. */
const reportView = (view: { zoom: number; modified: boolean }) =>
  (canvas.render.mock.lastCall![0] as { onViewChange: ViewChange }).onViewChange(view);

vi.mock('motion/react', async () => (await import('./motion-stub')).motionStub);
vi.mock('@/components/whiteboard/whiteboard-canvas', () => ({
  WHITEBOARD_MIN_ZOOM: 0.2,
  WHITEBOARD_MAX_ZOOM: 5,
  WhiteboardCanvas: forwardRef(function WhiteboardCanvas(
    props: { onViewChange?: ViewChange },
    ref,
  ) {
    canvas.render(props);
    useImperativeHandle(ref, () => ({
      resetView: vi.fn(),
      zoomBy: canvas.zoomBy,
      fit: canvas.fit,
    }));
    return null;
  }),
}));
vi.mock('@/components/slide-renderer/SlideThumbnail', () => ({
  SlideThumbnail: () => null,
}));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));
vi.mock('@/lib/whiteboard/runtime/browser-projection', () => ({
  refreshWhiteboardRuntimeProjection: vi.fn(async () => true),
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { Whiteboard } from '@/components/whiteboard';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function textElement(id: string, content: string): PPTElement {
  return {
    id,
    type: 'text',
    content: `<p>${content}</p>`,
    left: 10,
    top: 10,
    width: 200,
    height: 40,
    rotate: 0,
    defaultFontName: 'Arial',
    defaultColor: '#111111',
  } as PPTElement;
}

const ELEMENTS = [textElement('t-1', 'Buoyancy'), textElement('t-2', 'equals weight')];

function seedBoard(elements: PPTElement[] = ELEMENTS) {
  useStageStore.setState({
    stage: {
      id: 'stage-1',
      name: 'Stage',
      createdAt: 1,
      updatedAt: 1,
      whiteboard: [{ id: 'wb-1', viewportSize: 1200, viewportRatio: 0.5, elements }],
    } as never,
  });
}

let root: Root | null = null;

async function renderBoard(props: Partial<Parameters<typeof Whiteboard>[0]> = {}) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(createElement(Whiteboard, { isOpen: true, ...props }));
  });
}

const button = (label: string) =>
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
const clearedStatus = () => document.querySelector('[data-testid="whiteboard-cleared-status"]');

async function clearBoard() {
  await act(async () => {
    button('whiteboard.clear')!.click();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1500);
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  seedBoard();
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  vi.useRealTimers();
  useStageStore.setState({ stage: null });
  useCanvasStore.setState({
    whiteboardOpen: false,
    whiteboardClearing: false,
    whiteboardDrawing: null,
    runtimeWhiteboardProjection: null,
    runtimeWhiteboardProjectionGeneration: 0,
  });
  useWhiteboardHistoryStore.getState().clearHistory();
  canvas.zoomBy.mockReset();
  canvas.fit.mockReset();
  canvas.render.mockReset();
  document.body.innerHTML = '';
});

describe('Whiteboard clear with undo', () => {
  it('clears the board and offers an in-card undo', async () => {
    await renderBoard();
    await clearBoard();

    expect(useStageStore.getState().stage!.whiteboard).toEqual([]);
    const status = clearedStatus();
    expect(status).not.toBeNull();
    expect(status!.getAttribute('role')).toBe('status');
    expect(status!.textContent).toContain('whiteboard.clearSuccess');
    expect(button('whiteboard.clear')!.disabled).toBe(true);
  });

  it('undo restores exactly the cleared board on a new whiteboard id', async () => {
    await renderBoard();
    await clearBoard();

    const undo = [...clearedStatus()!.querySelectorAll('button')].find(
      (node) => node.textContent === 'whiteboard.undo',
    )!;
    await act(async () => undo.click());

    const boards = useStageStore.getState().stage!.whiteboard!;
    expect(boards).toHaveLength(1);
    expect(boards[0].id).not.toBe('wb-1');
    expect(boards[0].elements).toEqual(ELEMENTS);
    expect(boards[0].viewportSize).toBe(1200);
    expect(boards[0].viewportRatio).toBe(0.5);
    expect(clearedStatus()).toBeNull();
  });

  it('records the cleared board in history with its sheet geometry', async () => {
    await renderBoard();
    await clearBoard();

    const [snapshot] = useWhiteboardHistoryStore.getState().snapshots;
    expect(snapshot.elements).toEqual(ELEMENTS);
    expect(snapshot.viewportSize).toBe(1200);
    expect(snapshot.viewportRatio).toBe(0.5);
  });

  it('retires the undo once new content shows on the board', async () => {
    await renderBoard();
    await clearBoard();
    expect(clearedStatus()).not.toBeNull();

    await act(async () => seedBoard([textElement('t-9', 'New drawing')]));
    expect(clearedStatus()).toBeNull();
  });

  it('dismisses the undo after a few seconds', async () => {
    await renderBoard();
    await clearBoard();
    expect(clearedStatus()).not.toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(8000);
    });
    expect(clearedStatus()).toBeNull();
  });

  it('keeps clear and history hidden while the runtime store is authoritative', async () => {
    useCanvasStore.setState({
      runtimeWhiteboardProjection: {
        stageId: 'stage-1',
        lastSeq: 3,
        whiteboard: { id: 'rt-1', viewportSize: 1000, viewportRatio: 0.5625, elements: ELEMENTS },
      },
    });
    await renderBoard();

    expect(button('whiteboard.clear')).toBeNull();
    expect(document.querySelector('button[title="whiteboard.history"]')).toBeNull();
    expect(button('whiteboard.zoomIn')).not.toBeNull();
  });
});

describe('Whiteboard header', () => {
  it('disables zoom and clear on an empty board and shows 100%', async () => {
    seedBoard([]);
    await renderBoard();

    expect(button('whiteboard.zoomIn')!.disabled).toBe(true);
    expect(button('whiteboard.zoomOut')!.disabled).toBe(true);
    expect(button('whiteboard.fit')!.disabled).toBe(true);
    expect(button('whiteboard.clear')!.disabled).toBe(true);
    expect(document.querySelector('[data-testid="whiteboard-zoom-level"]')!.textContent).toBe(
      '100%',
    );
    // History stays reachable on an empty board.
    expect(
      document.querySelector<HTMLButtonElement>('button[title="whiteboard.history"]')!.disabled,
    ).toBe(false);
  });

  it('shows the drawing chip only while an agent draws', async () => {
    useSettingsStore.setState({ selectedAgentIds: [] });
    await renderBoard();
    const chip = () => document.querySelector('[data-testid="whiteboard-drawing-chip"]');
    expect(chip()).toBeNull();

    await act(async () => useCanvasStore.getState().setWhiteboardDrawing({ agentId: null }));
    expect(chip()).not.toBeNull();

    await act(async () => useCanvasStore.getState().setWhiteboardDrawing(null));
    expect(chip()).toBeNull();
  });

  it('follows the zoom the canvas reports and steps by 1.25', async () => {
    await renderBoard();
    const level = () => document.querySelector('[data-testid="whiteboard-zoom-level"]')!;
    expect(level().getAttribute('aria-live')).toBe('polite');
    expect(canvas.render).toHaveBeenCalled();

    await act(async () => reportView({ zoom: 1.25, modified: true }));
    expect(level().textContent).toBe('125%');

    await act(async () => button('whiteboard.zoomIn')!.click());
    await act(async () => button('whiteboard.zoomOut')!.click());
    await act(async () => button('whiteboard.fit')!.click());
    expect(canvas.zoomBy.mock.calls).toEqual([[1.25], [0.8]]);
    expect(canvas.fit).toHaveBeenCalledTimes(1);
  });

  it('marks zoom in/out unavailable at the limits but keeps them focusable', async () => {
    await renderBoard();
    const zoomIn = () => button('whiteboard.zoomIn')!;
    const zoomOut = () => button('whiteboard.zoomOut')!;
    expect(zoomIn().getAttribute('aria-disabled')).toBeNull();
    expect(zoomOut().getAttribute('aria-disabled')).toBeNull();

    await act(async () => reportView({ zoom: 5, modified: true }));
    expect(document.querySelector('[data-testid="whiteboard-zoom-level"]')!.textContent).toBe(
      '500%',
    );
    expect(zoomIn().disabled).toBe(false);
    expect(zoomIn().getAttribute('aria-disabled')).toBe('true');
    expect(zoomOut().getAttribute('aria-disabled')).toBeNull();
    zoomIn().focus();
    await act(async () => zoomIn().click());
    expect(canvas.zoomBy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(zoomIn());

    await act(async () => reportView({ zoom: 0.2, modified: true }));
    expect(zoomOut().getAttribute('aria-disabled')).toBe('true');
    expect(zoomIn().getAttribute('aria-disabled')).toBeNull();
    await act(async () => zoomOut().click());
    expect(canvas.zoomBy).not.toHaveBeenCalled();
  });

  it('wires the history trigger to the popover with aria-expanded and Escape', async () => {
    useWhiteboardHistoryStore.getState().pushSnapshot([textElement('old', 'Earlier')]);
    await renderBoard();
    const trigger = document.querySelector<HTMLButtonElement>(
      'button[title="whiteboard.history"]',
    )!;
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(trigger.getAttribute('aria-label')).toBe('whiteboard.historyWithCount {"count":1}');

    await act(async () => trigger.click());
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(trigger.getAttribute('aria-controls')).toBe(dialog!.id);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('shows the crosshair pick overlay with its hint while picking an element', async () => {
    await renderBoard({
      elementPickActive: true,
      onPickElement: vi.fn(),
      onCancelElementPick: vi.fn(),
    });

    const overlay = document.querySelector('[data-testid="whiteboard-element-pick-overlay"]')!;
    expect(overlay.className).toContain('cursor-crosshair');
    const hint = document.querySelector('[data-testid="whiteboard-element-pick-overlay-hint"]')!;
    expect(hint.getAttribute('role')).toBe('status');
    expect(hint.textContent).toBe('chat.elementReference.instruction');
  });
});

function agent(id: string, name: string, role: string, priority: number): AgentConfig {
  return {
    id,
    name,
    role,
    persona: '',
    avatar: `${id}.png`,
    color: '#000000',
    allowedActions: [],
    priority,
    createdAt: new Date(0),
    updatedAt: new Date(0),
    isDefault: false,
  };
}

describe('Whiteboard drawing chip name', () => {
  // The label only; the avatar renders beside it.
  const chipText = () =>
    document.querySelector('[data-testid="whiteboard-drawing-chip"] > span.truncate')!.textContent;
  let savedAgents: ReturnType<typeof useAgentRegistry.getState>['agents'];
  let savedSelected: string[];

  beforeEach(() => {
    savedAgents = useAgentRegistry.getState().agents;
    savedSelected = useSettingsStore.getState().selectedAgentIds;
    const agents = Object.create(null) as Record<string, AgentConfig>;
    for (const a of [
      agent('t-teacher', 'Ms. Rivera', 'teacher', 10),
      agent('t-assistant', 'Leo', 'assistant', 5),
      agent('t-guest', 'Guest Expert', 'assistant', 1),
    ]) {
      agents[a.id] = a;
    }
    useAgentRegistry.setState({ agents });
    useSettingsStore.setState({ selectedAgentIds: ['t-assistant', 't-teacher'] });
  });

  afterEach(() => {
    useAgentRegistry.setState({ agents: savedAgents });
    useSettingsStore.setState({ selectedAgentIds: savedSelected });
  });

  it('names the participant who draws', async () => {
    await renderBoard();
    await act(async () =>
      useCanvasStore.getState().setWhiteboardDrawing({ agentId: 't-assistant' }),
    );
    expect(chipText()).toBe('whiteboard.drawing {"name":"Leo"}');
  });

  it('falls back to the agent registry for an agent outside the class', async () => {
    await renderBoard();
    await act(async () => useCanvasStore.getState().setWhiteboardDrawing({ agentId: 't-guest' }));
    expect(chipText()).toBe('whiteboard.drawing {"name":"Guest Expert"}');
  });

  it('names the teacher when the drawing agent is unknown or unset', async () => {
    await renderBoard();
    await act(async () => useCanvasStore.getState().setWhiteboardDrawing({ agentId: null }));
    expect(chipText()).toBe('whiteboard.drawing {"name":"Ms. Rivera"}');

    await act(async () => useCanvasStore.getState().setWhiteboardDrawing({ agentId: 'gone' }));
    expect(chipText()).toBe('whiteboard.drawing {"name":"Ms. Rivera"}');
  });

  it('is anonymous with no teacher and no known agent', async () => {
    useSettingsStore.setState({ selectedAgentIds: [] });
    await renderBoard();
    await act(async () => useCanvasStore.getState().setWhiteboardDrawing({ agentId: 'gone' }));
    expect(chipText()).toBe('whiteboard.drawingAnonymous');
  });
});

describe('Whiteboard history popover across a close', () => {
  it('does not reopen (or take focus) after a close that skipped the popover', async () => {
    useWhiteboardHistoryStore.getState().pushSnapshot([textElement('old', 'Earlier')]);
    await renderBoard();
    await act(async () =>
      document.querySelector<HTMLButtonElement>('button[title="whiteboard.history"]')!.click(),
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();

    // A programmatic close (AI wb_close) while the popover is open…
    await act(async () => root!.render(createElement(Whiteboard, { isOpen: false })));
    const composer = document.createElement('textarea');
    document.body.appendChild(composer);
    composer.focus();

    // …then the board opens again on its own.
    await act(async () => root!.render(createElement(Whiteboard, { isOpen: true })));
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(
      document
        .querySelector<HTMLButtonElement>('button[title="whiteboard.history"]')!
        .getAttribute('aria-expanded'),
    ).toBe('false');
    expect(document.activeElement).toBe(composer);
  });
});
