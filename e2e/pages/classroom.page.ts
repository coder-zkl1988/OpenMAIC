import type { Page, Locator } from '@playwright/test';

/**
 * The redesigned classroom (data-ui="v2"): scene sidebar, the stage column
 * (slide + caption, whiteboard + PiP), the control bar and the interaction
 * panel with its single shared composer. Locators use the surface's testids,
 * not visible text, because the page counter and button labels are localized.
 */
export class ClassroomPage {
  readonly page: Page;
  readonly loadingText: Locator;
  /** The redesigned root; carries data-layout (desktop / tablet / stacked / phone) */
  readonly surface: Locator;
  readonly sidebarScenes: Locator;
  readonly stageColumn: Locator;
  /** The breathing play hint over the first slide; clicking it starts the lecture */
  readonly playHint: Locator;
  readonly caption: Locator;
  readonly captionText: Locator;
  readonly controlBar: Locator;
  /** Localized ("Page 2 / 4", "第 2 / 4 页"): match the numbers, not the text */
  readonly pageCounter: Locator;
  readonly whiteboardToggle: Locator;
  readonly whiteboardPip: Locator;
  /** The one shared composer (interaction panel, stacked section or presentation dock) */
  readonly composer: Locator;
  readonly composerInput: Locator;
  readonly conversationStream: Locator;
  readonly participants: Locator;

  constructor(page: Page) {
    this.page = page;
    this.loadingText = page.getByText('Loading classroom...');
    this.surface = page.locator('[data-ui="v2"]');
    this.sidebarScenes = page.locator('[data-testid="scene-item"]');
    this.stageColumn = page.getByTestId('stage-column');
    this.playHint = page.getByTestId('play-hint');
    this.caption = page.getByTestId('caption-strip');
    this.captionText = page.getByTestId('caption-text');
    this.controlBar = page.getByTestId('control-bar');
    this.pageCounter = page.getByTestId('page-counter');
    this.whiteboardToggle = this.controlBar.getByTestId('whiteboard-toggle');
    this.whiteboardPip = page.getByTestId('whiteboard-pip');
    this.composer = page.getByTestId('classroom-composer');
    this.composerInput = this.composer.locator('textarea');
    this.conversationStream = page.getByTestId('conversation-stream');
    this.participants = page.getByTestId('participants');
  }

  async goto(stageId: string) {
    await this.page.goto(`/classroom/${stageId}`);
  }

  async waitForLoaded() {
    await this.loadingText.waitFor({ state: 'hidden', timeout: 15_000 });
  }

  async clickScene(index: number) {
    await this.sidebarScenes.nth(index).click();
  }

  /** Get scene title — it's the second span (first is the number badge) */
  getSceneTitle(index: number) {
    return this.sidebarScenes.nth(index).locator('[data-testid="scene-title"]');
  }

  /** Start the lecture from the play hint over the first slide */
  async startLecture() {
    await this.playHint.waitFor({ state: 'visible', timeout: 15_000 });
    await this.playHint.click();
  }

  /** Open (or close) the whiteboard from the control bar */
  async toggleWhiteboard() {
    await this.whiteboardToggle.click();
  }

  /** Page counter matcher for "current / total", whatever the locale */
  static pageCounterText(current: number, total: number): RegExp {
    return new RegExp(`\\b${current}\\s*/\\s*${total}\\b`);
  }
}
