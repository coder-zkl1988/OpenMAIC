/**
 * The editor's "rewrite as real people" (I25.2), client side: the request
 * for PERSONA_UPGRADE_PATH, built from the course and the roster as the
 * editor holds it, and the route's answer read into rewritten personas or a
 * failure the panel can offer to retry. Nothing is applied here: the panel
 * previews each change and applies only `persona`, as one roster edit the
 * learner can undo.
 */

import {
  PERSONA_UPGRADE_PATH,
  type PersonaUpgradeRequest,
  type PersonaUpgradeResponse,
} from '@/lib/types/chat';

/** The route's bounds the request keeps to (characters, code points) */
export const PERSONA_UPGRADE_LIMITS = {
  agentsMax: 12,
  stageNameMaxChars: 200,
  stageDescriptionMaxChars: 1000,
  languageDirectiveMaxChars: 1000,
  sceneOutlinesMax: 40,
  outlineTitleMaxChars: 160,
  outlineDescriptionMaxChars: 400,
  personaMaxChars: 4000,
} as const;

/** One member of the roster, as the editor holds it */
export interface UpgradeRosterMember {
  id: string;
  name: string;
  role: string;
  persona?: string;
}

/** Why a rewrite did not come back: the request was refused, or the writing failed */
export type PersonaUpgradeFailure = { kind: 'invalid' } | { kind: 'failed'; reason?: string };

export type PersonaUpgradeResult =
  | { ok: true; personas: Array<{ id: string; persona: string }> }
  | { ok: false; failure: PersonaUpgradeFailure };

function cut(text: string | undefined, max: number): string {
  const trimmed = (text ?? '').trim();
  const chars = Array.from(trimmed);
  return chars.length <= max ? trimmed : chars.slice(0, max).join('').trimEnd();
}

/** Whether the route can take this roster: 1 to 12 members, each with a role */
export function canUpgradePersonas(roster: readonly UpgradeRosterMember[]): boolean {
  return (
    roster.length > 0 &&
    roster.length <= PERSONA_UPGRADE_LIMITS.agentsMax &&
    roster.every((member) => !!member.role?.trim())
  );
}

/**
 * The request: the course (its name, description and language, and its
 * outline — or its pages' titles when no outline was kept), the whole
 * roster as context (an empty persona is fine) and whose persona to
 * rewrite. Every text is trimmed and cut to the route's bound; a member
 * without a name goes by its id.
 */
export function buildPersonaUpgradeRequest({
  stage,
  outlines,
  scenes,
  roster,
  targetAgentIds,
}: {
  stage: { name?: string; description?: string; languageDirective?: string } | null | undefined;
  outlines?: ReadonlyArray<{ title?: string; description?: string }>;
  scenes?: ReadonlyArray<{ title?: string }>;
  roster: readonly UpgradeRosterMember[];
  targetAgentIds: readonly string[];
}): PersonaUpgradeRequest {
  const L = PERSONA_UPGRADE_LIMITS;
  const fromOutlines = (outlines ?? []).flatMap((outline) => {
    const title = cut(outline.title, L.outlineTitleMaxChars);
    if (!title) return [];
    const description = cut(outline.description, L.outlineDescriptionMaxChars);
    return [{ title, ...(description ? { description } : {}) }];
  });
  const sceneOutlines = (
    fromOutlines.length > 0
      ? fromOutlines
      : (scenes ?? []).flatMap((scene) => {
          const title = cut(scene.title, L.outlineTitleMaxChars);
          return title ? [{ title }] : [];
        })
  ).slice(0, L.sceneOutlinesMax);
  const name =
    cut(stage?.name, L.stageNameMaxChars) || sceneOutlines[0]?.title || 'Untitled course';
  const description = cut(stage?.description, L.stageDescriptionMaxChars);
  const languageDirective = cut(stage?.languageDirective, L.languageDirectiveMaxChars);
  const ids = new Set(roster.map((member) => member.id));
  return {
    stage: {
      name,
      ...(description ? { description } : {}),
      ...(languageDirective ? { languageDirective } : {}),
    },
    ...(sceneOutlines.length > 0 ? { sceneOutlines } : {}),
    agents: roster.slice(0, L.agentsMax).map((member) => ({
      id: member.id,
      name: member.name.trim() || member.id,
      role: member.role,
      persona: cut(member.persona, L.personaMaxChars),
    })),
    targetAgentIds: [...new Set(targetAgentIds)].filter((id) => ids.has(id)),
  };
}

/**
 * POST the request and read the answer: the personas in target order
 * (every target must have a non-empty one), a refusal (400) or a failure
 * worth retrying (502 with the route's reason, any other status, or the
 * network). An abort is rethrown.
 */
export async function requestPersonaUpgrade(
  request: PersonaUpgradeRequest,
  { signal, fetchImpl = fetch }: { signal?: AbortSignal; fetchImpl?: typeof fetch } = {},
): Promise<PersonaUpgradeResult> {
  let response: Response;
  try {
    response = await fetchImpl(PERSONA_UPGRADE_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { ok: false, failure: { kind: 'failed' } };
  }
  const body = (await response.json().catch(() => null)) as
    | (Partial<PersonaUpgradeResponse> & { reason?: string })
    | null;
  if (response.status === 400) return { ok: false, failure: { kind: 'invalid' } };
  if (!response.ok) {
    return {
      ok: false,
      failure: { kind: 'failed', ...(body?.reason ? { reason: body.reason } : {}) },
    };
  }
  const answered = new Map(
    (Array.isArray(body?.personas) ? body.personas : []).flatMap((entry) =>
      entry && typeof entry.id === 'string' && typeof entry.persona === 'string'
        ? [[entry.id, entry.persona.trim()] as const]
        : [],
    ),
  );
  const personas = request.targetAgentIds.map((id) => ({ id, persona: answered.get(id) ?? '' }));
  if (personas.some((entry) => !entry.persona)) {
    return { ok: false, failure: { kind: 'failed', reason: 'missing-personas' } };
  }
  return { ok: true, personas };
}
