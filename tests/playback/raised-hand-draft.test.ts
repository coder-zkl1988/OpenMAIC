import { describe, expect, it, vi } from 'vitest';

import {
  clearRaisedHandDraft,
  getRaisedHandDraftStorageKey,
  saveRaisedHandDraft,
  takeRaisedHandDraft,
} from '@/lib/playback/raised-hand-draft';

function createMemoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      data.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      data.delete(key);
    }),
    has: (key: string) => data.has(key),
  };
}

describe('raised-hand draft', () => {
  it('hands a saved draft back once, per classroom', () => {
    const storage = createMemoryStorage();
    saveRaisedHandDraft(storage, 'stage-1', 'Why does it flatten?');
    saveRaisedHandDraft(storage, 'stage-2', 'Another classroom');

    expect(takeRaisedHandDraft(storage, 'stage-1')).toBe('Why does it flatten?');
    expect(storage.has(getRaisedHandDraftStorageKey('stage-1'))).toBe(false);
    expect(takeRaisedHandDraft(storage, 'stage-1')).toBeNull();
    expect(storage.has(getRaisedHandDraftStorageKey('stage-2'))).toBe(true);

    clearRaisedHandDraft(storage, 'stage-2');
    expect(takeRaisedHandDraft(storage, 'stage-2')).toBeNull();
  });

  it('keeps no blank draft and drops malformed ones', () => {
    const storage = createMemoryStorage({
      [getRaisedHandDraftStorageKey('bad-json')]: '{',
      [getRaisedHandDraftStorageKey('bad-shape')]: JSON.stringify({ version: 2, text: 'x' }),
    });
    saveRaisedHandDraft(storage, 'stage-1', '   ');
    expect(storage.setItem).not.toHaveBeenCalled();

    expect(takeRaisedHandDraft(storage, 'bad-json')).toBeNull();
    expect(takeRaisedHandDraft(storage, 'bad-shape')).toBeNull();
    expect(storage.has(getRaisedHandDraftStorageKey('bad-json'))).toBe(false);
    expect(storage.has(getRaisedHandDraftStorageKey('bad-shape'))).toBe(false);
  });

  it('is best effort when storage is unavailable or throws', () => {
    const throwing = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('quota');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    };
    expect(() => saveRaisedHandDraft(throwing, 'stage-1', 'Q')).not.toThrow();
    expect(takeRaisedHandDraft(throwing, 'stage-1')).toBeNull();
    expect(() => clearRaisedHandDraft(throwing, 'stage-1')).not.toThrow();

    expect(() => saveRaisedHandDraft(null, 'stage-1', 'Q')).not.toThrow();
    expect(takeRaisedHandDraft(null, 'stage-1')).toBeNull();
  });
});
