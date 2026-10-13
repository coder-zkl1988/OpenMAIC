// @vitest-environment jsdom
/**
 * A course with its own classmates replaced the learner's preset ones (their
 * preset is parked): the classroom says so once, offering to always use the
 * preset classmates, which switches this course to them right away.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  settings: {
    parkedPresetAgentIds: [] as string[],
    ownClassmatesNoticeSeen: false,
    setOwnClassmatesNoticeSeen: vi.fn(),
    setPresetAgentsInGeneratedCourses: vi.fn(),
    restoreParkedPresetAgents: vi.fn(),
  },
  stage: { stage: null as { generatedAgentConfigs?: unknown[] } | null },
}));

vi.mock('sonner', () => ({ toast: mocks.toast }));
vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: Object.assign(
    (selector: (state: typeof mocks.settings) => unknown) => selector(mocks.settings),
    { getState: () => mocks.settings },
  ),
}));
vi.mock('@/lib/store', () => ({
  useStageStore: (selector: (state: typeof mocks.stage) => unknown) => selector(mocks.stage),
}));

import {
  OWN_CLASSMATES_NOTICE_MS,
  shouldShowOwnClassmatesNotice,
  useOwnClassmatesNotice,
} from '@/components/classroom/use-own-classmates-notice';

describe('shouldShowOwnClassmatesNotice', () => {
  it('shows only for a course with its own classmates, a parked preset, and never before', () => {
    const base = {
      parkedPresetAgentIds: ['default-2'],
      ownClassmatesNoticeSeen: false,
      courseHasOwnClassmates: true,
    };
    expect(shouldShowOwnClassmatesNotice(base)).toBe(true);
    expect(shouldShowOwnClassmatesNotice({ ...base, ownClassmatesNoticeSeen: true })).toBe(false);
    expect(shouldShowOwnClassmatesNotice({ ...base, parkedPresetAgentIds: [] })).toBe(false);
    expect(shouldShowOwnClassmatesNotice({ ...base, parkedPresetAgentIds: undefined })).toBe(false);
    expect(shouldShowOwnClassmatesNotice({ ...base, courseHasOwnClassmates: false })).toBe(false);
  });
});

describe('useOwnClassmatesNotice', () => {
  let container: HTMLDivElement;
  let root: Root;

  function Probe({ ready }: { readonly ready: boolean }) {
    useOwnClassmatesNotice(ready);
    return null;
  }
  const render = (ready: boolean) => act(() => root.render(createElement(Probe, { ready })));

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.toast.mockReset();
    mocks.settings.parkedPresetAgentIds = ['default-2'];
    mocks.settings.ownClassmatesNoticeSeen = false;
    mocks.settings.setOwnClassmatesNoticeSeen.mockReset();
    mocks.settings.setPresetAgentsInGeneratedCourses.mockReset();
    mocks.settings.restoreParkedPresetAgents.mockReset();
    mocks.stage.stage = { generatedAgentConfigs: [{ id: 'gen-a' }] };
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it('waits for the classroom to be ready, then tells the learner once', () => {
    render(false);
    expect(mocks.toast).not.toHaveBeenCalled();

    render(true);
    expect(mocks.toast).toHaveBeenCalledExactlyOnceWith('stage.ownClassmates.title', {
      description: 'stage.ownClassmates.description',
      duration: OWN_CLASSMATES_NOTICE_MS,
      action: { label: 'stage.ownClassmates.alwaysPreset', onClick: expect.any(Function) },
    });
    expect(mocks.settings.setOwnClassmatesNoticeSeen).toHaveBeenCalledExactlyOnceWith(true);

    // "Always use my preset classmates": remembered, and this course switches now
    const [, options] = mocks.toast.mock.calls[0] as [string, { action: { onClick: () => void } }];
    options.action.onClick();
    expect(mocks.settings.setPresetAgentsInGeneratedCourses).toHaveBeenCalledExactlyOnceWith(true);
    expect(mocks.settings.restoreParkedPresetAgents).toHaveBeenCalledOnce();
  });

  it('says nothing once seen, or for a course without its own classmates', () => {
    mocks.settings.ownClassmatesNoticeSeen = true;
    render(true);
    mocks.settings.ownClassmatesNoticeSeen = false;
    mocks.stage.stage = { generatedAgentConfigs: [] };
    render(true);
    expect(mocks.toast).not.toHaveBeenCalled();
  });
});
