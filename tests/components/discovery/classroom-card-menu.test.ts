// @vitest-environment jsdom

/**
 * The course card's always-visible ⋯ menu (Library.dc.html): 重命名 /
 * 移动到文件夹 / 删除 for a course, only 删除 for a run whose course does not
 * exist yet. The card root opens the course on click, so the menu must keep
 * its clicks to itself.
 */

import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi, type Mock } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/slide-renderer/SlideThumbnail', () => ({ SlideThumbnail: () => null }));

import { ClassroomCard } from '@/components/discovery/classroom-card';
import type { StageListItem } from '@/lib/utils/stage-storage';
import type { FolderRecord } from '@/lib/types/folder';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

beforeAll(() => {
  if (!globalThis.PointerEvent) vi.stubGlobal('PointerEvent', MouseEvent);
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
  vi.clearAllMocks();
});

const COURSE: StageListItem = {
  id: 'stage-1',
  name: '从零学 Python，30 分钟写出第一个程序',
  sceneCount: 12,
  createdAt: 1,
  updatedAt: 2,
  folderId: 'folder-b',
};

const FOLDERS = [
  { id: 'folder-a', name: '数学' },
  { id: 'folder-b', name: '编程' },
] as FolderRecord[];

interface Spies {
  onClick: Mock<() => void>;
  onRename: Mock<(id: string, newName: string) => void>;
  onDelete: Mock<(id: string) => void>;
  onConfirmDelete: Mock<() => void>;
  onMove: Mock<(folderId: string | undefined) => void>;
  onCreateAndMove: Mock<() => void>;
}

/** The card as the home page wires it: 删除 asks, the page answers with `confirmingDelete`. */
function Harness({ pending, spies }: { pending: boolean; spies: Spies }) {
  const [confirming, setConfirming] = useState(false);
  return createElement(ClassroomCard, {
    classroom: COURSE,
    formatDate: () => 'classroom.today',
    pendingCourse: pending,
    runStatus: pending ? { kind: 'generating', completed: 3, total: 8 } : null,
    moveTarget: pending
      ? undefined
      : {
          folders: FOLDERS,
          currentFolderId: COURSE.folderId,
          onMove: spies.onMove,
          onCreateAndMove: spies.onCreateAndMove,
        },
    onDelete: (id: string) => {
      spies.onDelete(id);
      setConfirming(true);
    },
    onRename: spies.onRename,
    confirmingDelete: confirming,
    onConfirmDelete: spies.onConfirmDelete,
    onCancelDelete: () => setConfirming(false),
    onClick: spies.onClick,
  });
}

async function renderCard(pending = false): Promise<Spies> {
  const spies: Spies = {
    onClick: vi.fn(),
    onRename: vi.fn(),
    onDelete: vi.fn(),
    onConfirmDelete: vi.fn(),
    onMove: vi.fn(),
    onCreateAndMove: vi.fn(),
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () => root.render(createElement(Harness, { pending, spies })));
  return spies;
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);
const menuItems = () =>
  [...document.querySelectorAll<HTMLElement>('[role="menu"] > [role="menuitem"]')].map((item) =>
    item.textContent?.trim(),
  );

async function openMenu(): Promise<HTMLElement> {
  const trigger = byTestId('card-actions-trigger')!;
  expect(trigger).not.toBeNull();
  await act(async () => {
    trigger.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, cancelable: true }),
    );
    trigger.click();
  });
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  return trigger;
}

/** Radix hands focus back once the closed menu has unmounted, a task later. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

async function select(testId: string): Promise<void> {
  const item = byTestId(testId);
  expect(item, `menu item ${testId}`).not.toBeNull();
  await act(async () => item!.click());
}

describe('ClassroomCard ⋯ menu', () => {
  it('shows the title, the meta line and a labeled ⋯ trigger', async () => {
    await renderCard();
    const card = byTestId('library-card')!;
    expect(card.className).toContain('group cursor-pointer');
    expect(card.textContent).toContain(COURSE.name);
    expect(card.textContent).toContain('12 classroom.slides · classroom.today');
    const trigger = byTestId('card-actions-trigger')!;
    expect(trigger.getAttribute('aria-label')).toBe('classroom.moreActions');
    expect(trigger.getAttribute('draggable')).toBe('false');
  });

  it('offers 重命名 / 移动到文件夹 / 删除 on a course, 删除 last and in red', async () => {
    await renderCard();
    await openMenu();
    expect(menuItems()).toEqual(['classroom.rename', 'classroom.moveToFolder', 'classroom.delete']);
    expect(document.querySelector('[role="menu"] [role="separator"]')).not.toBeNull();
    expect(byTestId('card-action-delete')!.className).toContain('text-danger');
    // The 176px panel, not the 32px trigger's width.
    expect(document.querySelector('[role="menu"]')!.className).toContain('w-44');
  });

  it('offers only 删除 on a run whose course does not exist yet', async () => {
    await renderCard(true);
    expect(byTestId('course-run-status')!.className).toContain('text-xs');
    await openMenu();
    expect(menuItems()).toEqual(['classroom.delete']);
    expect(document.querySelector('[role="menu"] [role="separator"]')).toBeNull();
  });

  it('never opens the course from the trigger or the menu', async () => {
    const spies = await renderCard();
    await openMenu();
    await act(async () => byTestId('card-action-move')!.click());
    expect(spies.onClick).not.toHaveBeenCalled();
  });

  it('删除 shows the inline confirm overlay', async () => {
    const spies = await renderCard();
    await openMenu();
    await select('card-action-delete');
    expect(spies.onDelete).toHaveBeenCalledWith(COURSE.id);
    const confirm = byTestId('card-delete-confirm');
    expect(confirm).not.toBeNull();
    expect(confirm!.textContent).toContain('classroom.deleteConfirmTitle');
    // The ⋯ menu is locked while the confirm is up (no rename / move behind it).
    await settle();
    expect((byTestId('card-actions-trigger') as HTMLButtonElement).disabled).toBe(true);
    const deleteButton = [...confirm!.querySelectorAll('button')].find(
      (button) => button.textContent === 'classroom.delete',
    )!;
    await act(async () => deleteButton.click());
    expect(spies.onConfirmDelete).toHaveBeenCalledTimes(1);
    expect(spies.onClick).not.toHaveBeenCalled();
  });

  it('移动到文件夹 lists Ungrouped and every folder, with a ✓ on the current one', async () => {
    const spies = await renderCard();
    await openMenu();
    await select('card-action-move');
    const options = [
      ...document.querySelectorAll<HTMLElement>('[data-testid="move-to-folder-option"]'),
    ];
    expect(options.map((o) => o.textContent)).toEqual(['数学', '编程']);
    expect(options.map((o) => o.querySelector('svg.lucide-check') !== null)).toEqual([false, true]);
    expect(byTestId('move-to-folder-ungrouped')!.querySelector('svg.lucide-check')).toBeNull();

    await act(async () => options[0]!.click());
    expect(spies.onMove).toHaveBeenCalledWith('folder-a');
    expect(spies.onClick).not.toHaveBeenCalled();
  });

  it('新建文件夹 in the submenu asks the page to create a folder and move the course', async () => {
    const spies = await renderCard();
    await openMenu();
    await select('card-action-move');
    await select('move-to-folder-new');
    expect(spies.onCreateAndMove).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[role="menu"]')).toBeNull();
  });

  it('重命名 turns the title into a focused input that commits on Enter', async () => {
    const spies = await renderCard();
    await openMenu();
    await select('card-action-rename');
    await settle();
    const input = document.querySelector<HTMLInputElement>('[data-testid="library-card"] input')!;
    expect(input).not.toBeNull();
    expect(input.value).toBe(COURSE.name);
    expect(input.maxLength).toBe(100);
    // The closing menu does not take focus back to its trigger (which would
    // blur, and so commit, the input).
    expect(document.activeElement).toBe(input);

    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    await act(async () => {
      setter.call(input, '新名字');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(spies.onRename).toHaveBeenCalledWith(COURSE.id, '新名字');
    expect(spies.onClick).not.toHaveBeenCalled();
  });

  it('Escape closes the menu and returns focus to the trigger', async () => {
    await renderCard();
    const trigger = await openMenu();
    const menu = document.querySelector<HTMLElement>('[role="menu"]')!;
    await act(async () => {
      menu.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await settle();
    expect(document.querySelector('[role="menu"]')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
});
