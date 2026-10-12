import { describe, expect, it } from 'vitest';
import {
  pickAssistantAgent,
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
