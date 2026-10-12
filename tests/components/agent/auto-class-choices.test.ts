// @vitest-environment jsdom
/**
 * Auto mode's class choices (I28): the size (the model decides until the
 * learner picks one) and an optional class atmosphere that a second press
 * clears.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
const store = vi.hoisted(() => ({
  state: {
    autoAgentCount: 3,
    autoAgentCountSet: false,
    classAtmosphere: undefined as string | undefined,
    setAutoAgentCount: (count: number | null) => {
      store.state =
        count === null
          ? { ...store.state, autoAgentCountSet: false }
          : { ...store.state, autoAgentCount: count, autoAgentCountSet: true };
      store.listeners.forEach((listener) => listener());
    },
    setClassAtmosphere: (atmosphere: string | undefined) => {
      store.state = { ...store.state, classAtmosphere: atmosphere };
      store.listeners.forEach((listener) => listener());
    },
  },
  listeners: new Set<() => void>(),
}));
vi.mock('@/lib/store/settings', async () => {
  const { useSyncExternalStore } = await import('react');
  return {
    useSettingsStore: (selector: (state: typeof store.state) => unknown) =>
      useSyncExternalStore(
        (listener) => {
          store.listeners.add(listener);
          return () => store.listeners.delete(listener);
        },
        () => selector(store.state),
      ),
  };
});

import { AutoClassChoices } from '@/components/agent/auto-class-choices';

describe('AutoClassChoices', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(createElement(AutoClassChoices)));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const pressed = (selector: string) =>
    [...container.querySelectorAll(selector)]
      .filter((node) => node.getAttribute('aria-pressed') === 'true')
      .map((node) => node.textContent);
  const auto = () =>
    container.querySelector('[data-testid="auto-class-size-auto"]') as HTMLButtonElement;

  it('lets the AI decide the size until the learner picks one (2 to 8, teacher included)', () => {
    expect(auto().getAttribute('aria-pressed')).toBe('true');
    const sizes = [...container.querySelectorAll('[data-testid="auto-class-size"]')];
    expect(sizes.map((node) => node.textContent)).toEqual(['2', '3', '4', '5', '6', '7', '8']);
    // The stored 3 was never chosen: it is not shown as picked
    expect(pressed('[data-testid="auto-class-size"]')).toEqual([]);

    act(() => (sizes[3] as HTMLButtonElement).click());
    expect(store.state).toMatchObject({ autoAgentCount: 5, autoAgentCountSet: true });
    expect(pressed('[data-testid="auto-class-size"]')).toEqual(['5']);
    expect(auto().getAttribute('aria-pressed')).toBe('false');

    act(() => auto().click());
    expect(store.state.autoAgentCountSet).toBe(false);
  });

  it('sets a class atmosphere, and a second press clears it', () => {
    const lively = container.querySelector('[data-atmosphere="lively"]') as HTMLButtonElement;
    expect(lively.textContent).toBe('settings.classAtmosphereOptions.lively');
    act(() => lively.click());
    expect(store.state.classAtmosphere).toBe('lively');
    expect(pressed('[data-testid="auto-class-atmosphere"]')).toEqual([
      'settings.classAtmosphereOptions.lively',
    ]);
    act(() => lively.click());
    expect(store.state.classAtmosphere).toBeUndefined();
  });
});
