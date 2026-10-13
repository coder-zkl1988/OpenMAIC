/**
 * The review moment after a graded quiz (I11): when the learner's submission
 * comes back with wrong answers, the classroom offers a skippable class
 * moment to go over them ('quiz-review'). Its card shows the client's summary
 * of the missed questions (never the answers); who opens it is the director's
 * choice (by default the teacher).
 *
 * The quiz view reports a fresh review through QuizReviewContext; the
 * playback chrome provides it (outside a classroom nothing listens).
 */

import { createContext } from 'react';
import type { QuestionResult } from '@/lib/quiz/grading';
import type { QuizQuestion } from '@/lib/types/stage';

/** One question the learner got wrong */
export interface QuizReviewMiss {
  questionId: string;
  /** 1-based position in the quiz */
  number: number;
  /** The question's stem, as the quiz shows it */
  question: string;
  type: QuizQuestion['type'];
  /** Graded by the AI grader (a short answer): its verdict may be off */
  aiGraded: boolean;
}

/** A quiz just graded with wrong answers */
export interface QuizReviewedEvent {
  stageId: string;
  sceneId: string;
  misses: QuizReviewMiss[];
}

/**
 * The quiz view's line to the classroom: called once per fresh grading that
 * has wrong answers (not when a reviewed quiz is reopened). Null outside a
 * classroom.
 */
export const QuizReviewContext = createContext<((event: QuizReviewedEvent) => void) | null>(null);

/** The questions answered wrong, in quiz order */
export function quizReviewMisses(
  questions: readonly QuizQuestion[],
  results: readonly Pick<QuestionResult, 'questionId' | 'status'>[],
): QuizReviewMiss[] {
  const wrong = new Set(
    results.filter((result) => result.status === 'incorrect').map((result) => result.questionId),
  );
  return questions.flatMap((question, index) =>
    wrong.has(question.id)
      ? [
          {
            questionId: question.id,
            number: index + 1,
            question: question.question.replace(/\s+/g, ' ').trim(),
            type: question.type,
            aiGraded: question.type === 'short_answer',
          },
        ]
      : [],
  );
}

/** Questions named one by one on the card; the rest are counted */
export const QUIZ_REVIEW_LISTED_MAX = 3;

/** A stem quoted on the card is cut to this many characters */
export const QUIZ_REVIEW_STEM_MAX_CHARS = 30;

function cutStem(text: string, maxChars: number): string {
  const chars = Array.from(text);
  return chars.length <= maxChars
    ? text
    : `${chars
        .slice(0, maxChars - 1)
        .join('')
        .trimEnd()}…`;
}

/**
 * The card's words: the missed questions by number and a short stem, the
 * first QUIZ_REVIEW_LISTED_MAX of them, the rest counted. Localized through
 * the given formatters; no answers.
 */
export function buildQuizReviewTopic(
  misses: readonly QuizReviewMiss[],
  format: {
    question: (number: number, stem: string) => string;
    separator: string;
    more: (count: number) => string;
    topic: (questions: string) => string;
  },
): string {
  const listed = misses
    .slice(0, QUIZ_REVIEW_LISTED_MAX)
    .map((miss) =>
      format.question(miss.number, cutStem(miss.question, QUIZ_REVIEW_STEM_MAX_CHARS)),
    );
  const rest = misses.length - listed.length;
  const questions = listed.join(format.separator) + (rest > 0 ? format.more(rest) : '');
  return format.topic(questions);
}

const TYPE_LABELS: Record<QuizQuestion['type'], string> = {
  single: 'single choice',
  multiple: 'multiple choice',
  short_answer: 'short answer',
};

/**
 * The director-only intent of the review moment (discussionPrompt): which
 * questions went wrong, of which type, and which were graded by the AI (its
 * grading may be off). No answers: the director reads the quiz page for them.
 */
export function buildQuizReviewPrompt(misses: readonly QuizReviewMiss[]): string {
  const lines = misses.map((miss) => {
    const kind = miss.aiGraded
      ? `${TYPE_LABELS[miss.type]}, graded by the AI grader: the grading may be inaccurate`
      : TYPE_LABELS[miss.type];
    return `- Q${miss.number} (${kind}): «${cutStem(miss.question, 120).replace(/[«»]/g, '"')}»`;
  });
  return [
    'Quiz review: the learner just submitted the quiz on this page and got these questions wrong (read the quiz page for the questions, the answers and the learner’s own answers):',
    ...lines,
  ].join('\n');
}
