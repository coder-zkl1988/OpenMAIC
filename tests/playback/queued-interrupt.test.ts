import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlaybackEngine } from '@/lib/playback/engine';
import { setModelSettingsViewForTests } from '../helpers/model-settings-view';
import type { Action, DiscussionAction } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import type { ActionEngine } from '@/lib/action/engine';
import type { AudioPlayer } from '@/lib/utils/audio-player';
import type { PlaybackEngineCallbacks, PlaybackSnapshot } from '@/lib/playback/types';

function speech(id: string, text = id): Action {
  return { id, type: 'speech', text } as Action;
}

function discussion(id: string): Action {
  return { id, type: 'discussion', topic: `topic-${id}` } as unknown as DiscussionAction;
}

function scene(actions: Action[]): Scene {
  return {
    id: 'scene-1',
    stageId: 'stage-1',
    type: 'slide',
    title: 'Scene 1',
    order: 1,
    content: { type: 'slide', canvas: {} },
    actions,
  } as unknown as Scene;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function createActionEngine(): ActionEngine {
  return {
    execute: vi.fn(async () => {}),
    clearEffects: vi.fn(),
    resetPlaybackVisualState: vi.fn(),
  } as unknown as ActionEngine;
}

/** play() resolving true = pre-generated audio; false = reading timer. */
function createAudioPlayer(audioStarted: boolean) {
  let ended: (() => void) | null = null;
  return {
    player: {
      play: vi.fn(async () => audioStarted),
      onEnded: vi.fn((callback: () => void) => {
        ended = callback;
      }),
      stop: vi.fn(),
      pause: vi.fn(),
      resume: vi.fn(),
      isPlaying: vi.fn(() => false),
      hasActiveAudio: vi.fn(() => false),
    } as unknown as AudioPlayer,
    fireEnded: () => ended?.(),
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function setup(actions: Action[], { audio = true, actionEngine = createActionEngine() } = {}) {
  const { player, fireEnded } = createAudioPlayer(audio);
  const callbacks = {
    onUserInterrupt: vi.fn(),
    onSpeechStart: vi.fn(),
    onSpeechEnd: vi.fn(),
    onProgress: vi.fn(),
    onComplete: vi.fn(),
    onProactiveShow: vi.fn(),
    onProactiveHide: vi.fn(),
    onDiscussionConfirmed: vi.fn(),
  } satisfies PlaybackEngineCallbacks;
  const engine = new PlaybackEngine([scene(actions)], actionEngine, player, callbacks);
  const lastProgress = () =>
    (callbacks.onProgress.mock.calls.at(-1) as [PlaybackSnapshot] | undefined)?.[0];
  return { engine, player, fireEnded, callbacks, actionEngine, lastProgress };
}

describe('PlaybackEngine raised hand (queued interrupt)', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setModelSettingsViewForTests(null);
  });

  it('answers after the current line ends and resumes at the next line', async () => {
    const { engine, fireEnded, callbacks, lastProgress } = setup([speech('a'), speech('b')]);
    engine.start();
    await flushPromises();

    expect(engine.queueUserInterrupt('Q')).toBe(true);
    expect(engine.hasQueuedInterrupt()).toBe(true);
    expect(callbacks.onUserInterrupt).not.toHaveBeenCalled();
    expect(engine.getMode()).toBe('playing');

    fireEnded();
    await flushPromises();

    expect(callbacks.onUserInterrupt).toHaveBeenCalledExactlyOnceWith('Q');
    expect(engine.getMode()).toBe('live');
    expect(engine.hasLectureInterruption()).toBe(true);
    expect(engine.hasPendingLectureCompletion()).toBe(false);
    expect(engine.hasQueuedInterrupt()).toBe(false);
    expect(lastProgress()?.actionIndex).toBe(1);
    expect(callbacks.onSpeechStart.mock.calls).toEqual([['a']]);

    engine.handleEndDiscussion();
    expect(engine.getSnapshot().actionIndex).toBe(1);
    engine.continuePlayback();
    await flushPromises();

    // The finished line is not replayed
    expect(callbacks.onSpeechStart.mock.calls).toEqual([['a'], ['b']]);
    engine.stop();
  });

  it('waits for the reading timer when there is no audio', async () => {
    vi.useFakeTimers();
    const { engine, callbacks } = setup([speech('a', 'A fairly long first line.'), speech('b')], {
      audio: false,
    });
    engine.start();
    await flushPromises();

    expect(engine.queueUserInterrupt('Q')).toBe(true);
    await vi.advanceTimersByTimeAsync(500);
    expect(callbacks.onUserInterrupt).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20000);
    expect(callbacks.onUserInterrupt).toHaveBeenCalledExactlyOnceWith('Q');
    expect(callbacks.onSpeechStart.mock.calls).toEqual([['A fairly long first line.']]);
    engine.stop();
  });

  it('waits for every browser-TTS chunk, never answering between sentences', async () => {
    const spoken: Array<{ onend?: () => void }> = [];
    vi.stubGlobal(
      'SpeechSynthesisUtterance',
      class {
        text: string;
        rate = 1;
        volume = 1;
        lang = 'en-US';
        voice?: SpeechSynthesisVoice;
        onend?: () => void;
        onerror?: (event: { error: string }) => void;
        constructor(text: string) {
          this.text = text;
        }
      },
    );
    vi.stubGlobal('window', {
      speechSynthesis: {
        getVoices: () => [{ voiceURI: 'v1', lang: 'en-US' }],
        cancel: vi.fn(),
        speak: vi.fn((utterance) => spoken.push(utterance)),
      },
    });
    setModelSettingsViewForTests({ tts: { registryId: 'browser-native-tts' } });

    const { engine, callbacks } = setup([speech('a', 'One. Two.'), speech('b')], {
      audio: false,
    });
    engine.start();
    await flushPromises();
    expect(spoken).toHaveLength(1);
    expect(engine.queueUserInterrupt('Q')).toBe(true);

    spoken[0].onend?.();
    await flushPromises();
    expect(spoken).toHaveLength(2);
    expect(callbacks.onUserInterrupt).not.toHaveBeenCalled();

    spoken[1].onend?.();
    await flushPromises();
    expect(callbacks.onUserInterrupt).toHaveBeenCalledExactlyOnceWith('Q');
    expect(callbacks.onSpeechStart.mock.calls).toEqual([['One. Two.']]);
    engine.stop();
  });

  it('answers after an awaited non-speech action completes', async () => {
    const actionEngine = createActionEngine();
    const board = deferred<void>();
    vi.mocked(actionEngine.execute).mockImplementationOnce(() => board.promise);
    const { engine, callbacks, lastProgress } = setup(
      [{ id: 'w', type: 'wb_open' } as Action, speech('b')],
      { actionEngine },
    );
    engine.start();
    await flushPromises();

    expect(engine.queueUserInterrupt('Q')).toBe(true);
    await flushPromises();
    expect(callbacks.onUserInterrupt).not.toHaveBeenCalled();

    board.resolve();
    await flushPromises();
    expect(callbacks.onUserInterrupt).toHaveBeenCalledExactlyOnceWith('Q');
    expect(callbacks.onSpeechStart).not.toHaveBeenCalled();
    expect(lastProgress()?.actionIndex).toBe(1);
    engine.stop();
  });

  it('answers a question asked during the last line instead of completing', async () => {
    const onDiscussionEnd = vi.fn();
    const { player, fireEnded } = createAudioPlayer(true);
    const onUserInterrupt = vi.fn();
    const onComplete = vi.fn();
    const onProgress = vi.fn();
    const engine: PlaybackEngine = new PlaybackEngine(
      [scene([speech('a')])],
      createActionEngine(),
      player,
      {
        onUserInterrupt,
        onComplete,
        onProgress,
        onDiscussionEnd: () =>
          onDiscussionEnd(engine.isExhausted(), engine.hasPendingLectureCompletion()),
      },
    );
    engine.start();
    await flushPromises();
    engine.queueUserInterrupt('Q');
    fireEnded();
    await flushPromises();

    expect(onUserInterrupt).toHaveBeenCalledExactlyOnceWith('Q');
    expect(onComplete).not.toHaveBeenCalled();
    expect(engine.hasPendingLectureCompletion()).toBe(true);
    expect(onProgress.mock.calls.at(-1)?.[0].actionIndex).toBe(1);

    // However the Q&A ends (here: by hand), the exhausted cursor still owes
    // its completion, so the owner can tell "Play completes" from "restart"
    engine.handleEndDiscussion();
    expect(onDiscussionEnd).toHaveBeenCalledExactlyOnceWith(true, true);
    expect(engine.getMode()).toBe('idle');

    // Resuming only runs the completion branch the raised hand preempted
    engine.continuePlayback();
    await flushPromises();
    expect(onComplete).toHaveBeenCalledOnce();
    expect(engine.getMode()).toBe('idle');
    expect(engine.hasPendingLectureCompletion()).toBe(false);
  });

  it('drops a pending completion when playback restarts', async () => {
    const { engine, fireEnded, callbacks } = setup([speech('a')]);
    engine.start();
    await flushPromises();
    engine.queueUserInterrupt('Q');
    fireEnded();
    await flushPromises();
    engine.handleEndDiscussion();
    expect(engine.hasPendingLectureCompletion()).toBe(true);

    engine.start();
    expect(engine.hasPendingLectureCompletion()).toBe(false);
    await flushPromises();
    expect(callbacks.onSpeechStart.mock.calls).toEqual([['a'], ['a']]);
    engine.stop();
  });

  it('answers before a following visual cue fires, and resumes at that cue', async () => {
    const actionEngine = createActionEngine();
    const { engine, fireEnded, callbacks } = setup(
      [speech('a'), { id: 's', type: 'spotlight', elementId: 'el' } as Action, speech('b')],
      { actionEngine },
    );
    engine.start();
    await flushPromises();
    engine.queueUserInterrupt('Q');
    fireEnded();
    await flushPromises();

    expect(callbacks.onUserInterrupt).toHaveBeenCalledExactlyOnceWith('Q');
    expect(actionEngine.execute).not.toHaveBeenCalled();

    engine.handleEndDiscussion();
    expect(engine.getSnapshot().actionIndex).toBe(1);
    engine.continuePlayback();
    await flushPromises();
    expect(vi.mocked(actionEngine.execute).mock.calls[0][0]).toMatchObject({ id: 's' });
    expect(callbacks.onSpeechStart.mock.calls).toEqual([['a'], ['b']]);
    engine.stop();
  });

  it('answers before a following discussion and offers that discussion afterwards', async () => {
    vi.useFakeTimers();
    const { engine, fireEnded, callbacks } = setup([speech('a'), discussion('d')]);
    engine.start();
    await flushPromises();
    engine.queueUserInterrupt('Q');
    fireEnded();
    await vi.advanceTimersByTimeAsync(5000);

    expect(callbacks.onUserInterrupt).toHaveBeenCalledExactlyOnceWith('Q');
    expect(callbacks.onProactiveShow).not.toHaveBeenCalled();

    engine.handleEndDiscussion();
    expect(engine.getSnapshot().actionIndex).toBe(1);
    engine.continuePlayback();
    await vi.advanceTimersByTimeAsync(3000);
    expect(callbacks.onProactiveShow).toHaveBeenCalledOnce();
    expect(callbacks.onProactiveShow.mock.calls[0][0].id).toBe('d');
    engine.stop();
  });

  it('refuses to queue while a discussion trigger is pending; the discussion is re-offered', async () => {
    vi.useFakeTimers();
    const { engine, fireEnded, callbacks } = setup([speech('a'), discussion('d')]);
    engine.start();
    await flushPromises();
    fireEnded();
    await flushPromises();

    // Waiting on the 3s trigger delay, not in a line: the question goes now
    expect(engine.queueUserInterrupt('Q')).toBe(false);
    engine.handleUserInterrupt('Q');
    expect(callbacks.onUserInterrupt).toHaveBeenCalledExactlyOnceWith('Q');
    await vi.advanceTimersByTimeAsync(5000);
    expect(callbacks.onProactiveShow).not.toHaveBeenCalled();

    engine.handleEndDiscussion();
    expect(engine.getSnapshot().actionIndex).toBe(1);
    engine.continuePlayback();
    await vi.advanceTimersByTimeAsync(3000);
    expect(callbacks.onProactiveShow).toHaveBeenCalledOnce();
    engine.stop();
  });

  it.each(['playing', 'paused'] as const)(
    'hides a shown ProactiveCard without consuming its discussion (%s)',
    async (mode) => {
      vi.useFakeTimers();
      const { engine, fireEnded, callbacks } = setup([speech('a'), discussion('d')]);
      engine.start();
      await flushPromises();
      fireEnded();
      await vi.advanceTimersByTimeAsync(4000);
      expect(callbacks.onProactiveShow).toHaveBeenCalledOnce();
      if (mode === 'paused') engine.pause();

      expect(engine.queueUserInterrupt('Q')).toBe(false);
      engine.handleUserInterrupt('Q');
      expect(callbacks.onProactiveHide).toHaveBeenCalled();
      expect(engine.getSnapshot().consumedDiscussions).not.toContain('d');

      // A stale "Join" during the Q&A can't overwrite the saved cursor
      engine.confirmDiscussion();
      expect(callbacks.onDiscussionConfirmed).not.toHaveBeenCalled();
      expect(engine.getMode()).toBe('live');

      engine.handleEndDiscussion();
      expect(engine.getSnapshot().actionIndex).toBe(1);
      engine.continuePlayback();
      await vi.advanceTimersByTimeAsync(4000);
      expect(callbacks.onProactiveShow).toHaveBeenCalledTimes(2);
      engine.stop();
    },
  );

  it('resumes normally after the Q&A instead of waiting on a hidden card', async () => {
    vi.useFakeTimers();
    const { engine, fireEnded, callbacks } = setup([speech('a'), discussion('d'), speech('b')]);
    engine.start();
    await flushPromises();
    fireEnded();
    await vi.advanceTimersByTimeAsync(4000);
    engine.handleUserInterrupt('Q');
    engine.handleEndDiscussion();

    // Re-offer pending, then a pause/resume: the engine must not believe it is
    // still waiting on the card it hid during the Q&A
    engine.continuePlayback();
    engine.pause();
    engine.resume();
    await flushPromises();
    expect(callbacks.onSpeechStart.mock.calls.at(-1)).toEqual(['b']);
    engine.stop();
  });

  it('drops a cancelled question and keeps playing', async () => {
    const { engine, fireEnded, callbacks } = setup([speech('a'), speech('b')]);
    engine.start();
    await flushPromises();
    engine.queueUserInterrupt('Q');

    expect(engine.cancelQueuedInterrupt()).toBe('Q');
    expect(engine.cancelQueuedInterrupt()).toBeNull();
    fireEnded();
    await flushPromises();

    expect(callbacks.onUserInterrupt).not.toHaveBeenCalled();
    expect(callbacks.onSpeechStart.mock.calls).toEqual([['a'], ['b']]);
    expect(engine.getMode()).toBe('playing');
    engine.stop();
  });

  it('clears the question on stop()', async () => {
    const { engine, fireEnded, callbacks } = setup([speech('a'), speech('b')]);
    engine.start();
    await flushPromises();
    engine.queueUserInterrupt('Q');
    engine.stop();
    expect(engine.hasQueuedInterrupt()).toBe(false);

    engine.start();
    await flushPromises();
    fireEnded();
    await flushPromises();
    expect(callbacks.onUserInterrupt).not.toHaveBeenCalled();
    engine.stop();
  });

  it('clears the question on jumpToAction()', async () => {
    const { engine, fireEnded, callbacks } = setup([speech('a'), speech('b')]);
    engine.start();
    await flushPromises();
    engine.queueUserInterrupt('Q');

    expect(await engine.jumpToAction(1, { autoplay: false })).toBe(true);
    expect(engine.hasQueuedInterrupt()).toBe(false);
    engine.resume();
    await flushPromises();
    fireEnded();
    await flushPromises();
    expect(callbacks.onUserInterrupt).not.toHaveBeenCalled();
    engine.stop();
  });

  it('flushes immediately and replays the cut line', async () => {
    const { engine, callbacks } = setup([speech('a'), speech('b')]);
    expect(engine.flushQueuedInterrupt()).toBe(false);
    engine.start();
    await flushPromises();
    engine.queueUserInterrupt('Q');

    expect(engine.flushQueuedInterrupt()).toBe(true);
    expect(callbacks.onUserInterrupt).toHaveBeenCalledExactlyOnceWith('Q');
    expect(engine.getMode()).toBe('live');
    expect(engine.hasQueuedInterrupt()).toBe(false);

    engine.handleEndDiscussion();
    expect(engine.getSnapshot().actionIndex).toBe(0);
  });

  it('ignores the cut line ending after a flush (audio)', async () => {
    const { engine, fireEnded, callbacks } = setup([speech('a'), speech('b')]);
    engine.start();
    await flushPromises();
    engine.queueUserInterrupt('Q');
    engine.flushQueuedInterrupt();

    fireEnded();
    await flushPromises();
    expect(callbacks.onUserInterrupt).toHaveBeenCalledOnce();
    expect(engine.getMode()).toBe('live');
  });

  it('ignores the stale reading timer after a flush', async () => {
    vi.useFakeTimers();
    const { engine, callbacks } = setup([speech('a'), speech('b')], { audio: false });
    engine.start();
    await flushPromises();
    engine.queueUserInterrupt('Q');
    engine.flushQueuedInterrupt();

    await vi.advanceTimersByTimeAsync(20000);
    expect(callbacks.onUserInterrupt).toHaveBeenCalledOnce();
    expect(callbacks.onSpeechEnd).not.toHaveBeenCalled();
    expect(engine.getMode()).toBe('live');
  });

  it('refuses to queue outside playback and while a question already waits', async () => {
    const { engine, fireEnded, callbacks } = setup([speech('a'), speech('b'), speech('c')]);
    expect(engine.queueUserInterrupt('idle')).toBe(false);

    engine.start();
    await flushPromises();
    engine.pause();
    expect(engine.queueUserInterrupt('paused')).toBe(false);
    engine.resume();

    expect(engine.queueUserInterrupt('first')).toBe(true);
    expect(engine.queueUserInterrupt('second')).toBe(false);
    fireEnded();
    await flushPromises();
    expect(callbacks.onUserInterrupt.mock.calls).toEqual([['first']]);

    expect(engine.getMode()).toBe('live');
    expect(engine.queueUserInterrupt('live')).toBe(false);
  });

  it('keeps a question through an engine pause and answers after resume', async () => {
    vi.useFakeTimers();
    const { engine, callbacks } = setup([speech('a', 'A fairly long first line.'), speech('b')], {
      audio: false,
    });
    engine.start();
    await flushPromises();
    engine.queueUserInterrupt('Q');
    await vi.advanceTimersByTimeAsync(500);
    engine.pause();

    await vi.advanceTimersByTimeAsync(20000);
    expect(callbacks.onUserInterrupt).not.toHaveBeenCalled();
    expect(engine.hasQueuedInterrupt()).toBe(true);

    engine.resume();
    await vi.advanceTimersByTimeAsync(20000);
    expect(callbacks.onUserInterrupt).toHaveBeenCalledExactlyOnceWith('Q');
    engine.stop();
  });

  it('a direct interrupt supersedes the waiting question', async () => {
    const { engine, fireEnded, callbacks } = setup([speech('a'), speech('b')]);
    engine.start();
    await flushPromises();
    engine.queueUserInterrupt('queued');
    engine.handleUserInterrupt('direct');
    fireEnded();
    await flushPromises();

    expect(callbacks.onUserInterrupt.mock.calls).toEqual([['direct']]);
    expect(engine.hasQueuedInterrupt()).toBe(false);
  });

  describe('resume position after a boundary delivery', () => {
    const spotlight = (id: string) => ({ id, type: 'spotlight', elementId: 'el' }) as Action;

    it('flags the boundary progress, whatever the next action is', async () => {
      const { engine, fireEnded, callbacks } = setup([speech('a'), spotlight('s'), speech('b')]);
      engine.start();
      await flushPromises();
      engine.queueUserInterrupt('Q');
      fireEnded();
      await flushPromises();

      expect(callbacks.onProgress.mock.calls.at(-1)).toEqual([
        expect.objectContaining({ actionIndex: 1 }),
        { atBoundary: true },
      ]);
      // Ordinary progress carries no flag
      expect(callbacks.onProgress.mock.calls[0]).toHaveLength(1);
    });

    it.each([
      ['a pause flush', (engine: PlaybackEngine) => engine.flushQueuedInterrupt()],
      ['a direct interrupt', (engine: PlaybackEngine) => engine.handleUserInterrupt('direct')],
    ])('publishes no boundary for %s, so the cut line replays', async (_label, interrupt) => {
      const { engine, callbacks } = setup([speech('a'), spotlight('s'), speech('b')]);
      engine.start();
      await flushPromises();
      engine.queueUserInterrupt('Q');

      interrupt(engine);
      expect(callbacks.onUserInterrupt).toHaveBeenCalledOnce();
      expect(callbacks.onProgress.mock.calls.some((call) => call.length > 1)).toBe(false);
      engine.handleEndDiscussion();
      expect(engine.getSnapshot().actionIndex).toBe(0);
    });

    it('jumps to a non-speech action only as a boundary with a reconstructable prefix', async () => {
      const cue = setup([speech('a'), spotlight('s'), speech('b')]).engine;
      expect(cue.canJumpToAction(1)).toBe(false);
      expect(cue.canJumpToAction(1, { atBoundary: true })).toBe(true);

      const video = setup([
        speech('a'),
        { id: 'v', type: 'play_video', elementId: 'vid' } as Action,
        { id: 'w', type: 'wb_draw_text', content: 'x', x: 0, y: 0 } as Action,
        speech('b'),
      ]).engine;
      // The video itself has not run: it plays fresh. Past it, the prefix
      // cannot be rebuilt.
      expect(video.canJumpToAction(1, { atBoundary: true })).toBe(true);
      expect(video.canJumpToAction(2, { atBoundary: true })).toBe(false);

      const { engine: live, fireEnded } = setup([speech('a'), spotlight('s'), speech('b')]);
      live.start();
      await flushPromises();
      live.queueUserInterrupt('Q');
      fireEnded();
      await flushPromises();
      expect(live.getMode()).toBe('live');
      expect(live.canJumpToAction(1, { atBoundary: true })).toBe(false);
    });

    it('restores at the boundary and resumes with that action, not the finished line', async () => {
      const { engine, callbacks, actionEngine } = setup([speech('a'), spotlight('s'), speech('b')]);
      expect(await engine.jumpToAction(1, { autoplay: false, atBoundary: true })).toBe(true);
      expect(engine.getMode()).toBe('idle');
      expect(engine.getSnapshot().actionIndex).toBe(1);

      engine.continuePlayback();
      await flushPromises();
      expect(vi.mocked(actionEngine.execute).mock.calls.map(([action]) => action.id)).toEqual([
        's',
      ]);
      expect(callbacks.onSpeechStart.mock.calls).toEqual([['b']]);
      engine.stop();
    });

    it('rebuilds a whiteboard prefix silently before a boundary', async () => {
      const draw = { id: 'w', type: 'wb_draw_text', content: 'x', x: 0, y: 0 } as Action;
      const { engine, actionEngine } = setup([speech('a'), draw, spotlight('s'), speech('b')]);

      expect(await engine.jumpToAction(2, { autoplay: false, atBoundary: true })).toBe(true);
      expect(actionEngine.execute).toHaveBeenCalledExactlyOnceWith(draw, { silent: true });
    });

    it('offers a discussion it was restored at', async () => {
      vi.useFakeTimers();
      const { engine, callbacks } = setup([speech('a'), discussion('d')]);
      expect(await engine.jumpToAction(1, { autoplay: false, atBoundary: true })).toBe(true);

      engine.continuePlayback();
      await vi.advanceTimersByTimeAsync(4000);
      expect(callbacks.onProactiveShow).toHaveBeenCalledOnce();
      expect(callbacks.onProactiveShow.mock.calls[0][0].id).toBe('d');
      expect(callbacks.onSpeechStart).not.toHaveBeenCalled();
      engine.stop();
    });
  });

  describe('what the raised hand waits for', () => {
    it('is a spoken line while one plays (audio or reading timer)', async () => {
      vi.useFakeTimers();
      for (const audio of [true, false]) {
        const { engine } = setup([speech('a', 'A spoken line.'), speech('b')], { audio });
        expect(engine.isSpeechInFlight()).toBe(false);
        engine.start();
        await flushPromises();
        expect(engine.isSpeechInFlight()).toBe(true);

        engine.pause();
        expect(engine.isSpeechInFlight()).toBe(false);
        engine.stop();
      }
    });

    it.each([
      ['a drawing', { id: 'w', type: 'wb_draw_text', content: 'x', x: 0, y: 0 } as Action],
      ['a video', { id: 'v', type: 'play_video', elementId: 'vid' } as Action],
    ])('is another step while %s runs', async (_label, step) => {
      const actionEngine = createActionEngine();
      const running = deferred<void>();
      vi.mocked(actionEngine.execute).mockImplementationOnce(() => running.promise);
      const { engine } = setup([step, speech('b')], { actionEngine });
      engine.start();
      await flushPromises();

      expect(engine.getMode()).toBe('playing');
      expect(engine.isSpeechInFlight()).toBe(false);
      running.resolve();
      await flushPromises();
      expect(engine.isSpeechInFlight()).toBe(true);
      engine.stop();
    });

    it('is another step for a blank line, and nothing in live Q&A', async () => {
      vi.useFakeTimers();
      const { engine } = setup([speech('blank', '  '), speech('b')], { audio: false });
      engine.start();
      await flushPromises();
      expect(engine.getMode()).toBe('playing');
      expect(engine.isSpeechInFlight()).toBe(false);
      engine.stop();

      const live = setup([speech('a'), speech('b')]);
      live.engine.start();
      await flushPromises();
      live.engine.queueUserInterrupt('Q');
      live.fireEnded();
      await flushPromises();
      expect(live.engine.getMode()).toBe('live');
      expect(live.engine.isSpeechInFlight()).toBe(false);
    });
  });
});
