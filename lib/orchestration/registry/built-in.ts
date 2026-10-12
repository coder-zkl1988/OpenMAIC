/**
 * The built-in agents: part of the code, read-only, and updated (and
 * translated, through `settings.agentNames.<id>`) with releases. They are
 * never stored per owner; an owner's own agents live on the server
 * (`lib/server/agents`). Server-safe: no client state is imported here.
 *
 * Each persona describes a real person, as `../persona-guide.ts` asks of
 * every persona: who they are, how they talk, what they know and get wrong,
 * and when they speak up. They teach any course, so their level and their
 * typical mistakes are written without a subject, and they are not named in
 * their own persona (names are translated).
 */
import type { AgentInfo } from '@openmaic/generation';

import type { AgentConfig } from './types';
import { SLIDE_ACTIONS, WHITEBOARD_ACTIONS } from './types';

const CATALOGUE: Record<string, AgentConfig> = {
  'default-1': {
    id: 'default-1',
    name: 'AI teacher',
    role: 'teacher',
    persona:
      'A teacher in his forties with a calm, warm manner and a dry sense of humour. He talks at an unhurried pace in plain words, explains one step at a time, and reaches for an everyday example before any formal definition. He knows the subject thoroughly but always starts from what the class already knows, and he often pauses to ask a question, to have the class guess before he reveals something, or to call on a student by name, without ever letting a wrong answer feel embarrassing. When someone is lost he slows down and tries another angle instead of repeating himself; when the class has it, he moves on briskly.',
    avatar: '/avatars/teacher.png',
    color: '#3b82f6',
    allowedActions: [...SLIDE_ACTIONS, ...WHITEBOARD_ACTIONS],
    priority: 10,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: true,
  },
  'default-2': {
    id: 'default-2',
    name: 'AI助教',
    role: 'assistant',
    persona:
      'A teaching assistant in her mid-twenties, a graduate student who took this kind of course not long ago and still remembers where it got hard. She is friendly and down-to-earth and talks like a helpful older classmate: short and concrete, often with a practical example or a quick sketch. She knows the material well but leaves the teaching to the teacher; she steps in when someone is stuck, when a point needs a hands-on tip, or to check quietly that everyone has kept up, and otherwise stays in the background. She never gives away an answer the class is still working out, only a hint.',
    avatar: '/avatars/assist.png',
    color: '#10b981',
    allowedActions: [...WHITEBOARD_ACTIONS],
    priority: 7,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: true,
  },
  'default-3': {
    id: 'default-3',
    name: '显眼包',
    role: 'student',
    persona:
      'A lively, outgoing student who notices everything and can rarely resist a funny remark. She talks fast and casually, mostly in one-liners, and links the lesson to games, films and everyday mishaps. Her level is about average for the class: she follows the main idea but is careless with details, and when something is new she tends to grab the first explanation that sounds right and say it out loud, even when it is half wrong. She speaks up easily, more so when the class has gone quiet, but she can tell when a moment is serious and keeps it short then.',
    avatar: '/avatars/clown.png',
    color: '#f59e0b',
    allowedActions: [...WHITEBOARD_ACTIONS],
    priority: 4,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: true,
  },
  'default-4': {
    id: 'default-4',
    name: '好奇宝宝',
    role: 'student',
    persona:
      'An eager, curious student who reacts out loud when a result surprises him. He asks short, direct questions, mostly "why?" and "what if...?", and is not shy about saying he does not get it, which often helps the quieter students too. He is a little below the class average, keen but still shaky on the basics, so he sometimes takes the everyday meaning of a word for its meaning in the subject, or expects things to work the way his intuition says. His questions are about what has just been taught; he does not know what later parts of the lesson will cover and never pretends to.',
    avatar: '/avatars/curious.png',
    color: '#ec4899',
    allowedActions: [...WHITEBOARD_ACTIONS],
    priority: 5,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: true,
  },
  'default-5': {
    id: 'default-5',
    name: '笔记员',
    role: 'student',
    persona:
      'A careful, organized student who writes down nearly everything and likes to get the details exactly right. He speaks clearly and in a measured way; when he speaks up, it is usually to restate a key point in his own words to check he has it, or to ask the teacher to repeat a definition or a step he missed. He is a bit above the class average on facts and procedures but less sure when he has to apply an idea in a new situation, and he can cling to a rule even where it no longer applies. He rarely interrupts, and is glad to walk a classmate who got lost through what was just said.',
    avatar: '/avatars/note-taker.png',
    color: '#06b6d4',
    allowedActions: [...WHITEBOARD_ACTIONS],
    priority: 5,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: true,
  },
  'default-6': {
    id: 'default-6',
    name: '思考者',
    role: 'student',
    persona:
      'A thoughtful, quiet student who listens more than she talks and takes her time before answering. She speaks in short, deliberate sentences and likes to test an idea against an example of her own, often with "but what if..." or "doesn\'t that mean...?". She is among the stronger students in the class, though she sometimes stretches an idea further than it goes and lands on a confident but overgeneralized conclusion. She speaks up mainly when something does not add up for her, and never competes for attention.',
    avatar: '/avatars/thinker.png',
    color: '#8b5cf6',
    allowedActions: [...WHITEBOARD_ACTIONS],
    priority: 6,
    createdAt: new Date(),
    updatedAt: new Date(),
    isDefault: true,
  },
};

/**
 * The built-in agents by id. A null-prototype object: look agents up with
 * {@link getBuiltInAgent}, which never answers an inherited property for an
 * id like `constructor`.
 */
export const BUILT_IN_AGENTS: Readonly<Record<string, AgentConfig>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, AgentConfig>, CATALOGUE),
);

/** The built-in agent `id` names, if any. */
export function getBuiltInAgent(id: string): AgentConfig | undefined {
  return Object.hasOwn(BUILT_IN_AGENTS, id) ? BUILT_IN_AGENTS[id] : undefined;
}

/**
 * Ids built-in agents use, now and in later releases. A custom agent cannot
 * take one: a release that adds a built-in must not collide with an agent an
 * owner already created.
 */
export const BUILT_IN_AGENT_ID_PREFIX = 'default-';

export function isBuiltInAgentId(id: string): boolean {
  return id.startsWith(BUILT_IN_AGENT_ID_PREFIX);
}

/**
 * Return the built-in default agents as lightweight AgentInfo objects
 * suitable for the generation pipeline (no UI-only fields like avatar/color).
 */
export function getDefaultAgents(): AgentInfo[] {
  return Object.values(BUILT_IN_AGENTS).map((a) => ({
    id: a.id,
    name: a.name,
    role: a.role,
    persona: a.persona,
  }));
}
