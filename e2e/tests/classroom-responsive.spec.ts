import type { Locator, Page, Route } from '@playwright/test';
import { test, expect } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import { defaultTheme } from '../fixtures/test-data/slide-theme';
import { seedServerDocument, uniqueStageId } from '../fixtures/server-seed';

/**
 * Responsive classroom (P7a, P7b). The layout follows the classroom root's
 * width (a container query), not the viewport: desktop from 1200px, tablet
 * landscape (TabletLandscape.dc.html) from 900 to 1199px, the stacked layout
 * (TabletPortrait.dc.html) below 900px or in portrait, and its phone variant
 * (ClassroomPhone.dc.html) below 600px.
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

/** The page never scrolls sideways */
async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

const ANSWER = 'Chlorophyll reflects green light, so leaves look green.';

/** One scripted Q&A turn: the teacher answers, then the director closes the session */
function answerStream(): string {
  const events = [
    { type: 'thinking', data: { stage: 'director' } },
    {
      type: 'agent_start',
      data: { messageId: 'answer-1', agentId: 'default-1', agentName: 'AI Teacher' },
    },
    { type: 'text_delta', data: { messageId: 'answer-1', content: ANSWER } },
    { type: 'agent_end', data: { messageId: 'answer-1', agentId: 'default-1' } },
    {
      type: 'done',
      data: {
        totalActions: 0,
        totalAgents: 1,
        agentHadContent: true,
        sessionClosed: true,
        endReason: 'back_to_lesson',
      },
    },
  ];
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
}

/** Answers the chat API (Pi chat or the classic route) and records the questions */
async function mockChat(page: Page): Promise<string[]> {
  const questions: string[] = [];
  const answer = async (route: Route) => {
    const body = route.request().postDataJSON() as {
      messages?: { content?: unknown; parts?: { type: string; text?: string }[] }[];
    };
    const last = body?.messages?.at(-1);
    const text =
      typeof last?.content === 'string'
        ? last.content
        : (last?.parts ?? [])
            .filter((part) => part.type === 'text')
            .map((part) => part.text ?? '')
            .join('');
    if (text) questions.push(text);
    await route.fulfill({
      status: 200,
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' },
      body: answerStream(),
    });
  };
  await page.route('**/api/chat/pi', answer);
  await page.route('**/api/chat', answer);
  return questions;
}

for (const board of [
  {
    name: 'tablet portrait (820×1180)',
    viewport: { width: 820, height: 1180 },
    layout: 'stacked',
    tabHeight: 40,
    barHeight: 56,
  },
  {
    name: 'phone (390×844)',
    viewport: { width: 390, height: 844 },
    layout: 'phone',
    tabHeight: 36,
    barHeight: 52,
  },
] as const) {
  test.describe(`Classroom at ${board.name}`, () => {
    test.use({ viewport: board.viewport, hasTouch: true });

    let stageId: string;
    test.beforeEach(async ({ page }) => {
      // Both panels were collapsed on desktop: the stacked section ignores it
      stageId = await seedCourse(
        page,
        createSettingsStorage({ sidebarCollapsed: true, chatAreaCollapsed: true }),
      );
    });

    test('stacks the slide, caption and bar over a full-width interaction section', async ({
      page,
    }) => {
      const classroom = new ClassroomPage(page);
      await classroom.goto(stageId);
      await classroom.waitForLoaded();

      await expect(page.locator('[data-ui="v2"]')).toHaveAttribute('data-layout', board.layout);
      // No rail, no side panel, no re-open tabs: the scenes live in a tab
      await expect(page.getByTestId('scene-rail')).toHaveCount(0);
      await expect(classroom.sidebarScenes).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Expand interaction panel' })).toHaveCount(0);

      const controlBar = page.getByTestId('control-bar');
      const section = page.getByTestId('interaction-section');
      await expect(section).toBeVisible();
      const barBox = (await controlBar.boundingBox())!;
      const sectionBox = (await section.boundingBox())!;
      expect(barBox.height).toBeCloseTo(board.barHeight, 0);
      // Directly under the control bar, edge to edge, down to the bottom
      expect(sectionBox.y).toBeGreaterThanOrEqual(barBox.y + barBox.height - 1);
      expect(sectionBox.width).toBeCloseTo(board.viewport.width, 0);
      expect(sectionBox.y + sectionBox.height).toBeCloseTo(board.viewport.height, 0);
      await expectNoHorizontalScroll(page);

      // The header carries title, "n / m" and the ⋯ menu
      await expect(page.getByRole('heading', { name: 'Basics' })).toBeVisible();
      await expect(page.getByTestId('page-counter')).toContainText('1 / 3');

      // 互动 / 笔记 / 场景, 互动 selected with the online count
      const tabs = section.getByRole('tab');
      await expect(tabs).toHaveCount(3);
      await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
      await expect(tabs.nth(0)).toContainText('Interaction');
      await expect(tabs.nth(0)).toContainText('online');
      for (let i = 0; i < 3; i++) {
        expect((await tabs.nth(i).boundingBox())!.height).toBeCloseTo(board.tabHeight, 0);
      }
      await expect(page.getByTestId('participants')).toBeVisible();
      await expect(page.getByTestId('classroom-composer')).toBeVisible();

      // 44px targets: header, control bar, composer
      await expectTouchTargets(page.getByRole('button', { name: 'Back to Home' }));
      await expectTouchTargets(
        page.getByRole('button', { name: 'More: language, theme, settings, Pro mode, export' }),
      );
      await expectTouchTargets(controlBar.getByRole('button'));
      await expectTouchTargets(page.getByTestId('classroom-composer').getByRole('button'));
    });

    test('switches tabs and jumps to a scene from 场景', async ({ page }) => {
      const classroom = new ClassroomPage(page);
      await classroom.goto(stageId);
      await classroom.waitForLoaded();

      const section = page.getByTestId('interaction-section');
      const composer = page.getByTestId('classroom-composer');

      // 笔记: the notes, and the composer steps out of sight
      await section.getByRole('tab', { name: 'Notes' }).click();
      await expect(section.getByRole('tab', { name: 'Notes' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await expect(composer).toBeHidden();

      // 场景: the titled thumbnails in two columns
      await section.getByRole('tab', { name: 'Scenes' }).click();
      const items = section.getByTestId('scene-item');
      await expect(items).toHaveCount(3);
      await expect(items.nth(1).getByTestId('scene-title')).toHaveText('Light reactions');
      const first = (await items.nth(0).boundingBox())!;
      const second = (await items.nth(1).boundingBox())!;
      expect(second.y).toBeCloseTo(first.y, 0);
      expect(second.x).toBeGreaterThan(first.x + first.width - 1);
      await expectTouchTargets(items);
      await expectNoHorizontalScroll(page);

      // A scene jumps from the grid
      await items.nth(1).click();
      await expect(page.getByRole('heading', { name: 'Light reactions' })).toBeVisible();
      await expect(items.nth(1)).toHaveAttribute('aria-current', 'page');
      await expect(page.getByTestId('page-counter')).toContainText('2 / 3');

      // Back to 互动: the composer is there again
      await section.getByRole('tab', { name: /Interaction/ }).click();
      await expect(composer).toBeVisible();
    });

    test('sends a message from 互动 and shows the answer in the stream', async ({ page }) => {
      const questions = await mockChat(page);
      const classroom = new ClassroomPage(page);
      await classroom.goto(stageId);
      await classroom.waitForLoaded();

      // Start on 场景, where the composer is hidden: T has to bring 互动 back
      // (focusComposer → revealInteraction → switchToTab('interaction')) and
      // put the caret in the textarea
      const section = page.getByTestId('interaction-section');
      const interactionTab = section.getByRole('tab', { name: /Interaction/ });
      await section.getByRole('tab', { name: 'Scenes' }).click();
      await expect(interactionTab).toHaveAttribute('aria-selected', 'false');

      const textarea = page
        .getByTestId('classroom-composer')
        .getByPlaceholder('Type your message...', { exact: true });
      await expect(textarea).toBeHidden();
      await page.keyboard.press('T');
      await expect(interactionTab).toHaveAttribute('aria-selected', 'true');
      await expect(textarea).toBeVisible();
      await expect(textarea).toBeFocused();

      await textarea.fill('Why are leaves green?');
      // The composer sits inside the viewport (Playwright has no on-screen
      // keyboard; the visualViewport inset is unit-tested)
      const box = (await textarea.boundingBox())!;
      expect(box.y + box.height).toBeLessThanOrEqual(board.viewport.height);
      await textarea.press('Enter');

      await expect.poll(() => questions.length, { timeout: 15_000 }).toBeGreaterThan(0);
      expect(questions[0]).toContain('Why are leaves green?');
      await expect(page.getByTestId('conversation-stream')).toContainText(ANSWER, {
        timeout: 30_000,
      });
      await expectNoHorizontalScroll(page);
    });
  });
}

test.describe('Classroom at phone width (390×844): condensed controls and the board chip', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test('folds speed, volume and auto-play into the ⋯ sheet', async ({ page }) => {
    const stageId = await seedCourse(page);
    const classroom = new ClassroomPage(page);
    await classroom.goto(stageId);
    await classroom.waitForLoaded();

    // The bar keeps only the ⋯ trigger. Anchored / exact names: a plain string
    // name is a case-insensitive substring match, and the trigger's own label
    // ('More: playback speed, volume, auto-play') contains both.
    const controlBar = page.getByTestId('control-bar');
    await expect(controlBar.getByRole('button', { name: /^Playback speed/ })).toHaveCount(0);
    await expect(controlBar.getByRole('button', { name: 'Auto-play', exact: true })).toHaveCount(0);

    const more = controlBar.getByRole('button', {
      name: 'More: playback speed, volume, auto-play',
    });
    await expectTouchTargets(more);
    await more.click();
    const sheet = page.getByTestId('control-bar-sheet');
    await expect(sheet).toBeVisible();
    await expect(sheet.getByRole('slider', { name: 'Volume' })).toBeVisible();
    await sheet.getByRole('button', { name: /Playback speed/ }).click();
    await expect(sheet.getByRole('button', { name: /Playback speed/ })).not.toHaveAccessibleName(
      'Playback speed 1x',
    );
    const autoPlay = sheet.getByRole('button', { name: 'Auto-play' });
    const pressed = await autoPlay.getAttribute('aria-pressed');
    await autoPlay.click();
    await expect(autoPlay).not.toHaveAttribute('aria-pressed', pressed ?? '');
    await expectTouchTargets(sheet.getByRole('button'));
    await expectNoHorizontalScroll(page);

    // The header's ⋯ menu still holds every header control
    await page.keyboard.press('Escape');
    await page
      .getByRole('button', { name: 'More: language, theme, settings, Pro mode, export' })
      .click();
    await expect(page.getByRole('menu').getByRole('menuitem', { name: 'Settings' })).toBeVisible();
  });

  test('the whiteboard takes the full width and a 返回课件 chip leads back', async ({ page }) => {
    const stageId = await seedCourse(page);
    const classroom = new ClassroomPage(page);
    await classroom.goto(stageId);
    await classroom.waitForLoaded();

    await page.getByTestId('control-bar').getByRole('button', { name: 'Whiteboard' }).click();
    await expect(page.getByTestId('stage-column')).toHaveAttribute('data-board-open', 'true');
    // No 192×108 PiP below 600px
    await expect(page.getByTestId('whiteboard-pip')).toHaveCount(0);
    const chip = page.getByTestId('whiteboard-return-chip');
    await expect(chip).toBeVisible();
    await expect(chip).toHaveAccessibleName('Back to slides (page 1)');
    await expectTouchTargets(chip);
    await expectNoHorizontalScroll(page);

    await chip.click();
    await expect(page.getByTestId('stage-column')).toHaveAttribute('data-board-open', 'false');
    await expect(chip).toHaveCount(0);
  });
});
