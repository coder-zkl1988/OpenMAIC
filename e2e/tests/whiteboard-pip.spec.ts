import type { Page } from '@playwright/test';
import { expect, test } from '../fixtures/base';
import { ClassroomPage } from '../pages/classroom.page';
import { seedServerDocument, setCurrentScene, uniqueStageId } from '../fixtures/server-seed';

/**
 * Board mode (ClassroomWhiteboard.dc.html): opening the whiteboard gives it the
 * slide's slot and docks the still-mounted slide in a 192×108 PiP beside the
 * caption. The PiP is a real button that swaps back; the control bar's 白板
 * toggle keeps its 'Open Whiteboard' / 'Minimize Whiteboard' titles.
 */
test.setTimeout(120_000);

const SCENE_ID = 'scene-whiteboard-pip';

async function seedSlideWithBoard(page: Page): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.includes('/chat') || path.includes('/generate') || path.includes('/tts'))
      return route.abort();
    if (path === '/api/server-providers')
      return route.fulfill({ json: { providers: {}, mediaProviders: {}, defaultModel: null } });
    if (path === '/api/comfyui-workflows') return route.fulfill({ json: { workflows: [] } });
    await route.continue();
  });
  await page.addInitScript(() => {
    if (window.top !== window) return;
    localStorage.setItem(
      'maic:account:settings-storage',
      JSON.stringify({
        state: {
          modelId: 'gpt-4o',
          providerId: 'openai',
          providersConfig: { openai: { apiKey: 'mock-only' } },
          agentMode: 'preset',
          selectedAgentIds: [],
          ttsEnabled: false,
          reviewOutlineEnabled: false,
          autoConfigApplied: true,
          sidebarCollapsed: false,
        },
        version: 2,
      }),
    );
  });
  await page.goto('/', { waitUntil: 'networkidle' });

  const stageId = uniqueStageId('e2e-whiteboard-pip');
  const now = Date.now();
  await seedServerDocument(page, {
    stage: {
      id: stageId,
      name: 'Whiteboard PiP',
      whiteboard: [
        {
          id: 'board',
          viewportSize: 1000,
          viewportRatio: 0.5625,
          elements: [
            {
              id: 'board-fact',
              type: 'text',
              left: 200,
              top: 180,
              width: 400,
              height: 70,
              rotate: 0,
              content: '<p>Buoyancy equals displaced liquid weight.</p>',
              defaultFontName: 'Arial',
              defaultColor: '#111111',
            },
          ],
        },
      ],
      description: '',
      style: 'professional',
      createdAt: now,
      updatedAt: now,
    },
    scenes: [
      {
        id: SCENE_ID,
        stageId,
        type: 'slide',
        title: 'Slide',
        order: 0,
        content: {
          type: 'slide',
          canvas: {
            id: 'slide-0',
            viewportSize: 1000,
            viewportRatio: 0.5625,
            theme: {
              backgroundColor: '#ffffff',
              themeColors: ['#5b9bd5'],
              fontColor: '#333333',
              fontName: 'Arial',
            },
            elements: [
              {
                id: 'slide-fact',
                type: 'text',
                left: 100,
                top: 100,
                width: 600,
                height: 80,
                rotate: 0,
                content: '<p>Slide fact</p>',
                defaultFontName: 'Arial',
                defaultColor: '#111111',
              },
            ],
          },
        },
        actions: [],
        createdAt: now,
        updatedAt: now,
      },
    ],
    outline: { outlines: [], createdAt: now, updatedAt: now },
  });
  await setCurrentScene(page, stageId, SCENE_ID);

  const classroom = new ClassroomPage(page);
  await classroom.goto(stageId);
  await classroom.waitForLoaded();
}

const boardFact = (page: Page) => page.locator('[id="screen-element-board-fact"] > div').first();
const slideFact = (page: Page) => page.locator('[id="screen-element-slide-fact"]').first();
const pip = (page: Page) =>
  page.getByRole('button', { name: 'Back to slides (page 1)', exact: true });

test('the slide docks in the PiP while the board is open, and the PiP swaps back', async ({
  page,
}) => {
  await seedSlideWithBoard(page);
  const slideBefore = (await slideFact(page).boundingBox())!;

  await page.getByTitle('Open Whiteboard', { exact: true }).click();
  await expect(boardFact(page)).toBeVisible();
  await expect(pip(page)).toBeVisible();
  await expect(page.getByTestId('stage-pip')).toContainText('Slides · page 1');

  // Still mounted (no remount, no lost state), now inert in the 192×108 PiP
  await expect(slideFact(page)).toHaveCount(1);
  await expect(page.getByTestId('stage-scene').locator('[inert]')).toHaveCount(1);
  await expect.poll(async () => Math.round((await pip(page).boundingBox())?.width ?? 0)).toBe(192);
  await expect
    .poll(async () => (await slideFact(page).boundingBox())?.width ?? Infinity)
    .toBeLessThan(slideBefore.width / 2);
  // The control bar's toggle now reads as the way back
  await expect(page.getByTitle('Minimize Whiteboard', { exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await pip(page).click();
  await expect(boardFact(page)).toBeHidden();
  await expect(pip(page)).toHaveCount(0);
  await expect(page.getByTestId('stage-scene').locator('[inert]')).toHaveCount(0);
  // Back at full size, at the layout box it never left
  await expect
    .poll(async () => Math.round((await slideFact(page).boundingBox())?.width ?? 0))
    .toBe(Math.round(slideBefore.width));
  await expect(page.getByTitle('Open Whiteboard', { exact: true })).toHaveAttribute(
    'aria-pressed',
    'false',
  );
});

test('reduced motion swaps the slide and the board instantly', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await seedSlideWithBoard(page);

  await page.getByTitle('Open Whiteboard', { exact: true }).click();
  await expect(pip(page)).toBeVisible({ timeout: 1_000 });
  await page.getByTitle('Minimize Whiteboard', { exact: true }).click();
  await expect(pip(page)).toHaveCount(0, { timeout: 1_000 });
  await expect(boardFact(page)).toBeHidden({ timeout: 1_000 });
});

test('a keyboard return from the PiP lands focus on the slide, not on the page body', async ({
  page,
}) => {
  await seedSlideWithBoard(page);

  await page.getByTitle('Open Whiteboard', { exact: true }).click();
  await expect(pip(page)).toBeVisible();
  await pip(page).focus();
  await page.keyboard.press('Enter');
  await expect(pip(page)).toHaveCount(0);
  // Once the slide has flown back (it is inert until then) it takes the focus
  await expect(
    page.getByTestId('stage-scene').getByRole('group', { name: 'Current Scene', exact: true }),
  ).toBeFocused();
});

test('fullscreen: the PiP floats top left, clear of the board card and the teacher line', async ({
  page,
}) => {
  await seedSlideWithBoard(page);
  await page.getByTitle('Open Whiteboard', { exact: true }).click();
  await expect(pip(page)).toBeVisible();

  const isFullscreen = () => page.evaluate(() => document.fullscreenElement !== null);
  await page.getByRole('button', { name: 'Fullscreen', exact: true }).click();
  await expect.poll(isFullscreen).toBe(true);
  await expect(page.getByTestId('presentation-dock')).toBeVisible();

  // The dock's teacher line sits bottom left (bottom-6 left-6) and the dock
  // bottom right, so the PiP takes the top-left corner in a strip of its own
  // Measured inside the poll: entering fullscreen collapses the side panels,
  // so the column itself moves after the dock appears
  await expect
    .poll(async () => {
      const column = (await page.getByTestId('stage-column').boundingBox())!;
      const box = (await pip(page).boundingBox())!;
      return [Math.round(box.x - column.x), Math.round(box.y - column.y)];
    })
    .toEqual([16, 16]);
  const pipBox = (await pip(page).boundingBox())!;
  const card = (await page.getByRole('region', { name: 'Interactive Whiteboard' }).boundingBox())!;
  expect(pipBox.x + pipBox.width).toBeLessThanOrEqual(card.x);

  // Nothing in the dock covers it: Playwright refuses a click another element intercepts
  await pip(page).click();
  await expect(pip(page)).toHaveCount(0);
  await expect(boardFact(page)).toBeHidden();
});
