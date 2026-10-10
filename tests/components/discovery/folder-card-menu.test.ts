// @vitest-environment jsdom

/**
 * The folder card's ⋯ menu (Library.dc.html): 重命名 and 删除. An empty
 * folder is deleted after the inline confirm; a non-empty one asks which of
 * the two existing modes to use — keep the courses (ungrouped) or delete them
 * with the folder.
 */

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/slide-renderer/SlideThumbnail', () => ({ SlideThumbnail: () => null }));

import { FolderCard } from '@/components/discovery/folder-card';
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

const FOLDER = { id: 'folder-a', name: '数学' } as FolderRecord;

async function renderFolder(courseCount: number) {
  const spies = {
    onOpen: vi.fn(),
    onDelete: vi.fn(),
    onRename: vi.fn(async () => null),
  };
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  await act(async () =>
    root.render(
      createElement(FolderCard, {
        folder: FOLDER,
        courseCount,
        coverSlides: [],
        onOpen: spies.onOpen,
        onRename: spies.onRename,
        onDelete: spies.onDelete,
        onDropCourse: vi.fn(),
      }),
    ),
  );
  return spies;
}

const byTestId = (id: string) => document.querySelector<HTMLElement>(`[data-testid="${id}"]`);

async function openMenu(): Promise<void> {
  const trigger = byTestId('card-actions-trigger')!;
  await act(async () => {
    trigger.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, cancelable: true }),
    );
    trigger.click();
  });
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
}

async function click(el: HTMLElement | null | undefined): Promise<void> {
  expect(el).toBeTruthy();
  await act(async () => el!.click());
}

const confirmButton = (label: string) =>
  [...byTestId('folder-card')!.querySelectorAll('button')].find((b) => b.textContent === label);

describe('FolderCard ⋯ menu', () => {
  it('shows the name and "文件夹 · N 门课程" under it, with no count badge on the tile', async () => {
    await renderFolder(2);
    const card = byTestId('folder-card')!;
    expect(card.className).toContain('group cursor-pointer');
    expect(card.textContent).toContain(FOLDER.name);
    expect(card.textContent).toContain('classroom.folderBadge · 2 classroom.folderCourseCountUnit');
    // The tile holds no text: the count moved to the meta line.
    expect(card.firstElementChild!.textContent).toBe('');
  });

  it('an empty folder: 重命名 and 删除, and 删除 confirms inline before deleting', async () => {
    const spies = await renderFolder(0);
    await openMenu();
    const items = [...document.querySelectorAll('[role="menu"] > [role="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual(['classroom.rename', 'classroom.delete']);
    // A plain item, not a submenu.
    expect(byTestId('card-action-delete')!.getAttribute('aria-haspopup')).toBeNull();

    await click(byTestId('card-action-delete'));
    expect(spies.onDelete).not.toHaveBeenCalled();
    expect(byTestId('folder-card')!.textContent).toContain('classroom.deleteFolderEmptyDesc');
    await click(confirmButton('classroom.delete'));
    expect(spies.onDelete).toHaveBeenCalledWith('ungroup');
    expect(spies.onOpen).not.toHaveBeenCalled();
  });

  it('a non-empty folder: 删除 opens the two delete modes', async () => {
    const spies = await renderFolder(3);
    await openMenu();
    const deleteEntry = byTestId('card-action-delete')!;
    expect(deleteEntry.getAttribute('aria-haspopup')).toBe('menu');
    await click(deleteEntry);
    expect(byTestId('folder-delete-ungroup')!.textContent).toContain('classroom.deleteFolderOnly');
    expect(byTestId('folder-delete-remove')!.textContent).toBe('classroom.deleteFolderAndCourses');

    // Keep the courses: deletes right away, ungrouping them.
    await click(byTestId('folder-delete-ungroup'));
    expect(spies.onDelete).toHaveBeenCalledWith('ungroup');
    expect(spies.onOpen).not.toHaveBeenCalled();
  });

  it('a non-empty folder: deleting the courses too goes through the inline confirm', async () => {
    const spies = await renderFolder(3);
    await openMenu();
    await click(byTestId('card-action-delete'));
    await click(byTestId('folder-delete-remove'));
    expect(spies.onDelete).not.toHaveBeenCalled();
    expect(byTestId('folder-card')!.textContent).toContain('classroom.deleteFolderConfirmRemove');
    // The ⋯ menu is locked while the confirm is up (no "keep courses" delete under it).
    expect((byTestId('card-actions-trigger') as HTMLButtonElement).disabled).toBe(true);
    await click(confirmButton('classroom.delete'));
    expect(spies.onDelete).toHaveBeenCalledWith('remove');
    expect(spies.onOpen).not.toHaveBeenCalled();
  });

  it('重命名 edits the name in place without opening the folder', async () => {
    const spies = await renderFolder(1);
    await openMenu();
    await click(byTestId('card-action-rename'));
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const input = byTestId('folder-card')!.querySelector('input')!;
    expect(input.value).toBe(FOLDER.name);
    expect(document.activeElement).toBe(input);
    expect(spies.onOpen).not.toHaveBeenCalled();
  });
});
