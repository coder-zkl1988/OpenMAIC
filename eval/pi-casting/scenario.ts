/**
 * Pi casting eval scenarios: the JSON format of scenarios/casting.json, and
 * how one becomes a real Pi request plus the scripted child speech that
 * stands in for the child LLM runs (runPiDirectorLoop's childTurnStub).
 * Pure: no model, no I/O beyond reading the scenario file.
 */
import { readFileSync } from 'fs';
import type { AgentConfig } from '@/lib/orchestration/registry/types';
import {
  DISCUSSION_MOMENT_KINDS,
  LEARNER_STANCES,
  type ClassMemory,
  type ClassPresence,
  type PiChildTurnStub,
  type PiChildTurnStubInput,
  type StatelessChatRequest,
} from '@/lib/types/chat';
import type { Expectation } from './scoring';

export interface ScenarioAgent {
  id: string;
  name: string;
  role: 'teacher' | 'assistant' | 'student';
  persona: string;
}

export interface ScenarioPage {
  id: string;
  title: string;
  keyPoints?: string[];
  /** The lecture narration, one speech action per line */
  speech?: string[];
  /** Lecture moments (discussion actions) after the narration */
  moments?: Array<{ id: string; topic: string; agentId?: string; prompt?: string }>;
}

export interface ScenarioMessage {
  role: 'user' | 'assistant';
  /** The speaker of an assistant message */
  agentId?: string;
  text: string;
}

export interface CastingScenario {
  id: string;
  description: string;
  /** e.g. 'observed-failure', 'counter-example' */
  tags?: string[];
  /** A roster name from the file's `rosters` */
  roster: string;
  /** The agents in this request (default: the whole roster) */
  agentIds?: string[];
  stageName?: string;
  pages: ScenarioPage[];
  currentPageId?: string;
  lectureProgress?: { pageId: string; actionIndex: number };
  messages: ScenarioMessage[];
  config?: Pick<
    StatelessChatRequest['config'],
    | 'sessionType'
    | 'discussionTopic'
    | 'discussionPrompt'
    | 'triggerAgentId'
    | 'momentKind'
    | 'learnerStance'
    | 'addressedAgentIds'
    | 'teacherMayCallOnLearner'
    | 'asideToLecture'
    | 'piMaxAgentTurns'
  > & { classPresence?: ClassPresence; classMemory?: ClassMemory };
  userProfile?: StatelessChatRequest['userProfile'];
  /**
   * Scripted speech per agent, consumed in call order (the last line repeats
   * when the director calls the agent more often). An agent without lines
   * says a neutral line for its role.
   */
  scripts?: Record<string, string[]>;
  /** Also run with real child agents when EVAL_E2E=1 */
  e2e?: boolean;
  /** Uncontroversial checks only; everything else is reported as a distribution */
  expect?: Expectation[];
}

export interface CastingScenarioFile {
  rosters: Record<string, ScenarioAgent[]>;
  scenarios: CastingScenario[];
}

export function loadCastingScenarios(path: string): CastingScenarioFile {
  return JSON.parse(readFileSync(path, 'utf-8')) as CastingScenarioFile;
}

const EPOCH = new Date('2026-01-01T00:00:00Z');

/** The scenario's agents as full configs (what the route resolves) */
export function scenarioAgents(
  file: CastingScenarioFile,
  scenario: CastingScenario,
): AgentConfig[] {
  const roster = file.rosters[scenario.roster];
  if (!roster) throw new Error(`Scenario ${scenario.id}: unknown roster "${scenario.roster}"`);
  const ids = scenario.agentIds ?? roster.map((agent) => agent.id);
  return ids.map((id) => {
    const agent = roster.find((candidate) => candidate.id === id);
    if (!agent) throw new Error(`Scenario ${scenario.id}: agent "${id}" is not in its roster`);
    return {
      ...agent,
      avatar: '',
      color: '#888888',
      allowedActions: [],
      priority: agent.role === 'teacher' ? 10 : agent.role === 'assistant' ? 7 : 5,
      createdAt: EPOCH,
      updatedAt: EPOCH,
      isDefault: false,
    };
  });
}

/** The Pi request the client would send for this scenario */
export function buildScenarioRequest(
  file: CastingScenarioFile,
  scenario: CastingScenario,
): StatelessChatRequest {
  const agents = scenarioAgents(file, scenario);
  const roster = file.rosters[scenario.roster] ?? [];
  const nameOf = (id: string | undefined) => roster.find((agent) => agent.id === id)?.name;
  const stageId = `eval-${scenario.id}`;
  const scenes = scenario.pages.map((page, index) => ({
    id: page.id,
    stageId,
    outlineId: `outline-${page.id}`,
    title: page.title,
    order: index + 1,
    type: 'slide' as const,
    content: { type: 'slide' as const, canvas: { elements: [] } },
    actions: [
      ...(page.speech ?? []).map((text, line) => ({
        id: `${page.id}-speech-${line + 1}`,
        type: 'speech' as const,
        text,
      })),
      ...(page.moments ?? []).map((moment) => ({
        id: moment.id,
        type: 'discussion' as const,
        topic: moment.topic,
        ...(moment.prompt ? { prompt: moment.prompt } : {}),
        ...(moment.agentId ? { agentId: moment.agentId } : {}),
      })),
    ],
  }));
  const outlines = scenario.pages.map((page, index) => ({
    id: `outline-${page.id}`,
    type: 'slide' as const,
    title: page.title,
    description: '',
    keyPoints: page.keyPoints ?? [],
    order: index + 1,
  }));
  const messages = scenario.messages.map((message, index) => ({
    id: `m${index + 1}`,
    role: message.role,
    parts: [{ type: 'text' as const, text: message.text }],
    ...(message.role === 'assistant' && message.agentId
      ? { metadata: { agentId: message.agentId, senderName: nameOf(message.agentId) } }
      : {}),
  }));
  const progress = scenario.lectureProgress;

  return {
    messages,
    storeState: {
      stage: {
        id: stageId,
        name: scenario.stageName ?? 'Eval course',
        createdAt: 0,
        updatedAt: 0,
        generatedAgentConfigs: roster.map((agent) => ({
          ...agent,
          avatar: '',
          color: '#888888',
          priority: 1,
        })),
      },
      scenes,
      outlines,
      currentSceneId: scenario.currentPageId ?? scenario.pages.at(-1)?.id ?? null,
      mode: 'autonomous',
      whiteboardOpen: false,
      ...(progress
        ? { lectureProgress: { sceneId: progress.pageId, actionIndex: progress.actionIndex } }
        : {}),
    },
    config: {
      agentIds: agents.map((agent) => agent.id),
      agentConfigs: agents.map(
        ({ createdAt: _c, updatedAt: _u, isDefault: _d, ...agent }) => agent,
      ),
      sessionType: 'qa',
      ...scenario.config,
    },
    ...(scenario.userProfile ? { userProfile: scenario.userProfile } : {}),
    apiKey: '',
  } as unknown as StatelessChatRequest;
}

const NEUTRAL_LINES: Record<string, string> = {
  teacher: '好，我们把这一点再理一理。',
  assistant: '我补充一个小例子，可能更好理解。',
  student: '嗯……我好像有点懂了。',
};

/**
 * The scripted child speech of a scenario: each agent's lines in call order.
 * Fresh per sample, so every run starts from the first line. `onCall` sees
 * every delegation (who, why, with which scene evidence) before it is answered.
 */
export function createScriptedChildStub(
  scenario: CastingScenario,
  agents: readonly Pick<AgentConfig, 'id' | 'role'>[],
  onCall?: (input: PiChildTurnStubInput) => void,
): PiChildTurnStub {
  const calls = new Map<string, number>();
  return (input) => {
    onCall?.(input);
    const { agentId } = input;
    const count = calls.get(agentId) ?? 0;
    calls.set(agentId, count + 1);
    const lines = scenario.scripts?.[agentId];
    if (lines && lines.length > 0) return lines[Math.min(count, lines.length - 1)];
    const role = agents.find((agent) => agent.id === agentId)?.role ?? 'student';
    return NEUTRAL_LINES[role] ?? NEUTRAL_LINES.student;
  };
}

/**
 * The pages the lesson has not reached: those after the current page (none
 * when the scenario sits on its last page). Students never get their evidence.
 */
export function upcomingSceneIds(scenario: CastingScenario): string[] {
  const currentId = scenario.currentPageId ?? scenario.pages.at(-1)?.id;
  const index = scenario.pages.findIndex((page) => page.id === currentId);
  return index < 0 ? [] : scenario.pages.slice(index + 1).map((page) => page.id);
}

/** The scenarios to run: by id and by tag (an empty filter keeps everything) */
export function selectScenarios(
  scenarios: readonly CastingScenario[],
  filter: { ids?: readonly string[]; tags?: readonly string[] },
): CastingScenario[] {
  const ids = new Set(filter.ids ?? []);
  const tags = new Set(filter.tags ?? []);
  return scenarios.filter(
    (scenario) =>
      (ids.size === 0 || ids.has(scenario.id)) &&
      (tags.size === 0 || (scenario.tags ?? []).some((tag) => tags.has(tag))),
  );
}

/**
 * Everything wrong with a scenario file, one line each (empty when it is
 * sound). A scenario must be a request the route would pass through as it is
 * (see app/api/chat/pi/route.ts): otherwise the eval would measure a request
 * production never sends.
 */
export function validateScenarioFile(file: CastingScenarioFile): string[] {
  const problems: string[] = [];
  for (const [rosterName, roster] of Object.entries(file.rosters ?? {})) {
    const ids = roster.map((agent) => agent.id);
    if (new Set(ids).size !== ids.length) problems.push(`roster ${rosterName}: duplicate ids`);
    if (roster.filter((agent) => agent.role === 'teacher').length > 1) {
      problems.push(`roster ${rosterName}: more than one teacher`);
    }
  }
  const scenarioIds = new Set<string>();
  for (const scenario of file.scenarios ?? []) {
    const where = `scenario ${scenario.id}`;
    if (scenarioIds.has(scenario.id)) problems.push(`${where}: duplicate id`);
    scenarioIds.add(scenario.id);
    const roster = file.rosters?.[scenario.roster];
    if (!roster) {
      problems.push(`${where}: unknown roster "${scenario.roster}"`);
      continue;
    }
    const rosterIds = new Set(roster.map((agent) => agent.id));
    const agentIds = new Set(scenario.agentIds ?? rosterIds);
    for (const id of agentIds) {
      if (!rosterIds.has(id)) problems.push(`${where}: agent "${id}" is not in its roster`);
    }
    const pages = new Map(scenario.pages.map((page) => [page.id, page]));
    if (pages.size !== scenario.pages.length) problems.push(`${where}: duplicate page ids`);
    if (scenario.currentPageId && !pages.has(scenario.currentPageId)) {
      problems.push(`${where}: currentPageId "${scenario.currentPageId}" is not a page`);
    }
    const progress = scenario.lectureProgress;
    if (progress) {
      const page = pages.get(progress.pageId);
      const actions = (page?.speech?.length ?? 0) + (page?.moments?.length ?? 0);
      if (!page) problems.push(`${where}: lectureProgress page "${progress.pageId}" is not a page`);
      else if (!Number.isInteger(progress.actionIndex) || progress.actionIndex < 0) {
        problems.push(`${where}: lectureProgress.actionIndex must be an integer >= 0`);
      } else if (progress.actionIndex >= actions) {
        problems.push(`${where}: lectureProgress.actionIndex is past the page's actions`);
      }
    }
    const momentIds = new Set(
      scenario.pages.flatMap((page) => (page.moments ?? []).map((moment) => moment.id)),
    );
    for (const page of scenario.pages) {
      for (const moment of page.moments ?? []) {
        if (moment.agentId && !rosterIds.has(moment.agentId)) {
          problems.push(`${where}: moment ${moment.id} opener "${moment.agentId}" is unknown`);
        }
      }
    }
    for (const message of scenario.messages) {
      if (message.role === 'assistant' && (!message.agentId || !rosterIds.has(message.agentId))) {
        problems.push(`${where}: an assistant message needs a roster agentId`);
      }
    }
    const config = scenario.config ?? {};
    const discussion = config.sessionType === 'discussion';
    if (
      config.momentKind &&
      !(DISCUSSION_MOMENT_KINDS as readonly string[]).includes(config.momentKind)
    ) {
      problems.push(`${where}: unknown momentKind "${config.momentKind}"`);
    }
    if (config.momentKind && !discussion) {
      problems.push(`${where}: momentKind needs sessionType "discussion" (the route drops it)`);
    }
    if (config.learnerStance) {
      if (!(LEARNER_STANCES as readonly string[]).includes(config.learnerStance)) {
        problems.push(`${where}: unknown learnerStance "${config.learnerStance}"`);
      }
      if (config.momentKind !== 'ask-learner') {
        problems.push(
          `${where}: learnerStance needs momentKind "ask-learner" (the route drops it)`,
        );
      }
    }
    if (config.triggerAgentId && !agentIds.has(config.triggerAgentId)) {
      problems.push(`${where}: triggerAgentId is not one of the request's agents`);
    }
    for (const id of config.addressedAgentIds ?? []) {
      if (!agentIds.has(id))
        problems.push(`${where}: addressed agent "${id}" is not in the request`);
    }
    const presenceIds = new Set<string>();
    for (const entry of config.classPresence?.agents ?? []) {
      if (!agentIds.has(entry.agentId) || presenceIds.has(entry.agentId)) {
        problems.push(`${where}: classPresence entry "${entry.agentId}" would be dropped`);
      }
      presenceIds.add(entry.agentId);
      if (entry.lastSceneId && !pages.has(entry.lastSceneId)) {
        problems.push(`${where}: classPresence lastSceneId "${entry.lastSceneId}" is not a page`);
      }
    }
    for (const moment of config.classPresence?.moments ?? []) {
      if (!momentIds.has(moment.actionId)) {
        problems.push(
          `${where}: classPresence moment "${moment.actionId}" is not a discussion action`,
        );
      }
    }
    // An aside's memory may name the whole class: the request's stage carries the roster
    const memoryIds = config.asideToLecture === true ? rosterIds : agentIds;
    for (const entry of config.classMemory?.entries ?? []) {
      for (const point of entry.points) {
        if (!memoryIds.has(point.agentId)) {
          problems.push(`${where}: classMemory point of "${point.agentId}" would be dropped`);
        }
      }
    }
    for (const id of Object.keys(scenario.scripts ?? {})) {
      if (!agentIds.has(id))
        problems.push(`${where}: script for "${id}", who is not in the request`);
    }
    for (const expectation of scenario.expect ?? []) {
      if ('agentId' in expectation && !agentIds.has(expectation.agentId)) {
        problems.push(
          `${where}: expectation names "${expectation.agentId}", who is not in the request`,
        );
      }
    }
  }
  return problems;
}
