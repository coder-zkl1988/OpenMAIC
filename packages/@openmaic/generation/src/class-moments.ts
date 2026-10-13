/**
 * Class moments: what happened in class on the pages before the one being
 * generated, read off the generated scenes. A page is generated alone, so
 * this is how it knows whether the class just had its say, spent the last
 * page working on a quiz, or has listened for a long stretch. The run engine
 * and the workbench's page tools read the same history through
 * {@link classMomentsFromScenes}.
 */
import type {
  AgentInfo,
  ClassActivityKind,
  ClassDiscussionMoment,
  ClassMoment,
} from './pipeline-types.js';

/** A generated page as the class moments read it: its type and its actions. */
export interface ClassMomentScene {
  type: string;
  actions?: ReadonlyArray<{ type: string; topic?: unknown; prompt?: unknown; agentId?: unknown }>;
}

const ACTIVITY_KINDS: ReadonlySet<string> = new Set<ClassActivityKind>([
  'quiz',
  'interactive',
  'pbl',
]);

function activityKindOf(type: string): ClassActivityKind | undefined {
  return ACTIVITY_KINDS.has(type) ? (type as ClassActivityKind) : undefined;
}

/**
 * A page's discussion as a class moment, named by who opened it. A moment
 * without an opener is the teacher's, as the classroom plays it.
 */
export function classMomentOf(
  discussion: { topic: string; prompt?: string; agentId?: string },
  page: number,
  agents: readonly AgentInfo[],
): ClassDiscussionMoment {
  const opener = discussion.agentId
    ? agents.find((agent) => agent.id === discussion.agentId)
    : agents.find((agent) => agent.role === 'teacher');
  const role = opener?.role ?? (discussion.agentId ? undefined : 'teacher');
  const prompt = typeof discussion.prompt === 'string' ? discussion.prompt.trim() : '';
  return {
    page,
    agentName: opener?.name ?? (discussion.agentId ? 'a student' : 'the teacher'),
    ...(role ? { agentRole: role } : {}),
    topic: discussion.topic,
    ...(prompt ? { prompt } : {}),
  };
}

/**
 * The class moments of the pages before `beforePage` (1-based), in page
 * order. `scenes` is the course in order, page N at index N - 1; a page not
 * generated yet is null. A quiz, interactive or project page is an activity
 * the whole class worked on, listed as such, not a silent page; a discussion
 * is named by who opened it.
 */
export function classMomentsFromScenes(
  scenes: ReadonlyArray<ClassMomentScene | null | undefined>,
  agents: readonly AgentInfo[],
  beforePage: number,
): ClassMoment[] {
  const moments: ClassMoment[] = [];
  const pages = Math.min(scenes.length, beforePage - 1);
  for (let index = 0; index < pages; index += 1) {
    const scene = scenes[index];
    if (!scene) continue;
    const page = index + 1;
    const kind = activityKindOf(scene.type);
    if (kind) moments.push({ page, kind });
    for (const action of scene.actions ?? []) {
      if (action.type !== 'discussion' || typeof action.topic !== 'string') continue;
      moments.push(
        classMomentOf(
          {
            topic: action.topic,
            ...(typeof action.prompt === 'string' ? { prompt: action.prompt } : {}),
            ...(typeof action.agentId === 'string' ? { agentId: action.agentId } : {}),
          },
          page,
          agents,
        ),
      );
    }
  }
  return moments;
}

/** A finished course's class moments in numbers, for observation and evaluation only. */
export interface ClassMomentsSummary {
  pages: number;
  discussions: number;
  /** Who opened the discussions, most first. */
  openers: Array<{ name: string; role?: string; count: number }>;
  /** Pages the class spent on a quiz, an interactive page or a project. */
  activityPages: number;
  /** The most pages in a row with neither a discussion nor an activity. */
  longestSilentStretch: number;
}

/**
 * Count a course's class moments over its `pages` pages. Never fed back into
 * a prompt: how often anyone speaks up comes from who they are, not from a
 * count.
 */
export function summarizeClassMoments(
  moments: readonly ClassMoment[],
  pages: number,
): ClassMomentsSummary {
  const lively = new Set<number>();
  const openers = new Map<string, { name: string; role?: string; count: number }>();
  let discussions = 0;
  let activityPages = 0;
  for (const moment of moments) {
    lively.add(moment.page);
    if (moment.kind && moment.kind !== 'discussion') {
      activityPages += 1;
      continue;
    }
    discussions += 1;
    const key = `${moment.agentName}\u0000${moment.agentRole ?? ''}`;
    const opener = openers.get(key) ?? {
      name: moment.agentName,
      ...(moment.agentRole ? { role: moment.agentRole } : {}),
      count: 0,
    };
    opener.count += 1;
    openers.set(key, opener);
  }
  let longestSilentStretch = 0;
  let stretch = 0;
  for (let page = 1; page <= pages; page += 1) {
    stretch = lively.has(page) ? 0 : stretch + 1;
    longestSilentStretch = Math.max(longestSilentStretch, stretch);
  }
  return {
    pages,
    discussions,
    openers: [...openers.values()].sort((a, b) => b.count - a.count),
    activityPages,
    longestSilentStretch,
  };
}
