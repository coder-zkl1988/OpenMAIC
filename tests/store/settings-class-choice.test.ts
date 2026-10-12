/**
 * The class an auto-generated roster is asked for (I28): a size the learner
 * picked (else the model decides, as for every earlier user whose stored 3
 * nobody chose) and an optional class atmosphere, both checked before a run
 * would see them.
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

async function hydrate(state: Record<string, unknown>) {
  await kv.set('settings-storage', { state, version: 6 }, 'account');
  const settings = await import('@/lib/store/settings');
  await settings.useSettingsStore.persist.rehydrate();
  return settings;
}

describe('autoClassRequest', () => {
  it('lets the model decide for a stored size nobody picked', async () => {
    const { useSettingsStore, autoClassRequest } = await hydrate({
      agentMode: 'auto',
      autoAgentCount: 3,
    });
    expect(useSettingsStore.getState()).toMatchObject({ autoAgentCountSet: false });
    expect(autoClassRequest(useSettingsStore.getState())).toEqual({});
  });

  it('sends a picked size, clamped and whole, until the learner lets the model decide again', async () => {
    const { useSettingsStore, autoClassRequest } = await hydrate({});
    useSettingsStore.getState().setAutoAgentCount(5);
    expect(autoClassRequest(useSettingsStore.getState())).toEqual({ count: 5 });
    useSettingsStore.getState().setAutoAgentCount(20);
    expect(autoClassRequest(useSettingsStore.getState())).toEqual({ count: 8 });
    useSettingsStore.getState().setAutoAgentCount(1.4);
    expect(autoClassRequest(useSettingsStore.getState())).toEqual({ count: 2 });
    useSettingsStore.getState().setAutoAgentCount(null);
    expect(autoClassRequest(useSettingsStore.getState())).toEqual({});
  });

  it('sends a known class atmosphere only', async () => {
    const { useSettingsStore, autoClassRequest } = await hydrate({});
    useSettingsStore.getState().setClassAtmosphere('lively');
    expect(autoClassRequest(useSettingsStore.getState())).toEqual({ atmosphere: 'lively' });
    useSettingsStore.getState().setClassAtmosphere(undefined);
    expect(useSettingsStore.getState().classAtmosphere).toBeUndefined();
    expect(
      autoClassRequest({
        autoAgentCount: 3,
        autoAgentCountSet: false,
        classAtmosphere: 'noisy' as never,
      }),
    ).toEqual({});
  });

  it('keeps both choices across a reload', async () => {
    const first = await hydrate({});
    first.useSettingsStore.getState().setAutoAgentCount(6);
    first.useSettingsStore.getState().setClassAtmosphere('focused');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stored = (await kv.get('settings-storage', 'account')) as {
      state: Record<string, unknown>;
    };
    expect(stored.state).toMatchObject({
      autoAgentCount: 6,
      autoAgentCountSet: true,
      classAtmosphere: 'focused',
    });
  });
});
