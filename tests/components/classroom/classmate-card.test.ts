// @vitest-environment jsdom
/**
 * Classmate cards (I24): a participant tile (and a speaker's avatar in the
 * chat) is a button that opens the person's card on a click, a tap or Enter.
 * The card shows who they are — never the level or misconceptions their
 * persona tells the model — and "ask them" addresses the composer (I23).
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key}:${Object.values(options).join('|')}` : key,
  }),
}));
const agents = vi.hoisted(
  () =>
    ({
      teacher: { role: 'teacher', color: '#722ed1', persona: 'Ms. Lin is calm and warm.' },
      mia: {
        role: 'student',
        color: '#047857',
        avatar: '/m.png',
        persona:
          'Mia is a lively joker who blurts out her first guess. She often adds the denominators.',
      },
    }) as Record<string, { role: string; color: string; persona: string; avatar?: string }>,
);
vi.mock('@/lib/orchestration/registry/store', () => ({
  useAgentRegistry: { getState: () => ({ getAgent: (id: string) => agents[id] }) },
}));

import { Participants } from '@/components/classroom/interaction/participants';
import { ClassmateAskContext } from '@/components/classroom/interaction/classmate-card';
import { ChatSessionComponent } from '@/components/chat/chat-session';
import type { Participant } from '@/lib/types/roundtable';
import type { ChatSession } from '@/lib/types/chat';

const roster: Participant[] = [
  { id: 'teacher', name: 'Ms. Lin', role: 'teacher', avatar: '/t.png', isOnline: true },
  { id: 'mia', name: 'Mia', role: 'student', avatar: '/m.png', isOnline: true },
  { id: 'me', name: 'Me', role: 'user', avatar: '/u.png', isOnline: true },
];

describe('classmate cards', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const card = () => document.querySelector('[data-testid="classmate-card"]');
  const trigger = (id: string) =>
    container.querySelector(
      `[data-testid="classmate-card-trigger"][data-agent-id="${id}"]`,
    ) as HTMLButtonElement | null;

  function render(onAsk?: (id: string) => void) {
    act(() =>
      root.render(
        createElement(
          ClassmateAskContext.Provider,
          { value: onAsk ?? null },
          createElement(Participants, { participants: roster }),
        ),
      ),
    );
  }

  it("makes each agent's tile a labelled button; the learner's own tile is not one", () => {
    render();
    const mia = trigger('mia')!;
    expect(mia.tagName).toBe('BUTTON');
    expect(mia.getAttribute('aria-label')).toBe(
      'stage.participants.cardLabel:Mia|settings.agentRoles.student',
    );
    expect(mia.querySelector('[data-participant-id="mia"]')).not.toBeNull();
    expect(trigger('me')).toBeNull();
  });

  it('opens on a click and shows who they are, not what they get wrong', () => {
    render();
    expect(card()).toBeNull();
    act(() => trigger('mia')!.click());
    expect(card()?.textContent).toContain('Mia');
    const intro = document.querySelector('[data-testid="classmate-card-intro"]')!;
    expect(intro.textContent).toBe('Mia is a lively joker who blurts out her first guess.');
    expect(card()?.textContent).not.toContain('denominators');
    // No classroom to address: no "ask them"
    expect(document.querySelector('[data-testid="classmate-card-ask"]')).toBeNull();
  });

  it('addresses the composer with "ask them" and closes', () => {
    const onAsk = vi.fn();
    render(onAsk);
    act(() => trigger('mia')!.click());
    const ask = document.querySelector('[data-testid="classmate-card-ask"]') as HTMLButtonElement;
    expect(ask.textContent).toContain('stage.participants.askThem:Mia');
    act(() => ask.click());
    expect(onAsk).toHaveBeenCalledExactlyOnceWith('mia');
    expect(card()).toBeNull();
  });

  it('opens from a row of the +N list too, so every classmate can be asked', () => {
    const more = ['s2', 's3', 's4', 's5', 's6'].map(
      (id): Participant => ({
        id,
        name: id.toUpperCase(),
        role: 'student',
        avatar: '',
        isOnline: true,
      }),
    );
    agents.s6 = { role: 'student', color: '#000', persona: 'S6 is quiet and careful.' };
    const onAsk = vi.fn();
    act(() =>
      root.render(
        createElement(
          ClassmateAskContext.Provider,
          { value: onAsk },
          createElement(Participants, {
            participants: [...roster.slice(0, 2), ...more, roster[2]!],
          }),
        ),
      ),
    );
    act(() =>
      (
        container.querySelector('[data-testid="participants-overflow"]') as HTMLButtonElement
      ).click(),
    );
    const row = [...document.querySelectorAll('[data-testid="participant-overflow-row"]')].find(
      (node) => node.textContent?.includes('S6'),
    )!;
    const rowTrigger = row.querySelector(
      '[data-testid="classmate-card-trigger"]',
    ) as HTMLButtonElement;
    expect(rowTrigger.tagName).toBe('BUTTON');
    expect(rowTrigger.getAttribute('aria-label')).toBe(
      'stage.participants.cardLabel:S6|settings.agentRoles.student',
    );
    act(() => rowTrigger.click());
    expect(document.querySelector('[data-testid="classmate-card-intro"]')?.textContent).toBe(
      'S6 is quiet and careful.',
    );
    act(() =>
      (document.querySelector('[data-testid="classmate-card-ask"]') as HTMLButtonElement).click(),
    );
    expect(onAsk).toHaveBeenCalledExactlyOnceWith('s6');
    delete agents.s6;
  });

  it("opens from a speaker's avatar in the chat", () => {
    const session: ChatSession = {
      id: 's1',
      type: 'qa',
      title: 'Q&A',
      status: 'active',
      messages: [
        {
          id: 'm1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'I think so!' }],
          metadata: { agentId: 'mia', senderName: 'Mia', senderAvatar: '/m.png' },
        },
      ],
      config: { agentIds: ['mia'] },
      toolCalls: [],
      pendingToolCalls: [],
      createdAt: 1,
      updatedAt: 1,
    };
    act(() => root.render(createElement(ChatSessionComponent, { session, isActive: true })));
    act(() => trigger('mia')!.click());
    expect(document.querySelector('[data-testid="classmate-card-intro"]')?.textContent).toBe(
      'Mia is a lively joker who blurts out her first guess.',
    );
  });
});
