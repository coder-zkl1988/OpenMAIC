/**
 * Persona fidelity eval: the format of scenarios/courses.json, and how a
 * course's classroom prompt becomes a real Pi request for whichever roster
 * plays it (the fixed one in the file, or one the tested model generated).
 * Prompts name people by role placeholders ({teacher}, {assistant},
 * {student1}, ...), so the same prompt works for any roster. Pure: no model,
 * no I/O beyond reading the file.
 */
import { readFileSync } from 'fs';
import type { ClassAtmosphere } from '@/lib/orchestration/persona-guide';
import {
  validateScenarioFile,
  type CastingScenario,
  type CastingScenarioFile,
  type ScenarioAgent,
  type ScenarioMessage,
  type ScenarioPage,
} from '../pi-casting/scenario';
import { containsTerm, type CalibrationKey, type ExpectedScript } from './checks';

export type FidelityAgent = ScenarioAgent;

export interface FidelityPrompt {
  id: string;
  /**
   * The conversation; the last message is the learner's (none when the
   * prompt opens a discussion moment). Texts may name
   * people as {teacher}, {assistant}, {student1}...; an assistant message's
   * agentId may be such a placeholder too.
   */
  messages: ScenarioMessage[];
  /** Request config; triggerAgentId and addressedAgentIds may be placeholders */
  config?: CastingScenario['config'];
}

export interface FidelityClassroom {
  /** The fixed roster: at least 3 people, one teacher, one or more students */
  roster: FidelityAgent[];
  pages: ScenarioPage[];
  currentPageId: string;
  lectureProgress?: { pageId: string; actionIndex: number };
  /** Key terms that only the pages after the current one teach */
  upcomingTerms: string[];
  prompts: FidelityPrompt[];
}

export interface FidelityCourse {
  id: string;
  name: string;
  description?: string;
  languageDirective: string;
  /** The script personas should mostly be written in */
  expectScript?: ExpectedScript;
  /** The learner's self-description (persona generation places classmates around it) */
  learnerLevel?: string;
  /** Private details in learnerLevel that must never reach a persona */
  privateTerms?: string[];
  agentCount?: number;
  classAtmosphere?: ClassAtmosphere;
  sceneOutlines: Array<{ title: string; description?: string }>;
  /** Present: the course is also played as a class (speaker and boundary tests) */
  classroom?: FidelityClassroom;
}

export interface CalibrationPersona {
  key: CalibrationKey;
  name: string;
  role: 'student';
  persona: string;
}

export interface FidelityFile {
  /** Three fixed personas the judge must rank right before its scores are used */
  calibration: { courseId: string; personas: CalibrationPersona[] };
  courses: FidelityCourse[];
}

export function loadFidelityFile(path: string): FidelityFile {
  return JSON.parse(readFileSync(path, 'utf-8')) as FidelityFile;
}

// ==================== Roster placeholders ====================

const PLACEHOLDER = /\{(teacher|assistant|student\d+)\}/g;

/** The roster by placeholder: teacher, the first assistant, student1, student2... */
export function rosterRefs(roster: readonly FidelityAgent[]): Record<string, FidelityAgent> {
  const refs: Record<string, FidelityAgent> = {};
  const teacher = roster.find((agent) => agent.role === 'teacher');
  const assistant = roster.find((agent) => agent.role === 'assistant');
  if (teacher) refs.teacher = teacher;
  if (assistant) refs.assistant = assistant;
  roster
    .filter((agent) => agent.role === 'student')
    .forEach((student, index) => {
      refs[`student${index + 1}`] = student;
    });
  return refs;
}

/** The placeholders a text uses that the roster cannot fill */
export function missingRefs(text: string, refs: Readonly<Record<string, FidelityAgent>>): string[] {
  return [...new Set(Array.from(text.matchAll(PLACEHOLDER), (match) => match[1]!))].filter(
    (ref) => !refs[ref],
  );
}

/** A text with each placeholder replaced by that person's name */
export function fillNames(text: string, refs: Readonly<Record<string, FidelityAgent>>): string {
  return text.replace(PLACEHOLDER, (whole, ref: string) => refs[ref]?.name ?? whole);
}

/** An agent reference: a placeholder or a literal roster id */
export function resolveAgentRef(
  value: string,
  refs: Readonly<Record<string, FidelityAgent>>,
  roster: readonly FidelityAgent[],
): string | undefined {
  const match = /^\{(teacher|assistant|student\d+)\}$/.exec(value.trim());
  if (match) return refs[match[1]!]?.id;
  return roster.some((agent) => agent.id === value) ? value : undefined;
}

// ==================== Classroom requests ====================

export type ClassroomScenario =
  | { file: CastingScenarioFile; scenario: CastingScenario; learnerText: string }
  | { skip: string };

/**
 * The casting-eval scenario (and so the Pi request) for one prompt played by
 * one roster. A prompt that names a person the roster lacks (a generated
 * class without an assistant, say) is skipped with the reason.
 */
export function buildClassroomScenario(
  course: FidelityCourse,
  prompt: FidelityPrompt,
  roster: readonly FidelityAgent[],
): ClassroomScenario {
  const classroom = course.classroom;
  if (!classroom) return { skip: `${course.id} has no classroom` };
  const refs = rosterRefs(roster);
  const missing = new Set<string>();
  const resolveId = (value: string) => {
    const id = resolveAgentRef(value, refs, roster);
    if (!id) missing.add(value);
    return id;
  };
  const messages = prompt.messages.map((message): ScenarioMessage => {
    for (const ref of missingRefs(message.text, refs)) missing.add(`{${ref}}`);
    const text = fillNames(message.text, refs);
    if (message.role === 'assistant' && message.agentId) {
      return { ...message, agentId: resolveId(message.agentId) ?? message.agentId, text };
    }
    return { ...message, text };
  });
  const config: CastingScenario['config'] = { ...prompt.config };
  if (prompt.config?.triggerAgentId) {
    config.triggerAgentId = resolveId(prompt.config.triggerAgentId);
  }
  if (prompt.config?.addressedAgentIds) {
    config.addressedAgentIds = prompt.config.addressedAgentIds.flatMap(
      (value) => resolveId(value) ?? [],
    );
  }
  for (const key of ['discussionTopic', 'discussionPrompt'] as const) {
    const value = prompt.config?.[key];
    if (value) {
      for (const ref of missingRefs(value, refs)) missing.add(`{${ref}}`);
      config[key] = fillNames(value, refs);
    }
  }
  if (missing.size > 0) {
    return { skip: `the roster has nobody for ${[...missing].join(', ')}` };
  }
  const scenario: CastingScenario = {
    id: `${course.id}/${prompt.id}`,
    description: '',
    roster: course.id,
    stageName: course.name,
    pages: classroom.pages,
    currentPageId: classroom.currentPageId,
    ...(classroom.lectureProgress ? { lectureProgress: classroom.lectureProgress } : {}),
    messages,
    config,
  };
  const file: CastingScenarioFile = {
    rosters: { [course.id]: [...roster] },
    scenarios: [scenario],
  };
  const learnerText = messages.findLast((message) => message.role === 'user')?.text ?? '';
  return { file, scenario, learnerText };
}

function pageIndex(classroom: FidelityClassroom): number {
  return classroom.pages.findIndex((page) => page.id === classroom.currentPageId);
}

/** The pages taught so far (up to the current one) and the pages still to come */
export function splitPages(classroom: FidelityClassroom): {
  taught: ScenarioPage[];
  upcoming: ScenarioPage[];
} {
  const index = pageIndex(classroom);
  return index < 0
    ? { taught: [], upcoming: classroom.pages }
    : { taught: classroom.pages.slice(0, index + 1), upcoming: classroom.pages.slice(index + 1) };
}

/**
 * The current page's narration up to the lecture position, as the Pi server
 * reads lectureProgress (nothing without one).
 */
export function currentNarration(classroom: FidelityClassroom): string[] {
  const page = classroom.pages.find((candidate) => candidate.id === classroom.currentPageId);
  const progress = classroom.lectureProgress;
  return page && progress?.pageId === page.id
    ? (page.speech ?? []).slice(0, progress.actionIndex + 1)
    : [];
}

/**
 * What the class has heard: every taught page's title and key points, the
 * narration of the pages before the current one, and the current page's
 * narration up to the lecture position.
 */
export function taughtText(classroom: FidelityClassroom): string {
  const { taught } = splitPages(classroom);
  return taught
    .map((page) => {
      const speech =
        page.id === classroom.currentPageId ? currentNarration(classroom) : (page.speech ?? []);
      return [page.title, ...(page.keyPoints ?? []), ...speech].join('\n');
    })
    .join('\n');
}

// ==================== Validation ====================

/** Everything wrong with the file, one line each (empty when it is sound) */
export function validateFidelityFile(file: FidelityFile): string[] {
  const problems: string[] = [];
  const keys = new Set((file.calibration?.personas ?? []).map((persona) => persona.key));
  for (const key of ['plain', 'caricature', 'script'] as const) {
    if (!keys.has(key)) problems.push(`calibration: no "${key}" persona`);
  }
  if (!file.courses?.some((course) => course.id === file.calibration?.courseId)) {
    problems.push('calibration: courseId is not a course');
  }
  const courseIds = new Set<string>();
  for (const course of file.courses ?? []) {
    const where = `course ${course.id}`;
    if (courseIds.has(course.id)) problems.push(`${where}: duplicate id`);
    courseIds.add(course.id);
    if (!course.name?.trim() || !course.languageDirective?.trim()) {
      problems.push(`${where}: needs a name and a languageDirective`);
    }
    if (!course.sceneOutlines?.length) problems.push(`${where}: needs scene outlines`);
    for (const term of course.privateTerms ?? []) {
      if (course.learnerLevel && !containsTerm(course.learnerLevel, term)) {
        problems.push(`${where}: private term "${term}" is not in learnerLevel`);
      }
    }
    const classroom = course.classroom;
    if (!classroom) continue;
    const roster = classroom.roster ?? [];
    if (roster.length < 3) problems.push(`${where}: a classroom needs at least 3 people`);
    if (roster.filter((agent) => agent.role === 'teacher').length !== 1) {
      problems.push(`${where}: a classroom needs exactly one teacher`);
    }
    if (!roster.some((agent) => agent.role === 'student')) {
      problems.push(`${where}: a classroom needs a student`);
    }
    const names = roster.map((agent) => agent.name.trim().toLowerCase());
    if (new Set(names).size !== names.length) problems.push(`${where}: duplicate names`);
    if (pageIndex(classroom) < 0) problems.push(`${where}: currentPageId is not a page`);
    const heard = taughtText(classroom);
    for (const term of classroom.upcomingTerms ?? []) {
      if (containsTerm(heard, term)) {
        problems.push(`${where}: upcoming term "${term}" is already in the taught pages`);
      }
    }
    const promptIds = new Set<string>();
    for (const prompt of classroom.prompts ?? []) {
      if (promptIds.has(prompt.id)) problems.push(`${where}: duplicate prompt id ${prompt.id}`);
      promptIds.add(prompt.id);
      // A discussion opens with no message; any other prompt ends with the learner's
      const opensMoment =
        prompt.messages.length === 0 && prompt.config?.sessionType === 'discussion';
      if (!opensMoment && prompt.messages.at(-1)?.role !== 'user') {
        problems.push(`${where}: prompt ${prompt.id} must end with the learner's message`);
      }
      const built = buildClassroomScenario(course, prompt, roster);
      if ('skip' in built) {
        problems.push(`${where}: prompt ${prompt.id}: ${built.skip}`);
        continue;
      }
      problems.push(
        ...validateScenarioFile(built.file).map(
          (problem) => `${where}: prompt ${prompt.id}: ${problem}`,
        ),
      );
    }
  }
  return problems;
}
