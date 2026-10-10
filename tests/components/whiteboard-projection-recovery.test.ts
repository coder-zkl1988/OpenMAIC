// @vitest-environment jsdom
import {
  act,
  createElement,
  forwardRef,
  Fragment,
  useImperativeHandle,
  type ReactNode,
} from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useCanvasStore } from '@/lib/store/canvas';
import { useStageStore } from '@/lib/store/stage';

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
}));

vi.mock('motion/react', () => ({
  AnimatePresence: ({ children }: { children: ReactNode }) =>
    createElement(Fragment, null, children),
  motion: { div: 'div', button: 'button', section: 'section', span: 'span' },
  useReducedMotion: () => false,
}));
vi.mock('lucide-react', () => ({
  CircleCheck: () => null,
  Eraser: () => null,
  History: () => null,
  Maximize: () => null,
  Minimize2: () => null,
  Minus: () => null,
  PencilLine: () => null,
  Plus: () => null,
  RotateCcw: () => null,
  Scan: () => null,
  Undo2: () => null,
  ZoomIn: () => null,
  ZoomOut: () => null,
}));
vi.mock('@/components/whiteboard/whiteboard-canvas', () => ({
  WHITEBOARD_MIN_ZOOM: 0.2,
  WHITEBOARD_MAX_ZOOM: 5,
  WhiteboardCanvas: forwardRef(function WhiteboardCanvas(_props, ref) {
    useImperativeHandle(ref, () => ({ resetView: vi.fn(), zoomBy: vi.fn(), fit: vi.fn() }));
    return null;
  }),
}));
vi.mock('@/components/whiteboard/whiteboard-history', () => ({
  WhiteboardHistory: () => null,
}));
vi.mock('@/lib/api/stage-api', () => ({
  createStageAPI: () => ({ whiteboard: { delete: vi.fn() } }),
}));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/lib/whiteboard/runtime/browser-projection', () => ({
  refreshWhiteboardRuntimeProjection: mocks.refresh,
}));
vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));

import { Whiteboard } from '@/components/whiteboard';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

function WhiteboardHarness() {
  const isOpen = useCanvasStore((state) => state.whiteboardOpen);
  return createElement(Whiteboard, { isOpen });
}

afterEach(() => {
  mocks.refresh.mockReset();
  useStageStore.setState({ stage: null });
  useCanvasStore.setState({
    whiteboardOpen: false,
    whiteboardManualVisibilityRevision: 0,
    runtimeWhiteboardProjection: null,
    runtimeWhiteboardProjectionGeneration: 0,
  });
  document.body.innerHTML = '';
});

describe('Whiteboard RuntimeStore projection recovery', () => {
  it('refetches authoritative state when a manual open follows a failed projection read', async () => {
    mocks.refresh.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    useStageStore.setState({ stage: { id: 'stage-1' } as never });
    useCanvasStore.setState({ whiteboardOpen: false });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(WhiteboardHarness));
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenLastCalledWith('stage-1');

    await act(async () => {
      useCanvasStore.getState().setWhiteboardOpenManually(true);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(2);
    expect(mocks.refresh).toHaveBeenLastCalledWith('stage-1');

    await act(async () => root.unmount());
  });

  it('refetches once when a Stage change and open transition share a render', async () => {
    mocks.refresh.mockResolvedValue(true);
    useStageStore.setState({ stage: { id: 'stage-1' } as never });
    useCanvasStore.setState({ whiteboardOpen: false });

    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(createElement(WhiteboardHarness));
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenLastCalledWith('stage-1');
    mocks.refresh.mockClear();

    await act(async () => {
      useStageStore.setState({ stage: { id: 'stage-2' } as never });
      useCanvasStore.getState().setWhiteboardOpenManually(true);
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.refresh).toHaveBeenLastCalledWith('stage-2');

    await act(async () => root.unmount());
  });
});
