import { afterEach, describe, expect, it } from 'vitest';
import type { PPTElement } from '@openmaic/dsl';

import { useCanvasStore } from '@/lib/store/canvas';
import { useStageStore } from '@/lib/store/stage';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';
import { restoreWhiteboardElements } from '@/lib/whiteboard/restore';

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

function seedBoards(
  whiteboard: { id: string; viewportSize: number; viewportRatio: number; elements: PPTElement[] }[],
) {
  useStageStore.setState({
    stage: { id: 'stage-1', name: 'Stage', createdAt: 1, updatedAt: 1, whiteboard } as never,
  });
}

const board = () => useStageStore.getState().stage!.whiteboard!.at(-1)!;
const historyLength = () => useWhiteboardHistoryStore.getState().snapshots.length;

afterEach(() => {
  useStageStore.setState({ stage: null });
  useCanvasStore.setState({ whiteboardClearing: false });
  useWhiteboardHistoryStore.getState().clearHistory();
});

describe('restoreWhiteboardElements', () => {
  it('refuses while a clear animation is in flight and writes nothing', () => {
    seedBoards([{ id: 'wb-1', viewportSize: 1000, viewportRatio: 0.5625, elements: [] }]);
    useCanvasStore.setState({ whiteboardClearing: true });
    const before = useStageStore.getState().stage;

    expect(restoreWhiteboardElements([textElement('a')])).toEqual({ status: 'busy' });
    expect(useStageStore.getState().stage).toBe(before);
    expect(board().elements).toEqual([]);
    expect(historyLength()).toBe(0);
  });

  it('is a no-op when the board already shows the same elements', () => {
    const elements = [textElement('a'), textElement('b')];
    seedBoards([{ id: 'wb-1', viewportSize: 1000, viewportRatio: 0.5625, elements }]);
    useWhiteboardHistoryStore.getState().pushSnapshot([textElement('older')]);
    const before = useStageStore.getState().stage;

    const result = restoreWhiteboardElements(JSON.parse(JSON.stringify(elements)), {
      viewport: { viewportSize: 1200, viewportRatio: 0.5 },
    });

    expect(result).toEqual({ status: 'unchanged', whiteboardId: 'wb-1' });
    expect(useStageStore.getState().stage).toBe(before);
    expect(board().viewportSize).toBe(1000);
    expect(historyLength()).toBe(1);
  });

  it('pushes the replaced content to history before restoring', () => {
    seedBoards([
      { id: 'wb-1', viewportSize: 1000, viewportRatio: 0.5625, elements: [textElement('now')] },
    ]);

    const result = restoreWhiteboardElements([textElement('then')]);

    expect(result).toEqual({ status: 'restored', whiteboardId: 'wb-1' });
    expect(board().elements.map((element) => element.id)).toEqual(['then']);
    const [snapshot] = useWhiteboardHistoryStore.getState().snapshots;
    expect(snapshot.elements.map((element) => element.id)).toEqual(['now']);
    expect(snapshot.viewportSize).toBe(1000);
    expect(snapshot.viewportRatio).toBe(0.5625);
  });

  it('does not push an empty board to history', () => {
    seedBoards([{ id: 'wb-1', viewportSize: 1000, viewportRatio: 0.5625, elements: [] }]);

    const result = restoreWhiteboardElements([textElement('then')]);

    expect(result.status).toBe('restored');
    expect(board().elements.map((element) => element.id)).toEqual(['then']);
    expect(historyLength()).toBe(0);
  });

  it('restores onto a new whiteboard after a clear deleted the old one', () => {
    seedBoards([]);

    const result = restoreWhiteboardElements([textElement('then')]);

    expect(result.status).toBe('restored');
    expect(useStageStore.getState().stage!.whiteboard).toHaveLength(1);
    expect(board().elements.map((element) => element.id)).toEqual(['then']);
    expect(result).toEqual({ status: 'restored', whiteboardId: board().id });
  });

  it('writes the sheet geometry only for the fields given', () => {
    seedBoards([
      { id: 'wb-1', viewportSize: 1000, viewportRatio: 0.5625, elements: [textElement('now')] },
    ]);
    restoreWhiteboardElements([textElement('a')], { viewport: { viewportSize: 1200 } });
    expect(board().viewportSize).toBe(1200);
    expect(board().viewportRatio).toBe(0.5625);

    restoreWhiteboardElements([textElement('b')], { viewport: { viewportRatio: 0.5 } });
    expect(board().viewportSize).toBe(1200);
    expect(board().viewportRatio).toBe(0.5);

    restoreWhiteboardElements([textElement('c')]);
    expect(board().viewportSize).toBe(1200);
    expect(board().viewportRatio).toBe(0.5);
  });

  it('does not alias the elements it was given', () => {
    seedBoards([{ id: 'wb-1', viewportSize: 1000, viewportRatio: 0.5625, elements: [] }]);
    const source = [textElement('a')];

    restoreWhiteboardElements(source);
    source[0].left = 999;

    expect(board().elements[0].left).toBe(0);
  });
});
