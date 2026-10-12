// @vitest-environment jsdom
/**
 * The roster editor asks before removing or renaming a member the course's
 * script points at: the class moments they open (by id) and the lines that
 * say their name. A removed classmate's moments go to the lead teacher or
 * with them (never left for the engine to skip silently); a cancelled rename
 * puts the old name back.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GeneratedAgentConfig } from '@/lib/types/stage';

const mocks = vi.hoisted(() => {
  const roster: GeneratedAgentConfig[] = [
    {
      id: 't',
      name: 'Ms. Lin',
      role: 'teacher',
      persona: 'Patient.',
      avatar: '/t.png',
      color: '#000',
      priority: 10,
    },
    {
      id: 'mia',
      name: 'Mia',
      role: 'student',
      persona: 'Curious.',
      avatar: '/m.png',
      color: '#f59e0b',
      priority: 5,
    },
    {
      id: 'leo',
      name: 'Leo',
      role: 'student',
      persona: 'Quiet.',
      avatar: '/l.png',
      color: '#10b981',
      priority: 5,
    },
  ];
  return {
    roster,
    setStageAgents: vi.fn(),
    updateScene: vi.fn(),
    toastInfo: vi.fn(),
    scenes: [] as Array<{ id: string; actions?: unknown[] }>,
  };
});

vi.mock('sonner', () => ({ toast: { info: mocks.toastInfo } }));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${JSON.stringify(options)}` : key,
  }),
}));
vi.mock('@/lib/store/stage', () => ({
  useStageStore: Object.assign(() => undefined, {
    use: { setStageAgents: () => mocks.setStageAgents },
    getState: () => ({
      stage: { id: 'stage-1', generatedAgentConfigs: mocks.roster },
      scenes: mocks.scenes,
      updateScene: mocks.updateScene,
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

describe('AgentRosterPanel: script references', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.setStageAgents.mockReset();
    mocks.updateScene.mockReset();
    mocks.toastInfo.mockReset();
    mocks.scenes = [
      {
        id: 's1',
        actions: [
          { id: 'a1', type: 'speech', text: 'Mia asked a great question yesterday.' },
          { id: 'a2', type: 'discussion', topic: 'Wait, why does it float?', agentId: 'mia' },
        ],
      },
      { id: 's2', actions: [{ id: 'b1', type: 'speech', text: 'Ms. Lin explains density.' }] },
    ];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(createElement(AgentRosterPanel)));
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const byTestId = (id: string) => container.querySelector(`[data-testid="${id}"]`) as HTMLElement;
  const cards = () => [...container.querySelectorAll('[data-testid="agent-roster-card"]')];
  const cardOf = (name: string) =>
    cards().find(
      (card) => card.querySelector('[data-testid="agent-roster-name"]')?.textContent === name,
    )!;
  const openCard = (name: string) =>
    act(() => (cardOf(name).querySelector('[role="button"]') as HTMLElement).click());
  const lastRoster = () => mocks.setStageAgents.mock.calls.at(-1)?.[0] as GeneratedAgentConfig[];

  function rename(name: string, next: string) {
    const editable = cardOf(name).querySelector('[data-testid="agent-roster-name"]') as HTMLElement;
    act(() => {
      editable.focus();
      editable.textContent = next;
      editable.dispatchEvent(new Event('input', { bubbles: true }));
      editable.blur();
    });
  }

  it('removes a member the script never mentions without asking', () => {
    openCard('Leo');
    act(() => byTestId('agent-roster-remove').click());
    expect(byTestId('agent-roster-impact')).toBeNull();
    expect(lastRoster().map((a) => a.id)).toEqual(['t', 'mia']);
    expect(mocks.updateScene).not.toHaveBeenCalled();
  });

  it('asks before removing a classmate who opens moments, then hands them to the teacher', () => {
    openCard('Mia');
    act(() => byTestId('agent-roster-remove').click());
    const impact = byTestId('agent-roster-impact');
    expect(impact.textContent).toContain('edit.roster.impact.moments:{"name":"Mia","count":1}');
    expect(impact.textContent).toContain('edit.roster.impact.mentions:{"name":"Mia","count":1}');
    expect(mocks.setStageAgents).not.toHaveBeenCalled();

    act(() => byTestId('agent-roster-remove-reassign').click());
    expect(mocks.updateScene).toHaveBeenCalledExactlyOnceWith('s1', {
      actions: [
        { id: 'a1', type: 'speech', text: 'Mia asked a great question yesterday.' },
        { id: 'a2', type: 'discussion', topic: 'Wait, why does it float?', agentId: 't' },
      ],
    });
    expect(lastRoster().map((a) => a.id)).toEqual(['t', 'leo']);
  });

  it('brings the classmate and their moments back with one undo, and redo removes both again', () => {
    const original = mocks.scenes[0].actions;
    openCard('Mia');
    act(() => byTestId('agent-roster-remove').click());
    act(() => byTestId('agent-roster-remove-reassign').click());
    expect(mocks.updateScene).toHaveBeenCalledTimes(1);
    const reassigned = mocks.updateScene.mock.calls[0][1];

    const undo = container.querySelector('button[aria-label="edit.undo"]') as HTMLElement;
    const redo = container.querySelector('button[aria-label="edit.redo"]') as HTMLElement;
    act(() => undo.click());
    expect(mocks.updateScene).toHaveBeenLastCalledWith('s1', { actions: original });
    expect(lastRoster().map((a) => a.id)).toEqual(['t', 'mia', 'leo']);

    act(() => redo.click());
    expect(mocks.updateScene).toHaveBeenLastCalledWith('s1', reassigned);
    expect(lastRoster().map((a) => a.id)).toEqual(['t', 'leo']);
    expect(mocks.updateScene).toHaveBeenCalledTimes(3);
  });

  it('can remove the moments with the classmate, or cancel and keep everything', () => {
    openCard('Mia');
    act(() => byTestId('agent-roster-remove').click());
    act(() => byTestId('agent-roster-impact-cancel').click());
    expect(byTestId('agent-roster-impact')).toBeNull();
    expect(mocks.setStageAgents).not.toHaveBeenCalled();

    act(() => byTestId('agent-roster-remove').click());
    act(() => byTestId('agent-roster-remove-drop').click());
    expect(mocks.updateScene).toHaveBeenCalledExactlyOnceWith('s1', {
      actions: [{ id: 'a1', type: 'speech', text: 'Mia asked a great question yesterday.' }],
    });
    expect(lastRoster().map((a) => a.id)).toEqual(['t', 'leo']);
  });

  it('asks before renaming someone the lines still name, and restores the name on cancel', () => {
    rename('Mia', 'Mira');
    const impact = byTestId('agent-roster-impact');
    expect(impact.textContent).toContain(
      'edit.roster.impact.renameMentions:{"name":"Mia","count":1}',
    );
    expect(mocks.setStageAgents).not.toHaveBeenCalled();

    act(() => byTestId('agent-roster-impact-cancel').click());
    expect(cardOf('Mia')).toBeDefined();
    expect(mocks.setStageAgents).not.toHaveBeenCalled();

    rename('Mia', 'Mira');
    act(() => byTestId('agent-roster-rename-confirm').click());
    expect(lastRoster().find((a) => a.id === 'mia')?.name).toBe('Mira');
  });

  it("renames the teacher (and anyone the lines don't name) at once when nothing says the old name", () => {
    rename('Leo', 'Leon');
    expect(byTestId('agent-roster-impact')).toBeNull();
    expect(lastRoster().find((a) => a.id === 'leo')?.name).toBe('Leon');

    rename('Ms. Lin', 'Mrs. Lin');
    expect(byTestId('agent-roster-impact')?.textContent).toContain(
      'edit.roster.impact.renameMentions:{"name":"Ms. Lin","count":1}',
    );
  });

  it('is announced as an alert dialog, with the focus on its first action and back on cancel', () => {
    openCard('Mia');
    const remove = byTestId('agent-roster-remove');
    act(() => remove.click());
    const impact = byTestId('agent-roster-impact');
    expect(impact.getAttribute('role')).toBe('alertdialog');
    const title = document.getElementById(impact.getAttribute('aria-labelledby')!);
    expect(title?.textContent).toBe('edit.roster.impact.title');
    const description = document.getElementById(impact.getAttribute('aria-describedby')!);
    expect(description?.textContent).toContain('edit.roster.impact.moments');
    expect(document.activeElement).toBe(byTestId('agent-roster-impact-cancel'));

    act(() => byTestId('agent-roster-impact-cancel').click());
    expect(document.activeElement).toBe(byTestId('agent-roster-remove'));
  });

  it('marks a rename waiting for confirmation as not saved, and refocuses the name on cancel', () => {
    rename('Mia', 'Mira');
    const field = cardOf('Mira').querySelector('[data-testid="agent-roster-name"]') as HTMLElement;
    expect(field.getAttribute('data-pending')).toBe('true');
    expect(field.getAttribute('aria-describedby')).toBe(
      byTestId('agent-roster-impact').getAttribute('aria-describedby'),
    );

    act(() => byTestId('agent-roster-impact-cancel').click());
    const restored = cardOf('Mia').querySelector('[data-testid="agent-roster-name"]');
    expect(restored?.getAttribute('data-pending')).toBeNull();
    expect(document.activeElement).toBe(restored);
  });

  it('keeps a rename still waiting for confirmation when the dialog closes, and says what it means', () => {
    const flushRef = { current: null as AgentRosterPanelHandle | null };
    act(() => root.render(createElement(AgentRosterPanel, { flushRef } as never)));
    rename('Mia', 'Mira');
    expect(byTestId('agent-roster-impact')).not.toBeNull();

    act(() => flushRef.current?.flushDrafts());
    expect(lastRoster().find((a) => a.id === 'mia')?.name).toBe('Mira');
    expect(mocks.toastInfo).toHaveBeenCalledExactlyOnceWith(
      'edit.roster.impact.renameMentions:{"name":"Mia","count":1}',
    );
  });
});
