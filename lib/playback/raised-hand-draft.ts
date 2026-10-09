/**
 * A raised-hand question that left the page unsent (reload, tab close, route
 * change, Pro mode) is kept per classroom in sessionStorage — it survives a
 * reload in the same tab — and put back into the input on the next visit.
 * Best effort: storage may be unavailable (private mode, blocked site data).
 */

interface StoredRaisedHandDraft {
  version: 1;
  text: string;
}

const STORAGE_PREFIX = 'openmaic:raised-hand-draft';

export function getRaisedHandDraftStorageKey(stageId: string): string {
  return `${STORAGE_PREFIX}:${stageId}`;
}

/** The tab's sessionStorage, or null where it is unavailable. */
export function getSessionStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    // Accessing sessionStorage throws when site data is blocked
    return null;
  }
}

export function saveRaisedHandDraft(
  storage: Pick<Storage, 'setItem'> | null,
  stageId: string,
  text: string,
): void {
  if (!storage || !text.trim()) return;
  try {
    const draft: StoredRaisedHandDraft = { version: 1, text };
    storage.setItem(getRaisedHandDraftStorageKey(stageId), JSON.stringify(draft));
  } catch {
    // Storage may be full or unavailable. The draft is best-effort.
  }
}

/** Read and delete a classroom's draft; returns its text, or null when there is none. */
export function takeRaisedHandDraft(
  storage: Pick<Storage, 'getItem' | 'removeItem'> | null,
  stageId: string,
): string | null {
  if (!storage) return null;
  const key = getRaisedHandDraftStorageKey(stageId);
  try {
    const raw = storage.getItem(key);
    if (raw === null) return null;
    storage.removeItem(key);
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    const draft = parsed as StoredRaisedHandDraft;
    if (draft.version !== 1 || typeof draft.text !== 'string' || !draft.text.trim()) return null;
    return draft.text;
  } catch {
    return null;
  }
}

export function clearRaisedHandDraft(
  storage: Pick<Storage, 'removeItem'> | null,
  stageId: string,
): void {
  if (!storage) return;
  try {
    storage.removeItem(getRaisedHandDraftStorageKey(stageId));
  } catch {
    // Best-effort, like saving
  }
}
