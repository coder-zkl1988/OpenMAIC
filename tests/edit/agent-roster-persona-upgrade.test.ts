// @vitest-environment jsdom
/**
 * "Rewrite as real people" in the roster editor (I25.2): the roster goes to
 * the persona upgrade, each member's new persona is previewed before
 * anything changes, Apply writes only the checked personas as one roster
 * edit (undo takes it back), and a failed rewrite offers a retry. Closing
 * the dialog keeps a rename the script still says, and tells what it means.
 */
import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeneratedAgentConfig } from '@/lib/types/stage';

const mocks = vi.hoisted(() => {
  const roster: GeneratedAgentConfig[] = [
    {
      id: 't',
      name: 'Ms. Lin',
      role: 'teacher',
      persona: 'Responsible for explaining.',
      avatar: '/t.png',
      color: '#000',
      priority: 10,
    },
    {
      id: 'mia',
      name: 'Mia',
      role: 'student',
      persona: '',
      avatar: '/m.png',
      color: '#f59e0b',
      priority: 5,
    },
  ];
  return {
    roster,
    setStageAgents: vi.fn(),
    toastInfo: vi.fn(),
    scenes: [] as Array<{ id: string; title?: string; actions?: unknown[] }>,
  };
});

vi.mock('sonner', () => ({ toast: { info: mocks.toastInfo } }));

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/store/stage', () => ({
  useStageStore: Object.assign(() => undefined, {
    use: { setStageAgents: () => mocks.setStageAgents },
    getState: () => ({
      stage: { id: 'stage-1', name: 'Fractions', generatedAgentConfigs: mocks.roster },
      outlines: [{ title: 'Halves', description: 'What a half is' }],
      scenes: mocks.scenes,
      updateScene: vi.fn(),
    }),
  }),
}));
vi.mock('@/lib/orchestration/registry/store', () => ({
  useAgentRegistry: { getState: () => ({ getAgent: () => undefined }) },
}));

import {
  AgentRosterPanel,
  type AgentRosterPanelHandle,
} from '@/components/edit/AgentsView/AgentRosterPanel';
import { PERSONA_UPGRADE_PATH } from '@/lib/types/chat';

const PERSONAS = [
  { id: 't', persona: 'Ms. Lin is calm and warm; she gets the class guessing first.' },
  { id: 'mia', persona: 'Mia is a lively joker who blurts out her first guess.' },
];

describe('AgentRosterPanel: rewrite as real people', () => {
  let container: HTMLDivElement;
  let root: Root;
  let responses: Array<{ status: number; body: unknown }>;
  let requests: Array<{ url: string; body: Record<string, unknown> }>;
  const panelRef = createRef<AgentRosterPanelHandle>();

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.setStageAgents.mockReset();
    mocks.scenes = [];
    requests = [];
    responses = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        requests.push({ url, body: JSON.parse(String(init.body)) });
        const next = responses.shift() ?? {
          status: 200,
          body: { success: true, personas: PERSONAS },
        };
        return new Response(JSON.stringify(next.body), { status: next.status });
      }),
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(createElement(AgentRosterPanel, { flushRef: panelRef } as never)));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement;
  const lastRoster = () => mocks.setStageAgents.mock.calls.at(-1)?.[0] as GeneratedAgentConfig[];
  const settle = () =>
    act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

  async function startUpgrade() {
    act(() => byTestId('agent-roster-upgrade').click());
    expect(byTestId('persona-upgrade').getAttribute('data-state')).toBe('loading');
    await settle();
  }

  it('previews every new persona, then applies only the checked ones as one undoable edit', async () => {
    await startUpgrade();
    expect(requests[0].url).toBe(PERSONA_UPGRADE_PATH);
    expect(requests[0].body).toMatchObject({
      stage: { name: 'Fractions' },
      sceneOutlines: [{ title: 'Halves', description: 'What a half is' }],
      agents: [
        { id: 't', name: 'Ms. Lin', role: 'teacher', persona: 'Responsible for explaining.' },
        { id: 'mia', name: 'Mia', role: 'student', persona: '' },
      ],
      targetAgentIds: ['t', 'mia'],
    });

    const panel = byTestId('persona-upgrade');
    expect(panel.getAttribute('data-state')).toBe('preview');
    const rows = [...panel.querySelectorAll('[data-testid="persona-upgrade-row"]')];
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('Responsible for explaining.'),
      // An empty persona shows as such
      expect.stringContaining('edit.roster.noPersona'),
    ]);
    expect(
      [...panel.querySelectorAll('[data-testid="persona-upgrade-after"]')].map(
        (p) => p.textContent,
      ),
    ).toEqual(PERSONAS.map((p) => p.persona));
    // Nothing changes before Apply
    expect(mocks.setStageAgents).not.toHaveBeenCalled();

    // Keep the teacher as written
    act(() => (rows[0].querySelector('[role="checkbox"]') as HTMLElement).click());
    act(() => byTestId('persona-upgrade-apply').click());
    expect(byTestId('persona-upgrade')).toBeNull();
    expect(lastRoster().map((a) => [a.id, a.name, a.persona, a.avatar])).toEqual([
      ['t', 'Ms. Lin', 'Responsible for explaining.', '/t.png'],
      ['mia', 'Mia', PERSONAS[1].persona, '/m.png'],
    ]);

    // One undo takes the whole rewrite back
    act(() => (container.querySelector('button[aria-label="edit.undo"]') as HTMLElement).click());
    expect(lastRoster().map((a) => a.persona)).toEqual(['Responsible for explaining.', '']);
  });

  it('offers a retry when the rewrite fails, and changes nothing on cancel', async () => {
    responses.push({
      status: 502,
      body: { success: false, errorCode: 'GENERATION_FAILED', reason: 'persona-too-short' },
    });
    await startUpgrade();
    expect(byTestId('persona-upgrade').getAttribute('data-state')).toBe('error');
    expect(byTestId('persona-upgrade').textContent).toContain('edit.roster.upgrade.failed');

    act(() => byTestId('persona-upgrade-retry').click());
    await settle();
    expect(requests).toHaveLength(2);
    expect(byTestId('persona-upgrade').getAttribute('data-state')).toBe('preview');

    const cancel = [...byTestId('persona-upgrade').querySelectorAll('button')].find(
      (button) => button.textContent === 'common.cancel',
    )!;
    act(() => cancel.click());
    expect(byTestId('persona-upgrade')).toBeNull();
    expect(byTestId('agent-roster-add')).not.toBeNull();
    expect(mocks.setStageAgents).not.toHaveBeenCalled();
  });

  it('says a refused roster cannot be rewritten (no retry)', async () => {
    responses.push({ status: 400, body: { success: false, errorCode: 'INVALID_REQUEST' } });
    await startUpgrade();
    expect(byTestId('persona-upgrade').textContent).toContain('edit.roster.upgrade.invalid');
    expect(byTestId('persona-upgrade-retry')).toBeNull();
  });

  it('keeps, on close, a rename the script still says, and tells that the lines keep the old name', () => {
    mocks.scenes = [{ id: 's1', actions: [{ id: 'a1', type: 'speech', text: 'Mia, look here.' }] }];
    const name = [...container.querySelectorAll('[data-testid="agent-roster-name"]')].find(
      (node) => node.textContent === 'Mia',
    ) as HTMLElement;
    act(() => {
      name.focus();
      name.textContent = 'Mira';
      name.dispatchEvent(new Event('input', { bubbles: true }));
    });
    act(() => panelRef.current!.flushDrafts());
    const saved = mocks.setStageAgents.mock.calls.at(-1)?.[0] as GeneratedAgentConfig[];
    expect(saved.find((agent) => agent.id === 'mia')?.name).toBe('Mira');
    expect(mocks.toastInfo).toHaveBeenCalledExactlyOnceWith('edit.roster.impact.renameMentions');
  });
});
