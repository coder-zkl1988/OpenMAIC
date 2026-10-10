import { test, expect } from '../fixtures/base';
import { createSettingsStorage } from '../fixtures/test-data/settings';
import type { Page, Route } from '@playwright/test';
import { seedServerDocument, setCurrentScene, uniqueStageId } from '../fixtures/server-seed';

/**
 * The 举手 flow end to end (HandRaiseFlow.dc.html): raise a bare hand while
 * the teacher speaks, the line finishes and the learner is called (the
 * lecture pauses), ask by text, the answer soft-closes, and the lecture
 * resumes on the NEXT line (the finished one is not replayed).
 *
 * Timing comes from the engine's reading timer (no TTS in the test settings):
 * the first line is long enough to raise the hand while it plays. The chat
 * API is mocked with one scripted answer that closes the session.
 */

const STAGE_PREFIX = 'stage-hand-raise-e2e';
const SCENE_ID = 'scene-hand-raise-e2e';

const FIRST_LINE =
  'Photosynthesis happens in the chloroplasts of plant cells, where chlorophyll absorbs light ' +
  'energy and the plant turns water and carbon dioxide into glucose and oxygen, step by step.';
const SECOND_LINE = 'Next we look at the light reactions.';
const ANSWER = 'Chlorophyll reflects green light, so leaves look green.';

async function seedStage(page: Page): Promise<string> {
  await page.goto('/classroom/warmup-nonexistent');
  const stageId = uniqueStageId(STAGE_PREFIX);
  const now = Date.now();
  await seedServerDocument(page, {
    stage: { id: stageId, name: 'Hand Raise E2E Stage', createdAt: now, updatedAt: now },
    scenes: [
      {
        id: SCENE_ID,
        stageId,
        type: 'slide',
        title: 'Hand Raise E2E Scene',
        order: 0,
        content: { type: 'slide', canvas: { elements: [], background: { color: '#ffffff' } } },
        actions: [
          { id: 'act-speech-1', type: 'speech', text: FIRST_LINE },
          { id: 'act-speech-2', type: 'speech', text: SECOND_LINE },
          { id: 'act-speech-3', type: 'speech', text: 'And then the dark reactions.' },
        ],
        createdAt: now,
        updatedAt: now,
      },
    ],
  });
  await setCurrentScene(page, stageId, SCENE_ID);
  return stageId;
}

/** One scripted Q&A turn: the teacher answers, then the director closes the session. */
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

test('raise a hand, get called at the end of the line, ask, and resume on the next line', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const questions: string[] = [];
  const answer = async (route: Route) => {
    // The chat client posts AI SDK UIMessages: the text lives in `parts`
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
  // Pi chat (the default) or the classic route, whichever the build uses
  await page.route('**/api/chat/pi', answer);
  await page.route('**/api/chat', answer);

  await page.addInitScript(
    (settings) => {
      localStorage.setItem('maic:account:settings-storage', settings);
      localStorage.setItem('locale', 'en-US');
    },
    createSettingsStorage({ autoPlayLecture: false }),
  );
  const stageId = await seedStage(page);
  await page.goto(`/classroom/${stageId}`);
  await expect(page.getByTestId('scene-title').first()).toBeAttached({ timeout: 30_000 });

  const caption = page.getByTestId('caption-strip');
  const captionText = page.getByTestId('caption-text');
  const composer = page.getByTestId('classroom-composer');

  // Start the lecture
  const overlayPlay = page.getByTestId('play-hint');
  await overlayPlay.waitFor({ state: 'visible', timeout: 15_000 });
  await overlayPlay.click();
  await expect(caption).toHaveAttribute('data-status', 'lecturing', { timeout: 15_000 });
  await expect(captionText).toContainText('Photosynthesis happens');

  // 1. Raise a bare hand: the lecture keeps going, the row shows the wait
  await composer.getByTestId('composer-raise-hand').click();
  const handRow = composer.getByTestId('composer-queued-question');
  await expect(handRow).toHaveAttribute('data-kind', 'hand');
  await expect(handRow).toContainText("Hand raised · you're up when this sentence ends");
  await expect(composer.getByTestId('composer-lower-hand')).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('participants')).toContainText('Hand raised');
  await expect(page.getByTestId('stream-hand-raised')).toContainText('You raised your hand');
  await expect(caption).toHaveAttribute('data-status', 'lecturing');

  // 2. The line ends: the learner is called and the classroom pauses
  await expect(composer.getByTestId('composer-cue')).toContainText(
    'Your turn to speak · class is paused',
    { timeout: 45_000 },
  );
  await expect(caption).toHaveAttribute('data-status', 'paused');
  await expect(page.getByTestId('caption-status')).toHaveText('Paused, your turn to speak');
  await expect(page.getByTestId('stream-cue')).toContainText('asks you to speak');
  const textarea = composer.getByPlaceholder('Say or type your question', { exact: true });
  await expect(textarea).toBeFocused();
  // The finished line stays on screen; the next one has not started
  await expect(captionText).toContainText('Photosynthesis happens');

  // 3. Ask by text
  await textarea.fill('Why are leaves green?');
  await textarea.press('Enter');
  await expect.poll(() => questions.length, { timeout: 15_000 }).toBeGreaterThan(0);
  await expect(composer.getByTestId('composer-cue')).toHaveCount(0);
  await expect(composer.getByTestId('composer-raise-hand')).toBeDisabled();
  await expect(composer.getByTestId('composer-raise-hand')).toHaveAttribute(
    'title',
    'You can speak directly during Q&A',
  );
  await expect(page.getByTestId('conversation-stream')).toContainText(ANSWER, {
    timeout: 30_000,
  });

  // 4. The soft close counts down, then the Q&A ends and the lecture resumes
  //    on the NEXT line — the finished one is not replayed
  await expect(page.getByText('Q&A ended', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(caption).toHaveAttribute('data-status', 'lecturing', { timeout: 15_000 });
  await expect(captionText).toContainText(SECOND_LINE);
  await expect(composer.getByTestId('composer-raise-hand')).toBeEnabled();
});

test('撤回 before the line ends withdraws the hand and the lecture plays on', async ({ page }) => {
  test.setTimeout(90_000);
  await page.route('**/api/chat/**', (route) => route.abort());
  await page.addInitScript(
    (settings) => {
      localStorage.setItem('maic:account:settings-storage', settings);
      localStorage.setItem('locale', 'en-US');
    },
    createSettingsStorage({ autoPlayLecture: false }),
  );
  const stageId = await seedStage(page);
  await page.goto(`/classroom/${stageId}`);
  await expect(page.getByTestId('scene-title').first()).toBeAttached({ timeout: 30_000 });

  const caption = page.getByTestId('caption-strip');
  const composer = page.getByTestId('classroom-composer');
  await page.getByTestId('play-hint').click();
  await expect(caption).toHaveAttribute('data-status', 'lecturing', { timeout: 15_000 });

  // H raises the hand too
  await page.keyboard.press('H');
  const handRow = composer.getByTestId('composer-queued-question');
  await expect(handRow).toHaveAttribute('data-kind', 'hand');
  await handRow.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(handRow).toHaveCount(0);
  await expect(composer.getByRole('status').filter({ hasText: 'Hand lowered' })).toHaveCount(1);

  // No call: the lecture moves on to the next line by itself
  await expect(page.getByTestId('caption-text')).toContainText(SECOND_LINE, { timeout: 45_000 });
  await expect(composer.getByTestId('composer-cue')).toHaveCount(0);
});
