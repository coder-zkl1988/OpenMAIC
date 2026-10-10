// @vitest-environment jsdom

/**
 * The teacher caption strip under the slide: the speaker, the status chip
 * mapped from buildCaptionModel (讲解中 with the wave, 已暂停，等你发言,
 * 思考中, answering / discussing) and the two-line text — clamped from the
 * start for a lecture line, following the tail while an answer streams.
 */
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));
vi.mock('@/components/ui/avatar-display', () => ({ AvatarDisplay: () => null }));

import { CaptionStrip, type CaptionStripProps } from '@/components/classroom/caption-strip';
import { computePlaybackView, type PlaybackRawState } from '@/lib/playback/derived-state';
import type { Participant } from '@/lib/types/roundtable';

const participants: Participant[] = [
  { id: 'teacher-1', name: 'Ms. Li', role: 'teacher', avatar: '/avatars/teacher.png' },
  { id: 'student-1', name: 'Kai', role: 'student', avatar: '/avatars/kai.png' },
] as Participant[];

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
  idleText: 'Welcome to the lesson',
  speakingStudent: false,
  sessionType: null,
};

describe('CaptionStrip', () => {
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

  /** Render from the raw playback state, the way the shell derives it. */
  function render(raw: Partial<PlaybackRawState>, extra: Partial<CaptionStripProps> = {}) {
    const state = { ...IDLE, ...raw };
    const props: CaptionStripProps = {
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
      ...extra,
    };
    act(() => root.render(createElement(CaptionStrip, props)));
  }

  const strip = () => container.querySelector('[data-testid="caption-strip"]')!;
  const status = () => container.querySelector('[data-testid="caption-status"]');
  const text = () => container.querySelector('[data-testid="caption-text"]');
  const name = () => strip().querySelector('span.truncate')?.textContent;

  it('shows the teacher lecturing with the wave', () => {
    render({ engineMode: 'playing', lectureSpeech: 'Photosynthesis turns light into sugar.' });
    expect(strip().getAttribute('data-status')).toBe('lecturing');
    expect(name()).toBe('Ms. Li');
    expect(status()?.textContent).toBe('stage.caption.lecturing');
    expect(status()?.className).toContain('text-accent-text');
    // The wave's four bars
    expect(status()?.querySelectorAll('i')).toHaveLength(4);
    expect(text()?.textContent).toBe('Photosynthesis turns light into sugar.');
  });

  it.each([
    ['paused lecture', { engineMode: 'paused', lectureSpeech: 'Where were we?' }],
    ['cued learner', { engineMode: 'live', isCueUser: true, sessionType: 'qa' }],
  ] as const)('says 已暂停，等你发言 for a %s', (_label, raw) => {
    render(raw as Partial<PlaybackRawState>);
    expect(strip().getAttribute('data-status')).toBe('paused');
    expect(status()?.textContent).toBe('stage.caption.paused');
    expect(status()?.className).toContain('text-fg-tertiary');
    expect(status()?.querySelector('i')).toBeNull();
    // Nobody owns the line while the learner is cued: the teacher stays
    expect(name()).toBe('Ms. Li');
  });

  it('shows thinking dots before the first words of an answer', () => {
    render({
      engineMode: 'live',
      chatIsStreaming: true,
      sessionType: 'qa',
      thinkingState: { stage: 'director' },
    });
    expect(strip().getAttribute('data-status')).toBe('thinking');
    expect(status()?.textContent).toBe('roundtable.thinking');
    expect(text()).toBeNull();
  });

  it('names the answering student and maps answering / discussing', () => {
    render({
      engineMode: 'live',
      chatIsStreaming: true,
      sessionType: 'discussion',
      speakingAgentId: 'student-1',
      speakingStudent: true,
      liveSpeech: 'I think the leaves store it.',
    });
    expect(name()).toBe('Kai');
    expect(status()?.textContent).toBe('stage.caption.discussing');

    render({
      engineMode: 'live',
      chatIsStreaming: true,
      sessionType: 'qa',
      speakingAgentId: 'teacher-1',
      liveSpeech: 'Good question.',
    });
    expect(name()).toBe('Ms. Li');
    expect(status()?.textContent).toBe('stage.caption.answering');
  });

  it('shows no status chip before playback starts, with the first line', () => {
    render({});
    expect(strip().getAttribute('data-status')).toBe('idle');
    expect(status()).toBeNull();
    expect(text()?.textContent).toBe('Welcome to the lesson');
  });

  it('clamps a lecture line from its start to two lines', () => {
    render({ engineMode: 'playing', lectureSpeech: 'A long line. '.repeat(40) });
    expect(text()?.getAttribute('data-overflow')).toBe('clamp');
    expect(text()?.className).toContain('line-clamp-2');
    // Fixed height: the slide above never resizes as lines change
    expect(strip().className).toContain('h-[92px]');
  });

  it('follows the tail of a streaming answer instead of clipping it', () => {
    const live = {
      engineMode: 'live' as const,
      chatIsStreaming: true,
      sessionType: 'qa',
      speakingAgentId: 'teacher-1',
    };
    render({ ...live, liveSpeech: 'First words' });
    const el = text() as HTMLParagraphElement;
    expect(el.getAttribute('data-overflow')).toBe('tail');
    expect(el.className).toContain('max-h-[3.2em]');
    expect(el.className).toContain('overflow-hidden');
    expect(el.className).not.toContain('line-clamp-2');

    // jsdom has no layout: give the element a scroll height to follow
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 240 });
    render({ ...live, liveSpeech: 'First words and many more streamed words' });
    expect(el.scrollTop).toBe(240);
  });

  it('spins while the speaking agent’s audio is generated', () => {
    const raw = {
      engineMode: 'live' as const,
      chatIsStreaming: true,
      sessionType: 'qa',
      speakingAgentId: 'teacher-1',
      liveSpeech: 'Hello',
    };
    render(raw, { audioIndicatorState: 'generating', audioAgentId: 'teacher-1' });
    expect(container.querySelector('[data-testid="caption-audio-generating"]')).not.toBeNull();
    render(raw, { audioIndicatorState: 'generating', audioAgentId: 'someone-else' });
    expect(container.querySelector('[data-testid="caption-audio-generating"]')).toBeNull();
  });
});
