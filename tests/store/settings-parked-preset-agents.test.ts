/**
 * A course generated with its own classmates parks the user's preset choice
 * (`parkedPresetAgentIds`); the home page brings it back as the user's
 * explicit selection. `presetAgentsInGeneratedCourses` (always use my preset
 * classmates) and the one-time classroom notice are persisted preferences.
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

describe('settings: preset classmates parked by a course with its own classmates', () => {
  it('starts with nothing parked, the preset not forced, and the notice unseen (old blobs too)', async () => {
    await kv.set('settings-storage', { state: { autoPlayLecture: true }, version: 6 }, 'account');
    const store = await loadStore();
    expect(store.getState()).toMatchObject({
      autoPlayLecture: true,
      parkedPresetAgentIds: [],
      presetAgentsInGeneratedCourses: false,
      ownClassmatesNoticeSeen: false,
    });
  });

  it("brings the parked classmates back as the user's explicit preset selection", async () => {
    const store = await loadStore();
    store.setState({
      agentMode: 'auto',
      selectedAgentIds: ['gen-a', 'gen-b'],
      agentSelectionIsUserSet: false,
    });
    store.getState().setParkedPresetAgentIds(['default-1', 'default-4']);
    store.getState().restoreParkedPresetAgents();
    expect(store.getState()).toMatchObject({
      agentMode: 'preset',
      selectedAgentIds: ['default-1', 'default-4'],
      agentSelectionIsUserSet: true,
      parkedPresetAgentIds: [],
    });
  });

  it('leaves the selection alone when nothing is parked', async () => {
    const store = await loadStore();
    store.setState({ agentMode: 'auto', selectedAgentIds: ['gen-a'] });
    store.getState().restoreParkedPresetAgents();
    expect(store.getState()).toMatchObject({ agentMode: 'auto', selectedAgentIds: ['gen-a'] });
  });

  it('persists the parked classmates and both preferences', async () => {
    const store = await loadStore();
    store.getState().setParkedPresetAgentIds(['default-2']);
    store.getState().setPresetAgentsInGeneratedCourses(true);
    store.getState().setOwnClassmatesNoticeSeen(true);
    await vi.waitFor(async () => {
      const blob = (await kv.get('settings-storage', 'account')) as {
        state: Record<string, unknown>;
      } | null;
      expect(blob?.state).toMatchObject({
        parkedPresetAgentIds: ['default-2'],
        presetAgentsInGeneratedCourses: true,
        ownClassmatesNoticeSeen: true,
      });
    });

    vi.resetModules();
    const reloaded = await loadStore();
    expect(reloaded.getState()).toMatchObject({
      parkedPresetAgentIds: ['default-2'],
      presetAgentsInGeneratedCourses: true,
      ownClassmatesNoticeSeen: true,
    });
  });
});
