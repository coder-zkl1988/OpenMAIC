// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options?.count !== undefined ? `${key}:${options.count}` : key,
  }),
}));
const agents = vi.hoisted(
  () =>
    ({
      teacher: { role: 'teacher', color: '#722ed1', persona: 'Teaches' },
      assistant: { role: 'assistant', color: '#047857', persona: 'Helps' },
    }) as Record<string, { role: string; color: string; persona: string }>,
);
vi.mock('@/lib/orchestration/registry/store', () => ({
  useAgentRegistry: { getState: () => ({ getAgent: (id: string) => agents[id] }) },
}));

import {
  Participants,
  layoutParticipantGrid,
  resolveParticipantStatus,
  resolveSpeakingParticipantId,
} from '@/components/classroom/interaction/participants';
import type { Participant } from '@/lib/types/roundtable';
import type { PlaybackView } from '@/lib/playback';

function person(id: string, role: Participant['role']): Participant {
  return { id, name: id, role, avatar: `/avatars/${id}.png`, isOnline: true };
}

const teacher = person('teacher', 'teacher');
const assistant = person('assistant', 'student');
const student = person('student-1', 'student');
const user = person('user-1', 'user');
const roster = [teacher, assistant, student, user];

function view(
  phase: PlaybackView['phase'],
  activeRole: PlaybackView['activeRole'],
): Pick<PlaybackView, 'phase' | 'activeRole'> {
  return { phase, activeRole };
}

describe('participant status mapping', () => {
  it('marks the lecturing teacher, or the agent answering live, as speaking', () => {
    const base = { participants: roster };
    expect(
      resolveSpeakingParticipantId({ ...base, playbackView: view('lecturePlaying', 'teacher') }),
    ).toBe('teacher');
    expect(
      resolveSpeakingParticipantId({
        ...base,
        playbackView: view('discussionActive', 'agent'),
        speakingAgentId: 'student-1',
      }),
    ).toBe('student-1');
    // A Q&A answer names its own teacher agent
    expect(
      resolveSpeakingParticipantId({
        ...base,
        playbackView: view('discussionActive', 'teacher'),
        speakingAgentId: 'teacher',
      }),
    ).toBe('teacher');
  });

  it('marks nobody while paused, waiting for the learner or idle', () => {
    const base = { participants: roster, speakingAgentId: 'student-1' };
    for (const phase of ['lecturePaused', 'cueUser', 'idle', 'completed'] as const) {
      expect(
        resolveSpeakingParticipantId({ ...base, playbackView: view(phase, 'teacher') }),
      ).toBeNull();
    }
    expect(
      resolveSpeakingParticipantId({
        ...base,
        playbackView: view('discussionActive', 'agent'),
        isLivePaused: true,
      }),
    ).toBeNull();
  });

  it('ranks speaking over 想发言 over the learner’s raised hand over the role', () => {
    const context = { speakingId: 'teacher', discussionAgentId: 'student-1', userHandRaised: true };
    expect(resolveParticipantStatus(teacher, context)).toBe('speaking');
    expect(resolveParticipantStatus(student, context)).toBe('wantsToSpeak');
    expect(resolveParticipantStatus(user, context)).toBe('handRaised');
    expect(resolveParticipantStatus(assistant, context)).toBe('role');
    expect(resolveParticipantStatus(user, { ...context, userHandRaised: false })).toBe('role');
    // Speaking wins even for the agent that also offered a discussion
    expect(resolveParticipantStatus(student, { ...context, speakingId: 'student-1' })).toBe(
      'speaking',
    );
  });

  it('fits five tiles; past that keeps the learner and folds the rest into +N', () => {
    expect(layoutParticipantGrid(roster).overflow).toEqual([]);
    const many = [
      teacher,
      assistant,
      student,
      person('s2', 'student'),
      person('s3', 'student'),
      user,
    ];
    const { visible, overflow } = layoutParticipantGrid(many);
    expect(visible.map((p) => p.id)).toEqual(['teacher', 'assistant', 'student-1', 'user-1']);
    expect(overflow.map((p) => p.id)).toEqual(['s2', 's3']);
  });
});

describe('Participants block', () => {
  let container: HTMLDivElement;
  let root: Root;
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function render(props: Record<string, unknown>) {
    act(() =>
      root.render(createElement(Participants, { participants: roster, ...props } as never)),
    );
  }

  const tile = (id: string) =>
    container.querySelector(`[data-testid="participant-tile"][data-participant-id="${id}"]`);

  it('counts who is online and labels each tile with its status or role', () => {
    render({
      playbackView: view('lecturePlaying', 'teacher'),
      discussionAgentId: 'student-1',
      userHandRaised: true,
    });
    expect(container.textContent).toContain('stage.participants.online:4');
    expect(tile('teacher')?.getAttribute('data-status')).toBe('speaking');
    expect(tile('teacher')?.textContent).toContain('stage.participants.speaking');
    expect(tile('student-1')?.textContent).toContain('stage.participants.wantsToSpeak');
    expect(tile('user-1')?.textContent).toContain('stage.participants.handRaised');
    // The registry's role wins over the participant role (助教, not 学生)
    expect(tile('assistant')?.textContent).toContain('settings.agentRoles.assistant');
  });

  it('keeps the learner last and spins the agent being prepared', () => {
    render({ thinkingState: { stage: 'agent_loading', agentId: 'student-1' } });
    const ids = [...container.querySelectorAll('[data-testid="participant-tile"]')].map((node) =>
      node.getAttribute('data-participant-id'),
    );
    expect(ids.at(-1)).toBe('user-1');
    expect(tile('student-1')?.querySelector('[data-testid="participant-loading"]')).not.toBeNull();
    expect(tile('teacher')?.querySelector('[data-testid="participant-loading"]')).toBeNull();
    expect(tile('user-1')?.textContent).toContain('settings.agentRoles.student');
  });

  it('folds overflowing agents into a +N tile', () => {
    render({
      participants: [
        teacher,
        assistant,
        student,
        person('s2', 'student'),
        person('s3', 'student'),
        user,
      ],
    });
    const more = container.querySelector('[data-testid="participants-overflow"]')!;
    expect(more.textContent).toBe('+2');
    expect(more.getAttribute('aria-label')).toBe('stage.participants.more:2');
    expect(container.querySelectorAll('[data-testid="participant-tile"]')).toHaveLength(4);
  });
});
