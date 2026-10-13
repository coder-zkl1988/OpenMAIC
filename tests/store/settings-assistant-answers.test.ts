/**
 * The `assistantAnswersDuringLecture` preference: on by default (new users
 * and blobs persisted before it existed), persisted when turned off.
 */
import { BrowserKVStore } from '@openmaic/storage';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const backing = new Map<string, string>();
const localStorageStub: Storage = {
  get length() {
    return backing.size;
  },
  clear: () => backing.clear(),
  getItem: (k: string) => backing.get(k) ?? null,
  key: (i: number) => [...backing.keys()][i] ?? null,
  removeItem: (k: string) => void backing.delete(k),
  setItem: (k: string, v: string) => void backing.set(k, v),
};
vi.stubGlobal('localStorage', localStorageStub);
vi.stubGlobal('window', { localStorage: localStorageStub });

const kv = new BrowserKVStore({ storage: localStorageStub });

beforeEach(() => {
  backing.clear();
  vi.resetModules();
});

async function loadStore() {
  const { useSettingsStore } = await import('@/lib/store/settings');
  await useSettingsStore.persist.rehydrate();
  return useSettingsStore;
}

describe('settings: the assistant answers during the lecture', () => {
  it('is on for a new user', async () => {
    const store = await loadStore();
    expect(store.getState().assistantAnswersDuringLecture).toBe(true);
  });

  it('is on for a blob persisted before the preference existed (no migration)', async () => {
    await kv.set('settings-storage', { state: { autoPlayLecture: true }, version: 6 }, 'account');
    const store = await loadStore();
    expect(store.getState()).toMatchObject({
      autoPlayLecture: true,
      assistantAnswersDuringLecture: true,
    });
  });

  it('keeps the teacher from calling on the learner unless they allow it (I10.5)', async () => {
    const store = await loadStore();
    expect(store.getState().teacherMayCallOnLearner).toBe(false);
    store.getState().setTeacherMayCallOnLearner(true);
    await vi.waitFor(async () => {
      const blob = (await kv.get('settings-storage', 'account')) as {
        state: Record<string, unknown>;
      } | null;
      expect(blob?.state.teacherMayCallOnLearner).toBe(true);
    });
    vi.resetModules();
    const reloaded = await loadStore();
    expect(reloaded.getState().teacherMayCallOnLearner).toBe(true);
  });

  it('persists turning it off, and a later load keeps it off', async () => {
    const store = await loadStore();
    store.getState().setAssistantAnswersDuringLecture(false);
    await vi.waitFor(async () => {
      const blob = (await kv.get('settings-storage', 'account')) as {
        state: Record<string, unknown>;
      } | null;
      expect(blob?.state.assistantAnswersDuringLecture).toBe(false);
    });

    vi.resetModules();
    const reloaded = await loadStore();
    expect(reloaded.getState().assistantAnswersDuringLecture).toBe(false);
  });
});
