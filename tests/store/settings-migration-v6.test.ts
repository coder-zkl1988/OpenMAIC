/**
 * The settings store's migration to version 6 (the classroom redesign): both
 * side panels open once and the interaction panel is at least 360px wide.
 * Collapsing afterwards persists.
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

async function hydrate(state: Record<string, unknown>, version: number) {
  await kv.set('settings-storage', { state, version }, 'account');
  const { useSettingsStore } = await import('@/lib/store/settings');
  await useSettingsStore.persist.rehydrate();
  return useSettingsStore;
}

async function persisted() {
  const blob = (await kv.get('settings-storage', 'account')) as {
    state: Record<string, unknown>;
    version: number;
  } | null;
  return blob;
}

describe('settings store v5 → v6', () => {
  it('opens both collapsed panels once and widens a narrow interaction panel to 360', async () => {
    const store = await hydrate(
      {
        sidebarCollapsed: true,
        chatAreaCollapsed: true,
        chatAreaWidth: 300,
        playbackSpeed: 1.5,
      },
      5,
    );

    expect(store.getState()).toMatchObject({
      sidebarCollapsed: false,
      chatAreaCollapsed: false,
      chatAreaWidth: 360,
      // Other preferences carry over
      playbackSpeed: 1.5,
    });
  });

  it('keeps a wider panel the user chose, within the drag range', async () => {
    const store = await hydrate({ chatAreaCollapsed: true, chatAreaWidth: 480 }, 5);
    expect(store.getState().chatAreaWidth).toBe(480);
  });

  it('defaults a missing or broken width to 360', async () => {
    const store = await hydrate({ chatAreaWidth: 'wide' }, 5);
    expect(store.getState().chatAreaWidth).toBe(360);
  });

  it('runs after the v4 → v5 migration for older blobs', async () => {
    const store = await hydrate({ sidebarCollapsed: true, chatAreaCollapsed: true }, 4);
    expect(store.getState()).toMatchObject({
      sidebarCollapsed: false,
      chatAreaCollapsed: false,
      chatAreaWidth: 360,
    });
  });

  it('runs once: a collapse saved at v6 persists', async () => {
    const store = await hydrate({ sidebarCollapsed: true, chatAreaCollapsed: true }, 5);
    expect(store.getState().chatAreaCollapsed).toBe(false);

    store.getState().setChatAreaCollapsed(true);
    store.getState().setSidebarCollapsed(true);
    await vi.waitFor(async () => {
      const blob = await persisted();
      expect(blob?.version).toBe(6);
      expect(blob?.state.chatAreaCollapsed).toBe(true);
    });

    // A later load does not reopen them
    vi.resetModules();
    const { useSettingsStore } = await import('@/lib/store/settings');
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState()).toMatchObject({
      sidebarCollapsed: true,
      chatAreaCollapsed: true,
    });
  });

  it('opens both panels at 360px for a new user', async () => {
    const { useSettingsStore } = await import('@/lib/store/settings');
    await useSettingsStore.persist.rehydrate();
    expect(useSettingsStore.getState()).toMatchObject({
      sidebarCollapsed: false,
      chatAreaCollapsed: false,
      chatAreaWidth: 360,
    });
  });
});
