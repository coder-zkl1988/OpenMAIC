import type { Locator, Page } from '@playwright/test';
import { test, expect } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { defaultTheme } from '../fixtures/test-data/slide-theme';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';

/**
 * Responsive classroom (P7a). The layout follows the classroom root's width
 * (a container query), not the viewport: desktop from 1200px, tablet
 * landscape (TabletLandscape.dc.html) from 900 to 1199px.
 */

const TEST_STAGE_PREFIX = 'e2e-responsive-stage';

// The desktop sidebar was collapsed by the learner: the rail must ignore it
const SETTINGS_STORAGE = createSettingsStorage({ sidebarCollapsed: true });

async function seedCourse(page: Page, settingsStorage = SETTINGS_STORAGE): Promise<string> {
  await page.addInitScript((settings) => {
    localStorage.setItem('maic:account:settings-storage', settings);
    localStorage.setItem('locale', 'en-US');
  }, settingsStorage);

  await page.goto('/', { waitUntil: 'networkidle' });

  const stageId = uniqueStageId(TEST_STAGE_PREFIX);
  const now = Date.now();
  const titles = ['Basics', 'Light reactions', 'Dark reactions'];
  await seedServerDocument(page, {
    stage: {
      id: stageId,
      name: 'Photosynthesis',
      description: '',
      style: 'professional',
      createdAt: now,
      updatedAt: now,
    },
    scenes: titles.map((title, order) => ({
      id: `scene-${order}`,
      stageId,
      type: 'slide',
      title,
      order,
      content: {
        type: 'slide',
        canvas: {
          id: `slide-${order}`,
          viewportSize: 1000,
          viewportRatio: 0.5625,
          theme: defaultTheme,
          elements: [
            {
              type: 'text',
              id: `el-${order}`,
              content: title,
              left: 50,
              top: 50,
              width: 900,
              height: 100,
            },
          ],
        },
      },
      createdAt: now,
      updatedAt: now,
    })),
    outline: { outlines: [], createdAt: now, updatedAt: now },
  });
  return stageId;
}

/** Every hit target listed must be at least 44×44 */
async function expectTouchTargets(targets: Locator) {
  const count = await targets.count();
  expect(count).toBeGreaterThan(0);
  for (let i = 0; i < count; i++) {
    const box = await targets.nth(i).boundingBox();
    expect(box, `target ${i}`).not.toBeNull();
    expect(box!.width).toBeGreaterThanOrEqual(44);
    expect(box!.height).toBeGreaterThanOrEqual(44);
  }
}

test.describe('Classroom at tablet landscape (1180×820)', () => {
  test.use({ viewport: { width: 1180, height: 820 } });

  let stageId: string;
  test.beforeEach(async ({ page }) => {
    stageId = await seedCourse(page);
  });

  test('shows the numbered scene rail, the compact header and 44px targets', async ({ page }) => {
    const classroom = new ClassroomPage(page);
    await classroom.goto(stageId);
    await classroom.waitForLoaded();

    await expect(page.locator('[data-ui="v2"]')).toHaveAttribute('data-layout', 'tablet');

    // The rail shows despite the persisted desktop collapse; no thumbnail rows
    const rail = page.getByRole('navigation', { name: 'Scenes' });
    await expect(rail).toBeVisible();
    expect((await rail.boundingBox())!.width).toBeCloseTo(64, 0);
    const railItems = page.getByTestId('scene-rail-item');
    await expect(railItems).toHaveCount(3);
    await expect(railItems.nth(0)).toHaveText('1');
    await expect(classroom.sidebarScenes).toHaveCount(0);
    await expectTouchTargets(railItems);

    // A rail number switches the scene; the header carries "n / m"
    await railItems.nth(1).click();
    await expect(page.getByRole('heading', { name: 'Light reactions' })).toBeVisible();
    await expect(railItems.nth(1)).toHaveAttribute('aria-current', 'page');
    await expect(page.getByTestId('page-counter')).toContainText('2 / 3');

    // The desktop cluster is folded into the ⋯ menu
    await expect(page.getByRole('button', { name: 'EN', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Theme', exact: true })).toHaveCount(0);
    await expect(page.getByRole('switch')).toHaveCount(0);

    // 56px control bar of 44px buttons, 320px panel, 44px composer controls
    const controlBar = page.getByTestId('control-bar');
    expect((await controlBar.boundingBox())!.height).toBeCloseTo(56, 0);
    await expectTouchTargets(controlBar.getByRole('button'));
    const panel = page.getByRole('complementary').filter({ has: page.getByRole('tablist') });
    expect((await panel.boundingBox())!.width).toBeCloseTo(320, 0);
    const composer = page.getByTestId('classroom-composer');
    await expectTouchTargets(composer.getByRole('button'));
    await expectTouchTargets(page.getByRole('button', { name: 'Back to Home' }));

    // 展开场景栏 swaps in the full sidebar; collapsing returns to the rail.
    // Each swap hands focus to the counterpart toggle.
    await rail.getByRole('button', { name: 'Expand scene sidebar' }).click();
    await expect(classroom.sidebarScenes).toHaveCount(3);
    const collapse = page.getByRole('button', { name: 'Collapse scene list' });
    await expect(collapse).toBeFocused();
    await expectTouchTargets(collapse);
    await page.keyboard.press('Enter');
    await expect(page.getByRole('navigation', { name: 'Scenes' })).toBeVisible();
    await expect(
      page
        .getByRole('navigation', { name: 'Scenes' })
        .getByRole('button', { name: 'Expand scene sidebar' }),
    ).toBeFocused();
  });

  test('a panel collapsed on desktop reopens from a 44px tab', async ({ page }) => {
    const collapsedStageId = await seedCourse(
      page,
      createSettingsStorage({ sidebarCollapsed: true, chatAreaCollapsed: true }),
    );
    const classroom = new ClassroomPage(page);
    await classroom.goto(collapsedStageId);
    await classroom.waitForLoaded();

    // The composer stays mounted (a draft survives) but is out of sight
    await expect(page.getByTestId('classroom-composer')).toBeHidden();
    const reopen = page.getByRole('button', { name: 'Expand interaction panel' });
    await expectTouchTargets(reopen);
    await reopen.click();
    await expect(page.getByTestId('classroom-composer')).toBeVisible();
  });

  test('the ⋯ menu holds language, theme, settings, the Pro switch and export', async ({
    page,
  }) => {
    const classroom = new ClassroomPage(page);
    await classroom.goto(stageId);
    await classroom.waitForLoaded();

    const more = page.getByRole('button', {
      name: 'More: language, theme, settings, Pro mode, export',
    });
    await expectTouchTargets(more);
    await more.click();

    const menu = page.getByRole('menu');
    await expect(menu.getByRole('menuitem', { name: /Language/ })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Theme' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Settings' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Export' })).toBeVisible();
    const pro = menu.getByRole('switch', { name: 'Edit course' });
    await expect(pro).toBeVisible();
    await expect(pro).toHaveAttribute('aria-checked', 'false');
    await expectTouchTargets(menu.getByRole('menuitem'));

    // Theme opens its submenu
    await menu.getByRole('menuitem', { name: 'Theme' }).click();
    await expect(page.getByRole('menuitem', { name: 'Dark' })).toBeVisible();
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');

    // Settings opens the dialog
    await more.click();
    await page.getByRole('menu').getByRole('menuitem', { name: 'Settings' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);

    // Pro mode toggles from the menu
    await more.click();
    await page.getByRole('menu').getByRole('switch', { name: 'Edit course' }).click();
    await expect(page.getByRole('switch', { name: 'Done editing' })).toBeVisible({
      timeout: 15_000,
    });
  });
});

test.describe('Classroom at Electron minimum width (1024×700)', () => {
  test.use({ viewport: { width: 1024, height: 700 } });

  test('uses the tablet layout', async ({ page }) => {
    const stageId = await seedCourse(page);
    const classroom = new ClassroomPage(page);
    await classroom.goto(stageId);
    await classroom.waitForLoaded();
    await expect(page.locator('[data-ui="v2"]')).toHaveAttribute('data-layout', 'tablet');
    await expect(page.getByRole('navigation', { name: 'Scenes' })).toBeVisible();
  });
});

test.describe('Classroom at desktop widths', () => {
  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 1440, height: 900 },
  ]) {
    test(`stays desktop at ${viewport.width}×${viewport.height}`, async ({ page }) => {
      await page.setViewportSize(viewport);
      const stageId = await seedCourse(page);
      const classroom = new ClassroomPage(page);
      await classroom.goto(stageId);
      await classroom.waitForLoaded();

      await expect(page.locator('[data-ui="v2"]')).toHaveAttribute('data-layout', 'desktop');
      await expect(page.getByTestId('scene-rail')).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'EN', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Theme', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
      await expect(page.getByRole('switch')).toBeVisible();
      await expect(page.getByTestId('header-overflow-menu')).toHaveCount(0);
      expect((await page.getByTestId('control-bar').boundingBox())!.height).toBeCloseTo(48, 0);
    });
  }
});
