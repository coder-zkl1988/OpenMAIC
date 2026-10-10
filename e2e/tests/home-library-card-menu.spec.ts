import type { Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';
import { defaultTheme } from '../fixtures/test-data/slide-theme';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';
import { HomePage } from '../pages/home.page';

async function seedCourse(page: Page, name: string): Promise<string> {
  const stageId = uniqueStageId('e2e-card-menu');
  const now = Date.now();
  await seedServerDocument(page, {
    stage: { id: stageId, name, description: '', createdAt: now, updatedAt: now },
    scenes: [
      {
        id: 'scene-1',
        stageId,
        type: 'slide',
        title: name,
        order: 0,
        content: {
          type: 'slide',
          canvas: {
            id: 'slide-1',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            theme: defaultTheme,
            background: { type: 'solid', color: '#1e3a8a' },
            elements: [],
          },
        },
        createdAt: now,
        updatedAt: now,
      },
    ],
    outline: { outlines: [], createdAt: now, updatedAt: now },
  });
  return stageId;
}

test.describe('Home library card menu', () => {
  test('the ⋯ menu opens in place: 重命名 edits the title without leaving the home page', async ({
    page,
  }) => {
    const name = `Menu ${crypto.randomUUID().slice(0, 6)}`;
    await page.goto('/', { waitUntil: 'networkidle' });
    await seedCourse(page, name);
    await page.goto('/');

    const home = new HomePage(page);
    const card = home.libraryCard(name);
    await expect(card).toBeVisible();
    const homeUrl = page.url();

    // Opening the menu neither opens the course nor starts a drag.
    const trigger = home.cardMenuTrigger(name);
    await trigger.click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('menuitem')).toHaveText(['Rename', 'Move to folder', 'Delete']);
    expect(page.url()).toBe(homeUrl);

    // Escape closes it and hands focus back to the trigger.
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();

    // ⋯ → Rename: the title becomes a focused input, still on the home page.
    await trigger.click();
    await page.getByRole('menuitem', { name: 'Rename' }).click();
    // Not `card.locator('input')`: `card` filters on the title text, which the
    // input replaces (hasText does not read an input's value).
    const input = page.getByRole('textbox', { name: 'Rename', exact: true });
    await expect(input).toBeFocused();
    await expect(input).toHaveValue(name);
    await page.waitForTimeout(300);
    expect(page.url()).toBe(homeUrl);

    const renamed = `${name} renamed`;
    await input.fill(renamed);
    await input.press('Enter');
    await expect(home.libraryCard(renamed)).toBeVisible();
    expect(page.url()).toBe(homeUrl);
  });
});
