/**
 * The quiz review moment (I11): the questions answered wrong, the card's
 * summary (by number and a short stem, never the answers) and the
 * director-only prompt (types, and which grading may be off).
 */
import { describe, expect, it } from 'vitest';
import type { QuizQuestion } from '@/lib/types/stage';
import {
  QUIZ_REVIEW_LISTED_MAX,
  buildQuizReviewPrompt,
  buildQuizReviewTopic,
  quizReviewMisses,
} from '@/lib/quiz/review-moment';

const questions: QuizQuestion[] = [
  { id: 'q1', type: 'single', question: 'What colour is chlorophyll?', options: [], answer: ['A'] },
  { id: 'q2', type: 'multiple', question: 'Which   are  products?', options: [], answer: ['B'] },
  { id: 'q3', type: 'short_answer', question: 'Explain why leaves look green in summer light.' },
  { id: 'q4', type: 'single', question: 'Where?', answer: ['C'] },
  { id: 'q5', type: 'single', question: 'When?', answer: ['D'] },
];

const format = {
  question: (n: number, stem: string) => `Q${n} “${stem}”`,
  separator: '; ',
  more: (count: number) => ` and ${count} more`,
  topic: (list: string) => `Let's go over: ${list}`,
};

describe('quiz review moment', () => {
  it('lists the questions answered wrong, in quiz order', () => {
    const misses = quizReviewMisses(questions, [
      { questionId: 'q3', status: 'incorrect' },
      { questionId: 'q1', status: 'correct' },
      { questionId: 'q2', status: 'incorrect' },
    ]);
    expect(misses).toEqual([
      {
        questionId: 'q2',
        number: 2,
        question: 'Which are products?',
        type: 'multiple',
        aiGraded: false,
      },
      {
        questionId: 'q3',
        number: 3,
        question: 'Explain why leaves look green in summer light.',
        type: 'short_answer',
        aiGraded: true,
      },
    ]);
    expect(quizReviewMisses(questions, [{ questionId: 'q1', status: 'correct' }])).toEqual([]);
  });

  it('words the card by number and short stem, counting the rest', () => {
    const all = quizReviewMisses(
      questions,
      questions.map((question) => ({ questionId: question.id, status: 'incorrect' as const })),
    );
    const topic = buildQuizReviewTopic(all, format);
    expect(topic).toBe(
      "Let's go over: Q1 “What colour is chlorophyll?”; Q2 “Which are products?”; Q3 “Explain why leaves look green…” and 2 more",
    );
    expect(QUIZ_REVIEW_LISTED_MAX).toBe(3);
  });

  it('tells the director the types and which grading may be off, never the answers', () => {
    const prompt = buildQuizReviewPrompt(
      quizReviewMisses(questions, [
        { questionId: 'q1', status: 'incorrect' },
        { questionId: 'q3', status: 'incorrect' },
      ]),
    );
    expect(prompt).toContain('Q1 (single choice): «What colour is chlorophyll?»');
    expect(prompt).toContain(
      'Q3 (short answer, graded by the AI grader: the grading may be inaccurate)',
    );
    expect(prompt).not.toMatch(/\["?A"?\]/);
  });
});
