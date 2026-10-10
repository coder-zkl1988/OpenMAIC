import type { Page, Locator } from '@playwright/test';

export class HomePage {
  readonly page: Page;
  readonly logo: Locator;
  /** The requirement textarea inside the home composer */
  readonly textarea: Locator;
  readonly enterButton: Locator;
  /** Course cards in the library (ClassroomCard) */
  readonly libraryCards: Locator;
  readonly folderCards: Locator;

  constructor(page: Page) {
    this.page = page;
    this.logo = page.locator('img[alt="OpenMAIC"]');
    // By testid: the profile panel's bio textarea sits before it in the same composer
    this.textarea = page.getByTestId('home-requirement');
    this.enterButton = page
      .getByRole('button', { name: /enter/i })
      .or(page.locator('button:has-text("进入课堂")'));
    this.libraryCards = page.getByTestId('library-card');
    this.folderCards = page.getByTestId('folder-card');
  }

  async goto() {
    await this.page.goto('/');
  }

  async fillRequirement(text: string) {
    await this.textarea.fill(text);
  }

  async submit() {
    await this.enterButton.click();
  }

  /** The library card whose title contains `name` */
  libraryCard(name: string): Locator {
    return this.libraryCards.filter({ hasText: name });
  }

  /** A card's ⋯ trigger (always in the DOM; it opens the actions menu in place) */
  cardMenuTrigger(name: string): Locator {
    return this.libraryCard(name).getByTestId('card-actions-trigger');
  }
}
