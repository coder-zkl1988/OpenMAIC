/**
 * The editor's "rewrite as real people" request and answer (I25.2): the
 * course and whole roster as context, bounded like the route; the personas
 * read back in target order, and a refusal or failure told apart.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  buildPersonaUpgradeRequest,
  canUpgradePersonas,
  PERSONA_UPGRADE_LIMITS,
  requestPersonaUpgrade,
} from '@/lib/edit/persona-upgrade';
import { PERSONA_UPGRADE_PATH, type PersonaUpgradeRequest } from '@/lib/types/chat';

const roster = [
  { id: 't', name: 'Ms. Lin', role: 'teacher', persona: 'You are the lead teacher.' },
  { id: 'mia', name: '  ', role: 'student', persona: '' },
];

describe('buildPersonaUpgradeRequest', () => {
  it('sends the course, its outline, the whole roster and the targets', () => {
    expect(
      buildPersonaUpgradeRequest({
        stage: { name: ' Fractions ', description: 'Adding fractions', languageDirective: 'zh-CN' },
        outlines: [{ title: 'Halves', description: 'What a half is' }, { title: ' ' }],
        roster,
        targetAgentIds: ['mia', 'mia', 'nobody'],
      }),
    ).toEqual({
      stage: { name: 'Fractions', description: 'Adding fractions', languageDirective: 'zh-CN' },
      sceneOutlines: [{ title: 'Halves', description: 'What a half is' }],
      agents: [
        { id: 't', name: 'Ms. Lin', role: 'teacher', persona: 'You are the lead teacher.' },
        // An unnamed member goes by its id; an empty persona is fine
        { id: 'mia', name: 'mia', role: 'student', persona: '' },
      ],
      targetAgentIds: ['mia'],
    });
  });

  it("falls back to the pages' titles, and cuts every text to the route's bounds", () => {
    const request = buildPersonaUpgradeRequest({
      stage: { name: '' },
      scenes: [{ title: 'Page one' }, { title: '' }],
      roster: [{ id: 'a', name: 'A', role: 'student', persona: 'x'.repeat(5000) }],
      targetAgentIds: ['a'],
    });
    expect(request.stage.name).toBe('Page one');
    expect(request.sceneOutlines).toEqual([{ title: 'Page one' }]);
    expect(request.agents[0].persona).toHaveLength(PERSONA_UPGRADE_LIMITS.personaMaxChars);
  });

  it('can rewrite 1 to 12 members, each with a role', () => {
    expect(canUpgradePersonas(roster)).toBe(true);
    expect(canUpgradePersonas([])).toBe(false);
    expect(canUpgradePersonas([{ id: 'a', name: 'A', role: '' }])).toBe(false);
    const many = Array.from({ length: 13 }, (_, i) => ({
      id: `s${i}`,
      name: 'S',
      role: 'student',
    }));
    expect(canUpgradePersonas(many)).toBe(false);
  });
});

describe('requestPersonaUpgrade', () => {
  const request: PersonaUpgradeRequest = {
    stage: { name: 'Fractions' },
    agents: roster.map((member) => ({ ...member, name: member.name.trim() || member.id })),
    targetAgentIds: ['mia', 't'],
  };
  const respond = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it('posts the request and reads the personas back in target order', async () => {
    const fetchImpl = respond(200, {
      success: true,
      personas: [
        { id: 't', persona: 'Ms. Lin is calm and warm.' },
        { id: 'mia', persona: ' Mia is a lively joker. ' },
      ],
    });
    await expect(requestPersonaUpgrade(request, { fetchImpl })).resolves.toEqual({
      ok: true,
      personas: [
        { id: 'mia', persona: 'Mia is a lively joker.' },
        { id: 't', persona: 'Ms. Lin is calm and warm.' },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledWith(
      PERSONA_UPGRADE_PATH,
      expect.objectContaining({ method: 'POST', body: JSON.stringify(request) }),
    );
  });

  it('tells a refusal from a failure worth retrying', async () => {
    await expect(
      requestPersonaUpgrade(request, { fetchImpl: respond(400, { errorCode: 'INVALID_REQUEST' }) }),
    ).resolves.toEqual({ ok: false, failure: { kind: 'invalid' } });
    await expect(
      requestPersonaUpgrade(request, {
        fetchImpl: respond(502, { errorCode: 'GENERATION_FAILED', reason: 'persona-too-short' }),
      }),
    ).resolves.toEqual({ ok: false, failure: { kind: 'failed', reason: 'persona-too-short' } });
    await expect(requestPersonaUpgrade(request, { fetchImpl: respond(500, {}) })).resolves.toEqual({
      ok: false,
      failure: { kind: 'failed' },
    });
    // An answer missing a target is no answer
    await expect(
      requestPersonaUpgrade(request, {
        fetchImpl: respond(200, { success: true, personas: [{ id: 't', persona: 'Calm.' }] }),
      }),
    ).resolves.toEqual({ ok: false, failure: { kind: 'failed', reason: 'missing-personas' } });
    const offline = vi.fn(async () => {
      throw new TypeError('offline');
    });
    await expect(requestPersonaUpgrade(request, { fetchImpl: offline })).resolves.toEqual({
      ok: false,
      failure: { kind: 'failed' },
    });
  });

  it('rethrows an abort', async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchImpl = vi.fn(async () => {
      throw new DOMException('Aborted', 'AbortError');
    });
    await expect(
      requestPersonaUpgrade(request, { fetchImpl, signal: controller.signal }),
    ).rejects.toThrow('Aborted');
  });
});
