import type { Action } from '@/lib/types/action';
import { canJumpWithinReconstructablePrefix } from '@/lib/playback/action-navigation';

export interface StoredActionResumePosition {
  actionIndex: number;
  actionId: string;
  actionType: Action['type'];
  /**
   * A raised hand was answered just before this action, which had not started:
   * resume exactly there, whatever its type (other positions are speech lines).
   */
  atBoundary?: true;
}

export interface ActionResumeRestoreCursor {
  actionIndex: number;
  position: StoredActionResumePosition | null;
}

interface StoredActionResumeState {
  version: 1;
  scenes: Record<string, StoredActionResumePosition>;
}

const STORAGE_PREFIX = 'openmaic:playback-action-resume';

export function getActionResumeStorageKey(stageId: string | null | undefined): string {
  return `${STORAGE_PREFIX}:${stageId || 'unknown-stage'}`;
}

function isStoredActionResumeState(value: unknown): value is StoredActionResumeState {
  if (!value || typeof value !== 'object') return false;
  const state = value as StoredActionResumeState;
  if (state.version !== 1 || !state.scenes || typeof state.scenes !== 'object') return false;
  return Object.values(state.scenes).every(
    (entry) =>
      entry &&
      typeof entry === 'object' &&
      Number.isInteger((entry as StoredActionResumePosition).actionIndex) &&
      typeof (entry as StoredActionResumePosition).actionId === 'string' &&
      typeof (entry as StoredActionResumePosition).actionType === 'string' &&
      ((entry as StoredActionResumePosition).atBoundary === undefined ||
        (entry as StoredActionResumePosition).atBoundary === true),
  );
}

export function readActionResumeState(
  storage: Pick<Storage, 'getItem'>,
  storageKey: string,
): StoredActionResumeState {
  try {
    const raw = storage.getItem(storageKey);
    if (!raw) return { version: 1, scenes: {} };
    const parsed: unknown = JSON.parse(raw);
    if (!isStoredActionResumeState(parsed)) return { version: 1, scenes: {} };
    return parsed;
  } catch {
    return { version: 1, scenes: {} };
  }
}

export function writeActionResumeState(
  storage: Pick<Storage, 'setItem'>,
  storageKey: string,
  state: StoredActionResumeState,
): void {
  try {
    storage.setItem(storageKey, JSON.stringify(state));
  } catch {
    // Session storage may be unavailable or full. Resume is best-effort.
  }
}

export function saveActionResumePosition(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  storageKey: string,
  sceneId: string,
  position: StoredActionResumePosition,
): void {
  const state = readActionResumeState(storage, storageKey);
  state.scenes[sceneId] = position;
  writeActionResumeState(storage, storageKey, state);
}

export function clearActionResumePosition(
  storage: Pick<Storage, 'getItem' | 'setItem'>,
  storageKey: string,
  sceneId: string,
): void {
  const state = readActionResumeState(storage, storageKey);
  delete state.scenes[sceneId];
  writeActionResumeState(storage, storageKey, state);
}

export function getValidActionResumePosition(
  state: StoredActionResumeState,
  sceneId: string,
  actions: readonly Action[],
): StoredActionResumePosition | null {
  const position = state.scenes[sceneId];
  if (!position) return null;
  const action = actions[position.actionIndex];
  if (!action) return null;
  if (action.id !== position.actionId || action.type !== position.actionType) return null;
  return position;
}

export function getActionResumeRestoreCursor(
  state: StoredActionResumeState,
  sceneId: string,
  actions: readonly Action[],
): ActionResumeRestoreCursor {
  const position = getValidActionResumePosition(state, sceneId, actions);
  if (!position) return { actionIndex: 0, position: null };
  if (
    !canJumpWithinReconstructablePrefix(actions, 0, position.actionIndex, {
      atBoundary: position.atBoundary === true,
    })
  ) {
    return { actionIndex: 0, position: null };
  }
  return { actionIndex: position.actionIndex, position };
}

/** Whether the stored position of a scene is a raised-hand boundary at exactly `actionIndex`. */
export function isActionBoundaryResumePositionAt(
  storage: Pick<Storage, 'getItem'>,
  storageKey: string,
  sceneId: string,
  actionIndex: number,
): boolean {
  const position = readActionResumeState(storage, storageKey).scenes[sceneId];
  return position?.atBoundary === true && position.actionIndex === actionIndex;
}

/**
 * Speech lines are resume positions; with `atBoundary` (a raised hand answered
 * before the action started) any action is.
 */
export function createActionResumePosition(
  actions: readonly Action[],
  actionIndex: number | null | undefined,
  options: { atBoundary?: boolean } = {},
): StoredActionResumePosition | null {
  if (!Number.isInteger(actionIndex) || actionIndex === null || actionIndex === undefined) {
    return null;
  }
  const action = actions[actionIndex];
  if (!action) return null;
  if (action.type !== 'speech') {
    if (!options.atBoundary) return null;
    return { actionIndex, actionId: action.id, actionType: action.type, atBoundary: true };
  }
  return {
    actionIndex,
    actionId: action.id,
    actionType: action.type,
  };
}
