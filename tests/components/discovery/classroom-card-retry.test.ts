// @vitest-environment jsdom

/**
 * A paused run's course card: beside 已暂停 it says why (the pill's tooltip)
 * and offers Retry, which retries the run without opening the course.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/slide-renderer/SlideThumbnail', () => ({ SlideThumbnail: () => null }));

import { ClassroomCard } from '@/components/discovery/classroom-card';
import type { CourseRunStatus } from '@/lib/generation-run-client/course-card';
import type { StageListItem } from '@/lib/utils/stage-storage';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});

const roots: Root[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

const COURSE: StageListItem = {
  id: 'stage-1',
  name: '傅里叶变换入门',
  sceneCount: 9,
  createdAt: 1,
  updatedAt: 2,
};

function render(props: {
  runStatus: CourseRunStatus;
  onRetryRun?: () => Promise<void>;
  onClick?: () => void;
}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      createElement(ClassroomCard, {
        classroom: COURSE,
        formatDate: () => 'today',
        runStatus: props.runStatus,
        runFailure: 'generation.sceneGenerateProviderUnavailable',
        onRetryRun: props.onRetryRun,
        onDelete: () => {},
        onRename: () => {},
        confirmingDelete: false,
        onConfirmDelete: () => {},
        onCancelDelete: () => {},
        onClick: props.onClick ?? (() => {}),
      }),
    ),
  );
}

const retryButton = () =>
  document.querySelector<HTMLButtonElement>('[data-testid="card-retry-run"]');

describe('a paused run on its course card', () => {
  it('retries the run without opening the course, and says why it paused', async () => {
    let finish: () => void = () => {};
    const onRetryRun = vi.fn(() => new Promise<void>((resolve) => (finish = resolve)));
    const onClick = vi.fn();
    render({ runStatus: { kind: 'paused' }, onRetryRun, onClick });

    expect(document.querySelector('[data-testid="course-run-status"]')!.getAttribute('title')).toBe(
      'generation.sceneGenerateProviderUnavailable',
    );
    const button = retryButton()!;
    expect(button.textContent).toBe('generation.retryScene');
    expect(button.getAttribute('aria-label')).toBe('generation.retryScene: 傅里叶变换入门');

    act(() => button.click());
    expect(onRetryRun).toHaveBeenCalledOnce();
    expect(onClick).not.toHaveBeenCalled();
    // In flight: one Retry at a time.
    expect(button.disabled).toBe(true);
    expect(button.textContent).toBe('generation.retryingScene');
    act(() => button.click());
    expect(onRetryRun).toHaveBeenCalledOnce();

    await act(async () => finish());
    expect(button.disabled).toBe(false);
  });

  it('offers no Retry while the run is generating', () => {
    render({ runStatus: { kind: 'generating', completed: 3, total: 12 }, onRetryRun: vi.fn() });
    expect(retryButton()).toBeNull();
  });

  it('offers no Retry without a handler', () => {
    render({ runStatus: { kind: 'paused' } });
    expect(retryButton()).toBeNull();
  });
});
