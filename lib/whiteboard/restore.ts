/**
 * Shared whiteboard restore used by the history popover and the undo after a
 * user clear.
 *
 * Restore goes through get-or-create: after a UI clear the cleared whiteboard
 * has been deleted, so the elements land on a new whiteboard with a new id
 * (element references keyed by the old id stay invalid, which is intended).
 */

import type { PPTElement } from '@openmaic/dsl';
import { createStageAPI, type StageStore } from '@/lib/api/stage-api';
import { useStageStore } from '@/lib/store';
import { useCanvasStore } from '@/lib/store/canvas';
import {
  useWhiteboardHistoryStore,
  type WhiteboardSnapshotViewport,
} from '@/lib/store/whiteboard-history';
import { elementFingerprint } from '@/lib/utils/element-fingerprint';

export type RestoreWhiteboardResult =
  /** The elements now show on the whiteboard with this id. */
  | { status: 'restored'; whiteboardId: string }
  /** The whiteboard already shows exactly these elements; nothing was written. */
  | { status: 'unchanged'; whiteboardId: string }
  /** A clear animation is in flight; its pending delete would overwrite the restore. */
  | { status: 'busy' }
  | { status: 'error'; error: string };

export interface RestoreWhiteboardOptions {
  /** Sheet geometry to restore with the elements (snapshot or cleared board). */
  readonly viewport?: WhiteboardSnapshotViewport;
  /** Stage store to write to; the app store by default. */
  readonly store?: StageStore;
}

/**
 * Replace the current whiteboard content with `elements` in one transactional
 * update. The content being replaced is pushed to history first, so a restore
 * can itself be undone from the history popover.
 */
export function restoreWhiteboardElements(
  elements: readonly PPTElement[],
  { viewport, store = useStageStore }: RestoreWhiteboardOptions = {},
): RestoreWhiteboardResult {
  if (useCanvasStore.getState().whiteboardClearing) return { status: 'busy' };

  const stageAPI = createStageAPI(store);
  const current = stageAPI.whiteboard.get();
  if (!current.success || !current.data) {
    return { status: 'error', error: current.error ?? '' };
  }
  const whiteboard = current.data;
  const currentElements = whiteboard.elements ?? [];

  // Skip no-op restores: the snapshot is already what is on screen.
  if (elementFingerprint([...elements]) === elementFingerprint(currentElements)) {
    return { status: 'unchanged', whiteboardId: whiteboard.id };
  }

  if (currentElements.length > 0) {
    useWhiteboardHistoryStore.getState().pushSnapshot(currentElements, {
      viewportSize: whiteboard.viewportSize,
      viewportRatio: whiteboard.viewportRatio,
    });
  }

  // Deep copy so the stage never aliases a snapshot held by the history store.
  const restored = JSON.parse(JSON.stringify(elements)) as PPTElement[];
  const result = stageAPI.whiteboard.update(
    {
      elements: restored,
      ...(viewport?.viewportSize !== undefined && { viewportSize: viewport.viewportSize }),
      ...(viewport?.viewportRatio !== undefined && { viewportRatio: viewport.viewportRatio }),
    },
    whiteboard.id,
  );
  if (!result.success) return { status: 'error', error: result.error ?? '' };
  return { status: 'restored', whiteboardId: whiteboard.id };
}
