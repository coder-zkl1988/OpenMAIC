// @vitest-environment jsdom
import { act, createElement, createRef, Fragment } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';

import { useCanvasStore } from '@/lib/store/canvas';
import { useStageStore } from '@/lib/store/stage';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';

const mocks = vi.hoisted(() => ({
  thumbnail: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('motion/react', async () => (await import('./motion-stub')).motionStub);
vi.mock('@/components/slide-renderer/SlideThumbnail', () => ({
  SlideThumbnail: (props: { slide: { elements: unknown[]; viewportSize: number } }) => {
    mocks.thumbnail(props);
    return null;
  },
}));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}));
vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import { WhiteboardHistory } from '@/components/whiteboard/whiteboard-history';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function textElement(id: string): PPTElement {
  return {
    id,
    type: 'text',
    content: `<p>${id}</p>`,
    left: 0,
    top: 0,
    width: 100,
    height: 40,
    rotate: 0,
    defaultFontName: 'Arial',
    defaultColor: '#111111',
  } as PPTElement;
}

const onClose = vi.fn();
let root: Root | null = null;

const triggerRef = createRef<HTMLButtonElement>();

function Harness({ isOpen }: { isOpen: boolean }) {
  return createElement(
    Fragment,
    null,
    createElement('button', { ref: triggerRef, type: 'button', id: 'trigger' }, 'History'),
    createElement('button', { type: 'button', id: 'elsewhere' }, 'Elsewhere'),
    createElement(WhiteboardHistory, { isOpen, onClose, triggerRef, id: 'history-panel' }),
  );
}

async function render(isOpen = true) {
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root!.render(createElement(Harness, { isOpen })));
}

const restoreButtons = () =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')].filter((node) =>
    node.getAttribute('aria-label')?.startsWith('whiteboard.restoreSnapshot'),
  );

beforeEach(() => {
  useStageStore.setState({
    stage: {
      id: 'stage-1',
      name: 'Stage',
      createdAt: 1,
      updatedAt: 1,
      whiteboard: [
        { id: 'wb-1', viewportSize: 1000, viewportRatio: 0.5625, elements: [textElement('now')] },
      ],
    } as never,
  });
  const history = useWhiteboardHistoryStore.getState();
  history.pushSnapshot([textElement('first')], { viewportSize: 1200, viewportRatio: 0.5 });
  history.pushSnapshot([textElement('second'), textElement('third')]);
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  onClose.mockReset();
  mocks.thumbnail.mockReset();
  mocks.toastSuccess.mockReset();
  mocks.toastError.mockReset();
  useStageStore.setState({ stage: null });
  useCanvasStore.setState({ whiteboardClearing: false });
  useWhiteboardHistoryStore.getState().clearHistory();
  document.body.innerHTML = '';
});

describe('WhiteboardHistory popover', () => {
  it('is a labelled dialog listing snapshots newest first with the count', async () => {
    await render();
    const dialog = document.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-label')).toBe('whiteboard.history');
    expect(dialog.id).toBe('history-panel');
    expect(dialog.textContent).toContain('2');

    const rows = [...dialog.querySelectorAll('li')];
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('#2'),
      expect.stringContaining('#1'),
    ]);
    expect(rows[0].textContent).toContain('whiteboard.elementCount {"count":2}');
  });

  it('keeps Restore always visible and individually labelled (touch + keyboard)', async () => {
    await render();
    const buttons = restoreButtons();
    expect(buttons).toHaveLength(2);
    for (const node of buttons) {
      expect(node.className).not.toMatch(/opacity-0|group-hover/);
      expect(node.textContent).toContain('whiteboard.restore');
    }
    expect(buttons.map((node) => node.getAttribute('aria-label'))).toEqual([
      'whiteboard.restoreSnapshot {"index":2}',
      'whiteboard.restoreSnapshot {"index":1}',
    ]);
  });

  it('moves focus to the newest Restore when it opens', async () => {
    await render();
    expect(document.activeElement).toBe(restoreButtons()[0]);
  });

  it('closes on Escape and returns focus to the trigger', async () => {
    await render();
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(document.getElementById('trigger'));
  });

  it('closes on an outside press but not on the trigger', async () => {
    await render();
    await act(async () => {
      document
        .getElementById('trigger')!
        .dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      document
        .getElementById('elsewhere')!
        .dispatchEvent(new Event('pointerdown', { bubbles: true }));
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('restores a snapshot and keeps the replaced board in history', async () => {
    await render();
    const oldest = restoreButtons()[1];
    await act(async () => oldest.click());

    const board = useStageStore.getState().stage!.whiteboard![0];
    expect(board.id).toBe('wb-1');
    expect(board.elements.map((element) => element.id)).toEqual(['first']);
    expect(board.viewportSize).toBe(1200);
    expect(board.viewportRatio).toBe(0.5);
    const snapshots = useWhiteboardHistoryStore.getState().snapshots;
    expect(snapshots.at(-1)!.elements.map((element) => element.id)).toEqual(['now']);
    expect(mocks.toastSuccess).toHaveBeenCalledWith('whiteboard.restored');
    expect(onClose).toHaveBeenCalled();
    // The focused Restore goes away with the popover; focus returns to the trigger.
    expect(document.activeElement).toBe(document.getElementById('trigger'));
  });

  it('blocks restore while a clear animation is in flight', async () => {
    useCanvasStore.setState({ whiteboardClearing: true });
    await render();
    const [newest] = restoreButtons();
    expect(newest.disabled).toBe(true);
  });

  it('renders snapshot thumbnails only while open, with their sheet geometry', async () => {
    await render(false);
    expect(mocks.thumbnail).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();

    await act(async () => root!.render(createElement(Harness, { isOpen: true })));
    const sizes = mocks.thumbnail.mock.calls.map(
      ([props]) => (props as { slide: { viewportSize: number } }).slide.viewportSize,
    );
    expect(sizes).toEqual(expect.arrayContaining([1000, 1200]));
  });
});
