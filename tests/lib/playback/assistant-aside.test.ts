import { describe, expect, it } from 'vitest';
import {
  pickAssistantAgent,
  resolveAsideAgent,
  shouldAssistantAnswer,
  type AssistantRouteInput,
} from '@/lib/playback/assistant-aside';

const playing: AssistantRouteInput = {
  enabled: true,
  assistantAgentId: 'default-2',
  asideOpen: false,
  engineMode: 'playing',
  liveSessionOpen: false,
  teacherHandPending: false,
  pausedForVoice: false,
};

describe('pickAssistantAgent', () => {
  it('picks the selected agent with the assistant role', () => {
    expect(
      pickAssistantAgent([
        { id: 'default-1', role: 'teacher', priority: 10 },
        { id: 'default-2', role: 'assistant', priority: 7 },
        { id: 'default-3', role: 'student', priority: 4 },
      ])?.id,
    ).toBe('default-2');
  });

  it('prefers the highest priority assistant and skips unknown agents', () => {
    expect(
      pickAssistantAgent([
        undefined,
        { id: 'ta-low', role: 'assistant', priority: 3 },
        null,
        { id: 'ta-high', role: 'assistant', priority: 8 },
      ])?.id,
    ).toBe('ta-high');
  });

  it('finds no assistant in a classroom without one (no default added)', () => {
    expect(
      pickAssistantAgent([
        { id: 'default-1', role: 'teacher', priority: 10 },
        { id: 'default-3', role: 'student', priority: 4 },
      ]),
    ).toBeNull();
    expect(pickAssistantAgent([])).toBeNull();
  });
});

describe('shouldAssistantAnswer', () => {
  it('routes a question asked while the lecture plays to the assistant', () => {
    expect(shouldAssistantAnswer(playing)).toBe(true);
  });

  it("keeps today's teacher flow with the setting off or without an assistant", () => {
    expect(shouldAssistantAnswer({ ...playing, enabled: false })).toBe(false);
    expect(shouldAssistantAnswer({ ...playing, assistantAgentId: null })).toBe(false);
    // Even an open aside does not override either
    expect(shouldAssistantAnswer({ ...playing, enabled: false, asideOpen: true })).toBe(false);
    expect(shouldAssistantAnswer({ ...playing, assistantAgentId: null, asideOpen: true })).toBe(
      false,
    );
  });

  it('leaves a paused, idle or live lecture to the teacher', () => {
    for (const engineMode of ['paused', 'idle', 'live', null] as const) {
      expect(shouldAssistantAnswer({ ...playing, engineMode })).toBe(false);
    }
  });

  it('leaves an open Q&A / discussion, or a hand already waiting for the teacher, to the teacher', () => {
    expect(shouldAssistantAnswer({ ...playing, liveSessionOpen: true })).toBe(false);
    expect(shouldAssistantAnswer({ ...playing, teacherHandPending: true })).toBe(false);
  });

  it('sends follow-ups to the open aside, even after the lecture paused', () => {
    for (const engineMode of ['playing', 'paused', 'idle'] as const) {
      expect(shouldAssistantAnswer({ ...playing, engineMode, asideOpen: true })).toBe(true);
    }
  });

  it('gives a question naming someone else (@) to the teacher, even with an aside open', () => {
    expect(shouldAssistantAnswer({ ...playing, addressesOthers: true })).toBe(false);
    expect(shouldAssistantAnswer({ ...playing, addressesOthers: true, asideOpen: true })).toBe(
      false,
    );
    // Naming only the assistant keeps the aside
    expect(shouldAssistantAnswer({ ...playing, addressesOthers: false })).toBe(true);
  });

  it('leaves fullscreen questions to the teacher: the aside could not be seen there', () => {
    expect(shouldAssistantAnswer({ ...playing, presenting: true })).toBe(false);
    expect(shouldAssistantAnswer({ ...playing, presenting: true, asideOpen: true })).toBe(false);
    expect(shouldAssistantAnswer({ ...playing, presenting: false })).toBe(true);
  });

  it('treats a lecture paused only for a voice question to the assistant as playing', () => {
    expect(shouldAssistantAnswer({ ...playing, engineMode: 'paused', pausedForVoice: true })).toBe(
      true,
    );
    expect(shouldAssistantAnswer({ ...playing, engineMode: 'idle', pausedForVoice: true })).toBe(
      false,
    );
  });
});

describe('resolveAsideAgent', () => {
  const classmate = { id: 'default-3', role: 'student' };
  const ta = { id: 'default-2', role: 'assistant' };
  const teacherAgent = { id: 'default-1', role: 'teacher' };

  it('lets a classmate named during the lecture answer on the side, not as a raised hand', () => {
    expect(resolveAsideAgent({ ...playing, addressed: [classmate] })).toBe('default-3');
    // The learner chose them: even with the assistant setting off or no assistant
    expect(resolveAsideAgent({ ...playing, enabled: false, addressed: [classmate] })).toBe(
      'default-3',
    );
    expect(resolveAsideAgent({ ...playing, assistantAgentId: null, addressed: [classmate] })).toBe(
      'default-3',
    );
    // The first one named answers
    expect(resolveAsideAgent({ ...playing, addressed: [classmate, ta] })).toBe('default-3');
  });

  it('keeps the teacher flow for the teacher, fullscreen, an open Q&A or a waiting hand', () => {
    expect(resolveAsideAgent({ ...playing, addressed: [teacherAgent] })).toBeNull();
    expect(resolveAsideAgent({ ...playing, addressed: [classmate, teacherAgent] })).toBeNull();
    expect(resolveAsideAgent({ ...playing, presenting: true, addressed: [classmate] })).toBeNull();
    expect(
      resolveAsideAgent({ ...playing, liveSessionOpen: true, addressed: [classmate] }),
    ).toBeNull();
    expect(
      resolveAsideAgent({ ...playing, teacherHandPending: true, addressed: [classmate] }),
    ).toBeNull();
    // Paused or idle: the named one answers first in an ordinary Q&A
    expect(
      resolveAsideAgent({ ...playing, engineMode: 'paused', addressed: [classmate] }),
    ).toBeNull();
  });

  it('keeps a follow-up in an open aside with whoever answers it', () => {
    expect(resolveAsideAgent({ ...playing, asideOpen: true, asideAgentId: 'default-3' })).toBe(
      'default-3',
    );
    // Naming someone else in the open aside asks them instead
    expect(
      resolveAsideAgent({
        ...playing,
        asideOpen: true,
        asideAgentId: 'default-3',
        addressed: [ta],
      }),
    ).toBe('default-2');
  });

  it('follows the assistant rules when nobody is named', () => {
    expect(resolveAsideAgent(playing)).toBe('default-2');
    expect(resolveAsideAgent({ ...playing, enabled: false })).toBeNull();
    expect(resolveAsideAgent({ ...playing, engineMode: 'idle' })).toBeNull();
  });
});
