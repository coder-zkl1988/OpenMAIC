import { describe, expect, it } from 'vitest';
import { computePlaybackView, type PlaybackRawState } from '@/lib/playback/derived-state';
import { buildCaptionModel, type CaptionModelInput } from '@/lib/playback/caption-model';
import { buildPresentationBubbleModel } from '@/components/roundtable/presentation-speech-overlay';
import type { Participant } from '@/lib/types/roundtable';

const participants: Participant[] = [
  { id: 'teacher-1', name: 'Ms. Lee', role: 'teacher', avatar: '/t.png', isOnline: true },
  { id: 'student-1', name: 'Kai', role: 'student', avatar: '/k.png', isOnline: true },
  { id: 'user-1', name: 'Sam', role: 'user', avatar: '/u.png', isOnline: true },
];

const names = { teacher: 'Teacher', student: 'Student', user: 'You' };

const IDLE: PlaybackRawState = {
  engineMode: 'idle',
  lectureSpeech: null,
  liveSpeech: null,
  speakingAgentId: null,
  thinkingState: null,
  isCueUser: false,
  isTopicPending: false,
  chatIsStreaming: false,
  discussionTrigger: null,
  playbackCompleted: false,
  idleText: null,
  speakingStudent: false,
  sessionType: null,
};

/** The owner's view plus the matching caption input, as PlaybackChromeRoot feeds the roundtable */
function caption(raw: Partial<PlaybackRawState>, extra: Partial<CaptionModelInput> = {}) {
  const state = { ...IDLE, ...raw };
  return buildCaptionModel({
    playbackView: computePlaybackView(state),
    participants,
    speakingAgentId: state.speakingAgentId,
    currentSpeech: state.liveSpeech,
    lectureSpeech: state.lectureSpeech,
    idleText: state.idleText,
    playbackCompleted: state.playbackCompleted,
    isStreaming: state.chatIsStreaming,
    sessionType:
      state.sessionType === 'qa' || state.sessionType === 'discussion'
        ? state.sessionType
        : undefined,
    thinkingState: state.thinkingState,
    isCueUser: state.isCueUser,
    isTopicPending: state.isTopicPending,
    names,
    ...extra,
  });
}

describe('buildCaptionModel', () => {
  it('captions the teacher while the lecture plays and when it pauses', () => {
    const playing = caption({ engineMode: 'playing', lectureSpeech: 'Gravity pulls.' });
    expect(playing).toMatchObject({
      key: 'teacher',
      role: 'teacher',
      activeRole: 'teacher',
      name: 'Ms. Lee',
      avatar: '/t.png',
      text: 'Gravity pulls.',
      status: 'lecturing',
      isLoading: false,
      isInLiveFlow: false,
    });

    const paused = caption({ engineMode: 'paused', lectureSpeech: 'Gravity pulls.' });
    expect(paused).toMatchObject({ role: 'teacher', text: 'Gravity pulls.', status: 'paused' });
  });

  it('shows the idle line before playback and an empty restart line once it completed', () => {
    expect(caption({ idleText: 'Welcome' })).toMatchObject({
      role: 'teacher',
      text: 'Welcome',
      status: 'idle',
    });
    const completed = caption({ idleText: 'Welcome', playbackCompleted: true });
    expect(completed).toMatchObject({ role: 'teacher', text: '', status: 'idle' });
    expect(completed.view.buttonState).toBe('restart');
  });

  it('has no speaker when nothing is said', () => {
    expect(caption({})).toMatchObject({ role: null, key: 'idle', name: '', avatar: '', text: '' });
  });

  it('cues the learner: nobody owns the caption and the class waits', () => {
    const cue = caption({ engineMode: 'paused', isCueUser: true, lectureSpeech: 'Your turn?' });
    expect(cue.status).toBe('paused');
    expect(cue.activeRole).toBeNull();
    expect(cue.view.phase).toBe('cueUser');
  });

  it('thinks before the answer, then names the speaking student in a discussion', () => {
    const thinking = caption({
      engineMode: 'live',
      thinkingState: { stage: 'director' },
      chatIsStreaming: true,
      sessionType: 'discussion',
    });
    expect(thinking).toMatchObject({
      role: null,
      text: '',
      status: 'thinking',
      isInLiveFlow: true,
    });

    const loading = caption({
      engineMode: 'live',
      speakingAgentId: 'student-1',
      speakingStudent: true,
      chatIsStreaming: true,
      sessionType: 'discussion',
    });
    expect(loading).toMatchObject({
      role: 'agent',
      key: 'agent-student-1',
      isLoading: true,
      isAgentLoading: true,
      status: 'thinking',
    });

    const speaking = caption({
      engineMode: 'live',
      speakingAgentId: 'student-1',
      speakingStudent: true,
      liveSpeech: 'I think it is mass.',
      chatIsStreaming: true,
      sessionType: 'discussion',
    });
    expect(speaking).toMatchObject({
      role: 'agent',
      name: 'Kai',
      avatar: '/k.png',
      text: 'I think it is mass.',
      status: 'discussion',
      isLoading: false,
    });
    expect(speaking.speakingStudent?.id).toBe('student-1');
  });

  it('answers a question and pauses with the live reveal', () => {
    const answering = caption({
      engineMode: 'live',
      speakingAgentId: 'teacher-1',
      liveSpeech: 'Good question.',
      chatIsStreaming: true,
      sessionType: 'qa',
    });
    expect(answering).toMatchObject({ role: 'teacher', status: 'answering' });

    const paused = caption(
      {
        engineMode: 'live',
        speakingAgentId: 'teacher-1',
        liveSpeech: 'Good question.',
        chatIsStreaming: true,
        sessionType: 'qa',
      },
      { isLivePaused: true },
    );
    expect(paused.status).toBe('paused');
  });

  it('overlays the question the user just sent', () => {
    const model = caption(
      { engineMode: 'playing', lectureSpeech: 'Gravity pulls.' },
      { userMessage: 'Why?' },
    );
    expect(model).toMatchObject({
      key: 'user',
      role: 'user',
      activeRole: 'user',
      name: 'Sam',
      avatar: '/u.png',
      text: 'Why?',
    });
    // The enriched view carries the overlay to the presentation bubble
    expect(model.view).toMatchObject({ bubbleRole: 'user', sourceText: 'Why?' });
  });

  it('falls back to its own derivation without a playback view', () => {
    const model = buildCaptionModel({
      participants,
      lectureSpeech: 'Line one',
      names,
      avatars: { agentFallback: '/fallback.png' },
    });
    expect(model).toMatchObject({ role: 'teacher', text: 'Line one', status: 'idle' });
    expect(model.view).toMatchObject({ phase: 'idle', buttonState: 'none', bubbleRole: 'teacher' });

    const unknownAgent = buildCaptionModel({
      participants: [...participants, { ...participants[1], id: 'student-2', avatar: '' }],
      speakingAgentId: 'student-2',
      currentSpeech: 'Hi',
      names,
      avatars: { agentFallback: '/fallback.png' },
    });
    expect(unknownAgent).toMatchObject({ role: 'agent', avatar: '/fallback.png' });
  });
});

describe('buildPresentationBubbleModel', () => {
  it('shows a resolved view only while a line plays or waits', () => {
    const playing = caption({ engineMode: 'playing', lectureSpeech: 'Gravity pulls.' });
    const common = {
      participants,
      speakingAgentId: null,
      isTopicPending: false,
      fallbackTeacherName: 'Teacher',
      fallbackStudentName: 'Student',
      fallbackUserName: 'You',
    };
    expect(buildPresentationBubbleModel({ ...common, playbackView: playing.view })).toEqual({
      key: 'teacher',
      role: 'teacher',
      side: 'left',
      name: 'Ms. Lee',
      avatar: '/t.png',
      text: 'Gravity pulls.',
      isLoading: false,
      isTopicPending: false,
    });

    const idle = caption({ idleText: 'Welcome' });
    expect(buildPresentationBubbleModel({ ...common, playbackView: idle.view })).toBeNull();

    const user = caption(
      { engineMode: 'playing', lectureSpeech: 'Gravity pulls.' },
      { userMessage: 'Why?' },
    );
    expect(
      buildPresentationBubbleModel({ ...common, playbackView: user.view, userAvatar: '/me.png' }),
    ).toMatchObject({ role: 'user', side: 'right', name: 'Sam', avatar: '/me.png' });
  });
});
