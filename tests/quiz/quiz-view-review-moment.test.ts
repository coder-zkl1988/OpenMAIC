// @vitest-environment jsdom
/**
 * The quiz view tells the classroom about a fresh grading with wrong answers
 * (I11): once, with the missed questions (no answers); never for a quiz
 * reopened already reviewed, nor for a quiz without mistakes.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { QuizQuestion } from '@/lib/types/stage';

const mocks = vi.hoisted(() => ({
  state: undefined as unknown,
  recordPhase: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock('@/lib/quiz/runtime', () => ({
  loadQuizAttemptState: vi.fn(async () => ({ attemptId: 'attempt-1', state: mocks.state })),
  createQuizAttemptWriter: () => ({
    scheduleDraft: vi.fn(),
    flushDraft: async () => undefined,
    recordPhase: mocks.recordPhase,
    cancelDraft: vi.fn(),
  }),
  QuizRetryProgressedError: class extends Error {},
}));
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key, locale: 'en-US' }),
}));
vi.mock('@/components/audio/speech-button', () => ({ SpeechButton: () => null }));

import { QuizView } from '@/components/scene-renderers/quiz-view';
import { QuizReviewContext } from '@/lib/quiz/review-moment';

const questions: QuizQuestion[] = [
  {
    id: 'q1',
    type: 'single',
    question: 'What colour is chlorophyll?',
    options: [
      { label: 'Green', value: 'A' },
      { label: 'Red', value: 'B' },
    ],
    answer: ['A'],
  },
  {
    id: 'q2',
    type: 'single',
    question: 'Where does photosynthesis happen?',
    options: [
      { label: 'Roots', value: 'A' },
      { label: 'Leaves', value: 'B' },
    ],
    answer: ['B'],
  },
];

describe('QuizView: the review moment after grading', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onReviewed = vi.fn();

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    onReviewed.mockReset();
    mocks.recordPhase.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  async function render() {
    await act(async () => {
      root.render(
        createElement(
          QuizReviewContext.Provider,
          { value: onReviewed },
          createElement(QuizView, { questions, sceneId: 'quiz-1', stageId: 'stage-1' }),
        ),
      );
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function submit() {
    const button = [...container.querySelectorAll('button')].find(
      (candidate) => candidate.textContent === 'quiz.submitAnswers',
    )!;
    await act(async () => {
      button.click();
      for (let i = 0; i < 10; i++) await Promise.resolve();
    });
  }

  it('reports the questions answered wrong once graded, without the answers', async () => {
    mocks.state = {
      sessionId: 'attempt-1',
      status: 'active',
      phase: 'draft',
      answers: { q1: 'A', q2: 'A' },
    };
    await render();
    await submit();
    expect(onReviewed).toHaveBeenCalledExactlyOnceWith({
      stageId: 'stage-1',
      sceneId: 'quiz-1',
      misses: [
        {
          questionId: 'q2',
          number: 2,
          question: 'Where does photosynthesis happen?',
          type: 'single',
          aiGraded: false,
        },
      ],
    });
  });

  it('says nothing for a quiz without mistakes', async () => {
    mocks.state = {
      sessionId: 'attempt-1',
      status: 'active',
      phase: 'draft',
      answers: { q1: 'A', q2: 'B' },
    };
    await render();
    await submit();
    expect(mocks.recordPhase).toHaveBeenCalled();
    expect(onReviewed).not.toHaveBeenCalled();
  });

  it('says nothing when a reviewed quiz is reopened', async () => {
    mocks.state = {
      sessionId: 'attempt-1',
      status: 'completed',
      phase: 'reviewed',
      answers: { q1: 'B', q2: 'A' },
      results: [
        { questionId: 'q1', correct: false, status: 'incorrect', earned: 0 },
        { questionId: 'q2', correct: false, status: 'incorrect', earned: 0 },
      ],
    };
    await render();
    expect(container.textContent).toContain('quiz.quizReport');
    expect(onReviewed).not.toHaveBeenCalled();
  });
});
