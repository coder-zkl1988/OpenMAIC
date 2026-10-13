/**
 * Agent profiles: generate the classroom's agents (one teacher, plus
 * assistants and students) for a course from its name and scene outlines,
 * binding each to an advertised voice. The teacher speaks with the user's
 * narrator voice whenever that voice is usable. The logic of 1.1.x's
 * POST /api/generate/agent-profiles.
 *
 * The roster the model writes is checked (`validateRoster`, and that no
 * persona repeats the real learner's own words or name): a roster that fails
 * is asked for once more, with what was wrong appended to the prompt, and
 * refused only when that answer fails too. A usable class of another size
 * than the learner asked for is asked for once more too, but kept should that
 * retry fail or run out of time.
 */
import { nanoid } from 'nanoid';
import { callLLM } from '@/lib/ai/llm';
import { AGENT_COLOR_PALETTE } from '@/lib/constants/agent-defaults';
import { normalizeVoiceDesign } from '@/lib/audio/voice-design';
import { isQwenCloneVoice, resolveTTSModelForVoice } from '@/lib/audio/constants';
import {
  describeClassAtmosphere,
  formatRosterIssues,
  isCjkText,
  learnerNamePattern,
  PERSONA_GUIDE,
  validateRoster,
  type ClassAtmosphere,
  type RosterIssueCode,
  type RosterRole,
} from '@/lib/orchestration/persona-guide';

import { StepRefusal, type StepContext, type StepLanguageModel } from './context';

export interface AgentProfilesInput {
  /** The course: its name, and what the learner asked for as its description. */
  stageInfo: { name: string; description?: string };
  /**
   * The real learner's level, to place the classmates' levels around: their
   * own description of themselves, without their name. Personas are persisted
   * and shown to anyone who opens the course, so nothing of it may be copied
   * into them.
   */
  learnerLevel?: string;
  /**
   * The learner's name. Never shown to the model: only checked for, so that
   * no persona carries it.
   */
  learnerName?: string;
  sceneOutlines?: { title: string; description?: string }[];
  /**
   * How many people the class has, teacher included (the learner's class-size
   * setting). Absent: the model decides from the course.
   */
  agentCount?: number;
  /** What kind of people the class is made of (the learner's choice); it describes them only. */
  classAtmosphere?: ClassAtmosphere;
  languageDirective: string;
  availableAvatars: string[];
  avatarDescriptions?: Array<{ path: string; desc: string }>;
  availableVoices?: Array<{
    providerId: string;
    modelId?: string;
    voiceId: string;
    voiceName: string;
    voiceLanguage?: string;
  }>;
  /** The user's globally selected TTS voice; the teacher/narrator must use it. */
  narratorVoice?: {
    providerId: string;
    voiceId: string;
    modelId?: string;
  };
  /** The agent-profiles stage's model. */
  model: StepLanguageModel;
  /**
   * When the caller stops waiting (epoch ms). The optional retry of a usable
   * class of the wrong size gives up before it, so that class is kept.
   */
  deadlineAt?: number;
}

/**
 * The model's answer could not be read, did not make a valid classroom, had
 * another size than asked for ('agent-count'), or a persona repeated the real
 * learner's own words or name ('learner-detail').
 */
export type AgentProfilesRefusal =
  | 'unparseable'
  | 'agent-count'
  | 'learner-detail'
  | RosterIssueCode;

/** Answers the model is asked for: the first, and one more when it is unusable. */
const AGENT_PROFILES_ATTEMPTS = 2;

/** An optional retry starts only with this much time left before the deadline. */
const OPTIONAL_RETRY_MIN_MS = 20_000;
/** An optional retry ends this long before the deadline, so its class is still returned. */
const OPTIONAL_RETRY_MARGIN_MS = 2_000;

/** Consecutive CJK characters a persona may not share with the learner's own words. */
const LEARNER_ECHO_CJK_CHARS = 6;
/** Consecutive words a persona may not share with the learner's own words. */
const LEARNER_ECHO_WORDS = 4;
const CJK_RUNS = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu;

function wordsOf(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((word) => !isCjkText(word));
}

function wordGrams(words: readonly string[], size: number): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i + size <= words.length; i += 1) grams.add(words.slice(i, i + size).join(' '));
  return grams;
}

/**
 * The persona repeats the real learner: their name, or a stretch of their own
 * description (6+ CJK characters, or 4+ words, in a row). Personas are
 * persisted and shown to everyone who opens the course; the learner's words
 * only calibrate levels.
 */
export function echoesLearner(
  persona: string,
  learner: { level?: string; name?: string },
): boolean {
  const namePattern = learnerNamePattern(learner.name);
  if (namePattern && persona.search(namePattern) >= 0) return true;
  const level = learner.level;
  if (!level) return false;
  for (const run of level.match(CJK_RUNS) ?? []) {
    const chars = Array.from(run);
    for (let i = 0; i + LEARNER_ECHO_CJK_CHARS <= chars.length; i += 1) {
      if (persona.includes(chars.slice(i, i + LEARNER_ECHO_CJK_CHARS).join(''))) return true;
    }
  }
  const levelGrams = wordGrams(wordsOf(level), LEARNER_ECHO_WORDS);
  if (levelGrams.size === 0) return false;
  for (const gram of wordGrams(wordsOf(persona), LEARNER_ECHO_WORDS)) {
    if (levelGrams.has(gram)) return true;
  }
  return false;
}

type AdvertisedVoice = NonNullable<AgentProfilesInput['availableVoices']>[number];

/** A provider/voice binding (same shape as the agent's voiceConfig). */
export interface VoiceBinding {
  providerId: string;
  modelId?: string;
  voiceId: string;
}

export interface GeneratedAgentProfile {
  id: string;
  name: string;
  role: string;
  persona: string;
  avatar: string;
  color: string;
  priority: number;
  voiceConfig?: VoiceBinding;
  voiceDesign?: NonNullable<ReturnType<typeof normalizeVoiceDesign>>;
}

function advertisedVoiceToken(voice: VoiceBinding): string {
  return voice.modelId
    ? `${voice.providerId}::${voice.modelId}::${voice.voiceId}`
    : `${voice.providerId}::${voice.voiceId}`;
}

function findAdvertisedVoice(
  token: string,
  availableVoices: AdvertisedVoice[] | undefined,
): AdvertisedVoice | undefined {
  const exactMatch = availableVoices?.find((voice) => advertisedVoiceToken(voice) === token);
  if (exactMatch) return exactMatch;

  const parts = token.split('::');
  if (parts.length !== 2 && parts.length !== 3) return undefined;
  const providerId = parts[0];
  const voiceId = parts.at(-1);
  if (!providerId || !voiceId || (parts.length === 3 && !parts[1])) return undefined;

  // The voice is authoritative for its model. The optional model segment is
  // accepted for compatibility but never allowed to override the advertised binding.
  return availableVoices?.find(
    (voice) => voice.providerId === providerId && voice.voiceId === voiceId,
  );
}

/**
 * Resolve the narrator (teacher) voice from the user's explicit global choice.
 * It is honored only when the provider/voice is present in the advertised list
 * (which contains only enabled providers) or when it is a self-contained Qwen
 * clone. The binding always carries the advertised entry's model resolution so
 * provider/model/voice stay bound together (model follows voice).
 */
function resolveNarratorVoice(
  narratorVoice: NonNullable<AgentProfilesInput['narratorVoice']>,
  availableVoices: AdvertisedVoice[] | undefined,
): VoiceBinding | undefined {
  if (!narratorVoice.providerId || !narratorVoice.voiceId?.trim()) return undefined;

  const advertised = availableVoices?.find(
    (voice) =>
      voice.providerId === narratorVoice.providerId && voice.voiceId === narratorVoice.voiceId,
  );
  if (advertised) {
    return {
      providerId: advertised.providerId,
      ...(advertised.modelId ? { modelId: advertised.modelId } : {}),
      voiceId: advertised.voiceId,
    };
  }

  // Qwen clone IDs are account-scoped and self-contained: local profile storage
  // is not authoritative, so honor them even when not advertised and let the
  // model follow the voice.
  if (narratorVoice.providerId === 'qwen-tts' && isQwenCloneVoice(narratorVoice.voiceId)) {
    return {
      providerId: narratorVoice.providerId,
      modelId: resolveTTSModelForVoice(
        narratorVoice.providerId,
        narratorVoice.voiceId,
        narratorVoice.modelId,
      ),
      voiceId: narratorVoice.voiceId,
    };
  }

  return undefined;
}

function stripCodeFences(text: string): string {
  let cleaned = text.trim();
  // Remove markdown code fences (```json ... ``` or ``` ... ```)
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*\n?/, '').replace(/\n?```\s*$/, '');
  }
  return cleaned.trim();
}

/** One agent as the model wrote it; nothing in it is trusted yet. */
interface ModelAgent {
  name: string;
  role: string;
  persona: string;
  avatar?: unknown;
  color?: unknown;
  priority?: unknown;
  voice?: unknown;
  voiceDesign?: unknown;
}

type CheckedRoster = Array<ModelAgent & { role: RosterRole }>;

type RosterReading =
  | { ok: true; agents: CheckedRoster; warnings: string[] }
  | {
      ok: false;
      reason: AgentProfilesRefusal;
      /** For the log and the refusal (never the learner's own words). */
      message: string;
      /** What the retry prompt says was wrong, one line each. */
      feedback: string;
      warnings: string[];
      /**
       * A class that is fine but for its size ('agent-count'): kept should
       * the retry fail.
       */
      usable?: CheckedRoster;
    };

/**
 * Read and check one answer of the model. A class of another size than the
 * learner asked for is asked for again, but accepted on the last attempt: a
 * class of a different size beats the preset fallback. A persona repeating
 * the real learner (`learner`) is never accepted.
 */
export function readRoster(
  text: string,
  options: {
    agentCount?: number;
    lastAttempt?: boolean;
    learner?: { level?: string; name?: string };
  } = {},
): RosterReading {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFences(text));
  } catch {
    parsed = undefined;
  }
  const list = (parsed as { agents?: unknown } | undefined)?.agents;
  if (!Array.isArray(list)) {
    return {
      ok: false,
      reason: 'unparseable',
      message: 'Failed to parse agent profiles from LLM response',
      feedback:
        '- It was not a JSON object of the structure above (an object with an "agents" array).',
      warnings: [],
    };
  }
  const agents = list.map((entry): ModelAgent => {
    const agent = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    return {
      ...agent,
      name: typeof agent.name === 'string' ? agent.name : '',
      role: typeof agent.role === 'string' ? agent.role : '',
      persona: typeof agent.persona === 'string' ? agent.persona : '',
    };
  });
  const checked = validateRoster(agents);
  const warnings = checked.warnings.map((warning) => warning.message);
  const sizeIssue =
    options.agentCount && agents.length !== options.agentCount
      ? `- The class has exactly ${options.agentCount} agents (the teacher and ${options.agentCount - 1} others); there are ${agents.length}.`
      : undefined;
  const learner = options.learner;
  const echoing = learner
    ? agents.flatMap((agent, index) =>
        echoesLearner(agent.persona, learner)
          ? [`Agent ${index + 1}${agent.name.trim() ? ` ("${agent.name.trim()}")` : ''}`]
          : [],
      )
    : [];
  const echoIssue =
    echoing.length > 0
      ? `- ${echoing.join(', ')}: the persona repeats the real learner's own words or name. Describe each classmate in your own words, with nothing personal about the learner.`
      : undefined;
  if (checked.ok && !echoIssue) {
    if (!sizeIssue) return { ok: true, agents: checked.agents, warnings };
    if (options.lastAttempt) {
      warnings.push(`kept a class of ${agents.length}, not ${options.agentCount}`);
      return { ok: true, agents: checked.agents, warnings };
    }
    return {
      ok: false,
      reason: 'agent-count',
      message: `Expected ${options.agentCount} agents but the LLM returned ${agents.length}`,
      feedback: sizeIssue,
      warnings,
      usable: checked.agents,
    };
  }
  return {
    ok: false,
    reason: checked.issues[0]?.code ?? 'learner-detail',
    message: [
      ...checked.issues.map((issue) => issue.message),
      ...(echoIssue ? [`${echoing.join(', ')} repeat the learner's own words or name.`] : []),
    ].join(' '),
    feedback: [formatRosterIssues(checked.issues), echoIssue, sizeIssue].filter(Boolean).join('\n'),
    warnings,
  };
}

export async function generateAgentProfiles(
  input: AgentProfilesInput,
  ctx: StepContext,
): Promise<GeneratedAgentProfile[]> {
  const {
    stageInfo,
    learnerLevel,
    learnerName,
    sceneOutlines,
    agentCount,
    classAtmosphere,
    languageDirective,
    availableAvatars,
    avatarDescriptions,
    availableVoices,
    narratorVoice,
  } = input;
  const { model: languageModel, modelString, thinkingConfig, serverManaged } = input.model;
  const { log } = ctx;

  // ── Build prompt ──
  const sceneSummary = sceneOutlines?.length
    ? sceneOutlines
        .map((s, i) => `${i + 1}. ${s.title}${s.description ? ` — ${s.description}` : ''}`)
        .join('\n')
    : null;

  // The teacher must speak with the user's explicitly selected global voice
  // whenever it is usable; otherwise keep the old behavior (LLM-assigned).
  const narratorBinding = narratorVoice
    ? resolveNarratorVoice(narratorVoice, availableVoices)
    : undefined;

  const systemPrompt = `You are an expert instructional designer. Generate agent profiles for a multi-agent classroom simulation. ${
    agentCount
      ? `The class has exactly ${agentCount} agents.`
      : 'Decide the appropriate number of agents (typically 3-5) based on the course content and complexity.'
  } Return ONLY valid JSON, no markdown or explanation.`;

  // Build voice list for prompt (if available)
  const voiceListStr =
    availableVoices && availableVoices.length > 0
      ? JSON.stringify(
          availableVoices.map((v) => ({
            id: advertisedVoiceToken(v),
            name: v.voiceName,
            language: v.voiceLanguage || 'unknown',
          })),
        )
      : '';

  const voicePrompt = voiceListStr
    ? narratorBinding
      ? `- The teacher agent's voice is FIXED to the narrator voice "${advertisedVoiceToken(narratorBinding)}" — set by the system, so omit the "voice" field for the teacher
  - Every OTHER agent must still be assigned a voice from this list: ${voiceListStr}
  - Prefer a voice whose language matches the course language directive
  - Pick a voice that suits each agent's personality and role (e.g. lively voice for energetic student)
  - Try to use different voices for each non-teacher agent
  - Never assign the fixed teacher narrator voice to any other agent`
      : `- Each agent should be assigned a voice that matches their persona from this list: ${voiceListStr}
  - Prefer a voice whose language matches the course language directive
  - Pick a voice that suits the agent's personality and role (e.g. authoritative voice for teacher, lively voice for energetic student)
  - Try to use different voices for each agent`
    : '';

  // The schema example must always be an ADVERTISED token (findAdvertisedVoice
  // only resolves advertised voices), never the narrator token — a ghost clone
  // not in the advertised list would poison the example for non-teacher agents.
  const voiceJsonField = voiceListStr
    ? narratorBinding
      ? `,\n      "voice": "string (voice id from available list, e.g. '${advertisedVoiceToken(availableVoices![0])}'; omit for the teacher — its voice is fixed)"`
      : `,\n      "voice": "string (voice id from available list, e.g. '${advertisedVoiceToken(availableVoices![0])}')"`
    : '';

  const userPrompt = `Generate agent profiles for the following course:

Course name: ${stageInfo.name}
${stageInfo.description ? `Course description: ${stageInfo.description}` : ''}
${learnerLevel ? `The learner taking this course (private; only to judge their level): ${learnerLevel}` : ''}
${sceneSummary ? `\nScene outlines:\n${sceneSummary}\n` : ''}
Requirements:
- ${
    agentCount
      ? `Generate exactly ${agentCount} agents: the teacher and ${agentCount - 1} others`
      : 'Decide the appropriate number of agents based on the course content (typically 3-5)'
  }
- Exactly 1 agent must have role "teacher", the rest can be "assistant" or "student"
- Priority values: teacher=10 (highest), assistant=7, student=4-6
- Each agent needs: name, role, persona; every agent has their own name
- ${PERSONA_GUIDE.replace(/\n/g, '\n  ')}
- The students are the learner's classmates. ${learnerLevel ? "Place their levels around the learner's level given above" : 'Place their levels around the level the course is aimed at'}: most close to it, one perhaps a little ahead, one a little behind — never a copy of the learner.
- Make the students clearly different from one another, as students in a real class are.${
    classAtmosphere ? `\n- ${describeClassAtmosphere(classAtmosphere)}` : ''
  }
- Never copy anything personal about the real learner (their name, school, background, interests) into a persona: personas are shown to everyone who opens the course.
- Language directive for this course: ${languageDirective}
  Agent names and personas must follow this language directive.
- Each agent must be assigned one avatar from this list: ${JSON.stringify(avatarDescriptions && avatarDescriptions.length > 0 ? avatarDescriptions.map((a) => ({ path: a.path, description: a.desc })) : availableAvatars)}
  - Pick an avatar that visually matches the agent's personality and role
  - Try to use different avatars for each agent
  - Use the "path" value as the avatar field in the output
- Each agent must be assigned one color from this list: ${JSON.stringify(AGENT_COLOR_PALETTE)}
  - Each agent must have a different color
- Each agent needs a "voiceDesign" object describing their VOCAL identity (not personality), written following the language directive and consistent with the persona, as three short comma-free phrases:
  - "identity": gender + age + role (e.g. "middle-aged male teacher")
  - "texture": pitch + vocal quality (e.g. "warm low-pitched slightly husky")
  - "delivery": emotion + pace (e.g. "calm measured encouraging")
${voicePrompt}

Return a JSON object with this exact structure:
{
  "agents": [
    {
      "name": "string",
      "role": "teacher" | "assistant" | "student",
      "persona": "string (3-5 sentences)",
      "voiceDesign": { "identity": "string", "texture": "string", "delivery": "string" },
      "avatar": "string (from available list)",
      "color": "string (hex color from palette)",
      "priority": number (10 for teacher, 7 for assistant, 4-6 for student)${voiceJsonField}
    }
  ]
}`;

  log.info(`Generating agent profiles for "${stageInfo.name}" [model=${modelString}]`);

  // ── Ask, check, and ask once more with what was wrong ──
  const learner =
    learnerLevel || learnerName ? { level: learnerLevel, name: learnerName } : undefined;
  let prompt = userPrompt;
  let refusal: StepRefusal<AgentProfilesRefusal> | undefined;
  let roster: CheckedRoster | undefined;
  // A usable class of the wrong size: the retry for the size is optional
  let kept: CheckedRoster | undefined;
  for (let attempt = 1; attempt <= AGENT_PROFILES_ATTEMPTS; attempt += 1) {
    if (attempt > 1 && ctx.signal?.aborted) break;
    let callSignal = ctx.signal;
    if (kept) {
      // Only while there is time for it: the class in hand must still be returned
      const left = input.deadlineAt === undefined ? undefined : input.deadlineAt - Date.now();
      if (left !== undefined && left < OPTIONAL_RETRY_MIN_MS) break;
      if (left !== undefined) {
        const timeout = AbortSignal.timeout(left - OPTIONAL_RETRY_MARGIN_MS);
        callSignal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;
      }
    }
    let rawResult: string;
    try {
      rawResult = (
        await callLLM(
          {
            model: languageModel,
            abortSignal: callSignal,
            system: systemPrompt,
            prompt,
          },
          'agent-profiles',
          undefined,
          thinkingConfig,
          { serverManaged },
        )
      ).text;
    } catch (error) {
      if (!kept || ctx.signal?.aborted) throw error;
      log.warn(
        `Agent profiles attempt ${attempt} failed (${error instanceof Error ? error.message : String(error)}); keeping the earlier class`,
      );
      break;
    }
    const reading = readRoster(rawResult, {
      agentCount,
      lastAttempt: attempt === AGENT_PROFILES_ATTEMPTS,
      learner,
    });
    for (const warning of reading.warnings) log.warn(`Agent profiles: ${warning}`);
    if (reading.ok) {
      roster = reading.agents;
      break;
    }
    log.warn(`Agent profiles attempt ${attempt} unusable (${reading.reason}): ${reading.message}`);
    if (reading.reason === 'unparseable') {
      log.error('Agent profiles answer:', rawResult.substring(0, 500));
    }
    if (reading.usable) kept = reading.usable;
    refusal = new StepRefusal<AgentProfilesRefusal>(reading.reason, reading.message);
    prompt = `${userPrompt}

Your previous answer could not be used:
${reading.feedback}
Write the whole JSON object again with these fixed.`;
  }
  if (!roster && kept) {
    log.warn(`Agent profiles: kept a class of ${kept.length}, not ${agentCount}`);
    roster = kept;
  }
  if (!roster) {
    throw (
      refusal ??
      new StepRefusal<AgentProfilesRefusal>('unparseable', 'No agent profiles were generated')
    );
  }

  // ── Build output with IDs ──
  const agents = roster.map((agent, index): GeneratedAgentProfile => {
    // The teacher speaks with the user's explicitly selected narrator voice —
    // the LLM must never reassign it. Everyone else resolves only an
    // advertised voice token so provider/model/voice remain bound together.
    let voiceConfig: VoiceBinding | undefined;
    if (agent.role === 'teacher' && narratorBinding) {
      voiceConfig = narratorBinding;
    } else if (agent.voice !== undefined && agent.voice !== null) {
      const advertised =
        typeof agent.voice === 'string'
          ? findAdvertisedVoice(agent.voice, availableVoices)
          : undefined;
      if (advertised) {
        voiceConfig = {
          providerId: advertised.providerId,
          ...(advertised.modelId ? { modelId: advertised.modelId } : {}),
          voiceId: advertised.voiceId,
        };
      } else {
        console.warn(
          '[AgentProfiles] Dropped voice token not present in the advertised list:',
          agent.voice,
        );
      }
    }

    const voiceDesign = normalizeVoiceDesign(agent.voiceDesign);

    return {
      id: `gen-${nanoid(8)}`,
      name: agent.name.trim(),
      role: agent.role,
      persona: agent.persona.trim(),
      avatar:
        (typeof agent.avatar === 'string' && agent.avatar) ||
        availableAvatars[index % availableAvatars.length],
      color:
        (typeof agent.color === 'string' && agent.color) ||
        AGENT_COLOR_PALETTE[index % AGENT_COLOR_PALETTE.length],
      priority:
        typeof agent.priority === 'number'
          ? agent.priority
          : agent.role === 'teacher'
            ? 10
            : agent.role === 'assistant'
              ? 7
              : 5,
      ...(voiceConfig ? { voiceConfig } : {}),
      ...(voiceDesign ? { voiceDesign } : {}),
    };
  });

  log.info(`Successfully generated ${agents.length} agent profiles for "${stageInfo.name}"`);
  return agents;
}
