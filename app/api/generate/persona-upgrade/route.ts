/**
 * POST /api/generate/persona-upgrade (`PERSONA_UPGRADE_PATH`)
 *
 * Rewrite chosen agents' personas as real people, for the editor's opt-in
 * roster upgrade. Stateless: the client sends the roster and applies the
 * returned personas itself, as a roster edit it can undo. Ids, names, roles,
 * avatars, colors and voices never change. The logic is the persona upgrade
 * step (lib/server/generation/steps/persona-upgrade.ts).
 */
import type { NextRequest } from 'next/server';

import { createLogger } from '@/lib/logger';
import { apiError, apiSuccess } from '@/lib/server/api-response';
import { StepRefusal } from '@/lib/server/generation/steps/context';
import {
  parsePersonaUpgradeRequest,
  upgradePersonas,
} from '@/lib/server/generation/steps/persona-upgrade';
import { resolveModelFromRequest } from '@/lib/server/resolve-model';
import type { PersonaUpgradeResponse } from '@/lib/types/chat';

const log = createLogger('Persona Upgrade API');

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return apiError('INVALID_REQUEST', 400, 'Request body must be valid JSON.');
  }
  const parsed = parsePersonaUpgradeRequest(body);
  if (!parsed.ok) return apiError('INVALID_REQUEST', 400, parsed.message);

  let model;
  try {
    // The client sends no model headers: the agent-profiles stage's model writes personas.
    model = await resolveModelFromRequest(req, body, 'agent-profiles');
  } catch (error) {
    log.error('Model resolution failed:', error);
    return apiError('INVALID_REQUEST', 400, error instanceof Error ? error.message : String(error));
  }

  try {
    const personas = await upgradePersonas(
      { ...parsed.request, model },
      { log, signal: req.signal },
    );
    return apiSuccess({ personas } satisfies Omit<PersonaUpgradeResponse, 'success'>);
  } catch (error) {
    if (error instanceof StepRefusal) {
      return apiError('GENERATION_FAILED', 502, error.message, undefined, error.reason);
    }
    log.error(`Persona upgrade failed for "${parsed.request.stage.name}":`, error);
    return apiError('INTERNAL_ERROR', 500, 'Failed to rewrite the personas');
  }
}
