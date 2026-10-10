import { afterEach, describe, expect, it, vi } from 'vitest';

import { PlaybackEngine } from '@/lib/playback/engine';
import { estimateSpeechDurationMs } from '@/lib/choreography';
import { setModelSettingsViewForTests } from '../helpers/model-settings-view';
import type { Action, DiscussionAction } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import type { ActionEngine } from '@/lib/action/engine';
import type { AudioPlayer } from '@/lib/utils/audio-player';
import type { EngineMode, PlaybackEngineCallbacks, PlaybackSnapshot } from '@/lib/playback/types';

function speech(id: string, text = id): Action {
  return { id, type: 'speech', text } as Action;
}

function discussion(id: string): Action {
  return {
    id,
    type: 'discussion',
    topic: `topic-${id}`,
    agentId: 'agent-1',
  } as unknown as DiscussionAction;
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

function createActionEngine(): ActionEngine {
  return {
    execute: vi.fn(async () => {}),
    clearEffects: vi.fn(),
    resetPlaybackVisualState: vi.fn(),
  } as unknown as ActionEngine;
}

/**
 * play() resolving true = pre-generated audio; false = reading timer. Like
 * the real player, a line that ended keeps its element until stop() or the
 * next play() drops it.
 */
function createAudioPlayer(audioStarted: boolean) {
  let ended: (() => void) | null = null;
  const state = { active: false, paused: false, currentTime: 0, duration: 0 };
  const player = {
    play: vi.fn(async () => {
      state.active = audioStarted;
      state.paused = false;
      return audioStarted;
    }),
    onEnded: vi.fn((callback: () => void) => {
      ended = callback;
    }),
    stop: vi.fn(() => {
      state.active = false;
    }),
    pause: vi.fn(() => {
      state.paused = true;
    }),
    resume: vi.fn(() => {
      state.paused = false;
    }),
    isPlaying: vi.fn(() => state.active && !state.paused),
    hasActiveAudio: vi.fn(() => state.active),
    getCurrentTime: vi.fn(() => state.currentTime),
    getDuration: vi.fn(() => state.duration),
  };
  return {
    player: player as unknown as AudioPlayer,
    mocks: player,
    state,
    fireEnded: () => {
      state.paused = true;
      ended?.();
    },
  };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

function setup(actions: Action[], { audio = true } = {}) {
  const { player, mocks, state, fireEnded } = createAudioPlayer(audio);
  const actionEngine = createActionEngine();
  const modes: EngineMode[] = [];
  const callbacks = {
    onModeChange: vi.fn((mode: EngineMode) => modes.push(mode)),
    onUserInterrupt: vi.fn(),
    onHandCalled: vi.fn(),
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
    callbacks.onProgress.mock.calls.at(-1) as
      | [PlaybackSnapshot, { atBoundary?: boolean }?]
      | undefined;
  const spoken = () => callbacks.onSpeechStart.mock.calls.map(([text]) => text);
  return { engine, player: mocks, audio: state, fireEnded, callbacks, modes, lastProgress, spoken };
}

function stubBrowserTTS() {
  const utterances: Array<{ text: string; onend?: () => void }> = [];
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
      speak: vi.fn((utterance) => utterances.push(utterance)),
    },
  });
  setModelSettingsViewForTests({ tts: { registryId: 'browser-native-tts' } });
  return utterances;
}

describe('PlaybackEngine hand-only raise', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    setModelSettingsViewForTests(null);
  });

  describe('called at the next boundary', () => {
    it('lets the line finish, then pauses and calls the learner once', async () => {
      const { engine, fireEnded, callbacks, lastProgress, spoken } = setup([
        speech('a'),
        speech('b'),
      ]);
      engine.start();
      await flushPromises();

      expect(engine.raiseHand()).toBe(true);
      expect(engine.getHandState()).toBe('raised');
      expect(engine.hasQueuedInterrupt()).toBe(true);
      expect(engine.getMode()).toBe('playing');
      expect(callbacks.onHandCalled).not.toHaveBeenCalled();

      fireEnded();
      await flushPromises();

      expect(engine.getMode()).toBe('paused');
      expect(engine.getHandState()).toBe('called');
      expect(engine.hasQueuedInterrupt()).toBe(false);
      expect(callbacks.onHandCalled).toHaveBeenCalledExactlyOnceWith({ atBoundary: true });
      expect(callbacks.onUserInterrupt).not.toHaveBeenCalled();
      expect(engine.hasLectureInterruption()).toBe(false);
      expect(lastProgress()).toEqual([
        expect.objectContaining({ actionIndex: 1 }),
        { atBoundary: true },
      ]);
      expect(spoken()).toEqual(['a']);
    });

    it('sets the mode before stopping the audio', async () => {
      const { engine, fireEnded, player } = setup([speech('a'), speech('b')]);
      engine.start();
      await flushPromises();
      engine.raiseHand();
      const modeAtStop: EngineMode[] = [];
      player.stop.mockImplementation(() => {
        modeAtStop.push(engine.getMode());
      });

      fireEnded();
      await flushPromises();
      expect(modeAtStop).toEqual(['paused']);
    });

    it('answers the waiting hand before the next line starts (reading timer)', async () => {
      vi.useFakeTimers();
      const { engine, callbacks, spoken } = setup(
        [speech('a', 'A fairly long first line.'), speech('b')],
        { audio: false },
      );
      engine.start();
      await flushPromises();
      engine.raiseHand();

      await vi.advanceTimersByTimeAsync(20000);
      expect(callbacks.onHandCalled).toHaveBeenCalledOnce();
      expect(engine.getMode()).toBe('paused');
      expect(spoken()).toEqual(['A fairly long first line.']);
    });
  });

  describe('a question sent while called', () => {
    it('saves the NEXT action, so the finished line is not replayed', async () => {
      const { engine, fireEnded, callbacks, spoken } = setup([speech('a'), speech('b')]);
      engine.start();
      await flushPromises();
      engine.raiseHand();
      fireEnded();
      await flushPromises();

      engine.handleUserInterrupt('Q');
      expect(callbacks.onUserInterrupt).toHaveBeenCalledExactlyOnceWith('Q');
      expect(engine.getMode()).toBe('live');
      expect(engine.getHandState()).toBeNull();
      expect(engine.hasLectureInterruption()).toBe(true);

      engine.handleEndDiscussion();
      expect(engine.getSnapshot().actionIndex).toBe(1);
      engine.continuePlayback();
      await flushPromises();
      expect(spoken()).toEqual(['a', 'b']);
      engine.stop();
    });

    it('still owes the completion when called after the last line', async () => {
      const { engine, fireEnded, callbacks } = setup([speech('a')]);
      engine.start();
      await flushPromises();
      engine.raiseHand();
      fireEnded();
      await flushPromises();

      expect(callbacks.onComplete).not.toHaveBeenCalled();
      expect(engine.hasPendingLectureCompletion()).toBe(true);

      engine.handleUserInterrupt('Q');
      engine.handleEndDiscussion();
      expect(engine.hasPendingLectureCompletion()).toBe(true);
      engine.continuePlayback();
      await flushPromises();
      expect(callbacks.onComplete).toHaveBeenCalledOnce();
      expect(engine.getMode()).toBe('idle');
    });
  });

  describe('lowerHand', () => {
    it('withdraws a waiting hand; the lecture plays on', async () => {
      const { engine, fireEnded, callbacks, spoken } = setup([speech('a'), speech('b')]);
      engine.start();
      await flushPromises();
      engine.raiseHand();

      expect(engine.lowerHand()).toBe(true);
      expect(engine.getHandState()).toBeNull();
      expect(engine.hasQueuedInterrupt()).toBe(false);
      expect(engine.lowerHand()).toBe(false);

      fireEnded();
      await flushPromises();
      expect(callbacks.onHandCalled).not.toHaveBeenCalled();
      expect(engine.getMode()).toBe('playing');
      expect(spoken()).toEqual(['a', 'b']);
      engine.stop();
    });

    it.each([true, false])('resumes at the next action once called (audio: %s)', async (audio) => {
      vi.useFakeTimers();
      const { engine, fireEnded, player, spoken } = setup(
        [speech('a', 'First line.'), speech('b', 'Second line.')],
        { audio },
      );
      engine.start();
      await flushPromises();
      engine.raiseHand();
      if (audio) fireEnded();
      await vi.advanceTimersByTimeAsync(20000);
      expect(engine.getHandState()).toBe('called');

      expect(engine.lowerHand()).toBe(true);
      await flushPromises();
      expect(engine.getMode()).toBe('playing');
      expect(engine.getHandState()).toBeNull();
      // The finished line's audio was dropped, not resumed
      expect(player.resume).not.toHaveBeenCalled();
      expect(spoken()).toEqual(['First line.', 'Second line.']);
      expect(engine.lowerHand()).toBe(false);
      engine.stop();
    });

    it('completes the lecture when called after the last line', async () => {
      const { engine, fireEnded, callbacks } = setup([speech('a')]);
      engine.start();
      await flushPromises();
      engine.raiseHand();
      fireEnded();
      await flushPromises();

      engine.lowerHand();
      await flushPromises();
      expect(callbacks.onComplete).toHaveBeenCalledOnce();
      expect(engine.getMode()).toBe('idle');
      expect(engine.hasPendingLectureCompletion()).toBe(false);
    });

    it('a play/resume while called also ends the call', async () => {
      const { engine, fireEnded, spoken } = setup([speech('a'), speech('b')]);
      engine.start();
      await flushPromises();
      engine.raiseHand();
      fireEnded();
      await flushPromises();

      engine.resume();
      await flushPromises();
      expect(engine.getHandState()).toBeNull();
      expect(spoken()).toEqual(['a', 'b']);
      engine.stop();
    });
  });

  describe('attachQuestion', () => {
    it('upgrades a waiting hand to a question delivered at the same boundary', async () => {
      const { engine, fireEnded, callbacks } = setup([speech('a'), speech('b')]);
      engine.start();
      await flushPromises();
      expect(engine.attachQuestion('nothing raised')).toBe(false);
      engine.raiseHand();

      expect(engine.attachQuestion('Q')).toBe(true);
      expect(engine.getHandState()).toBeNull();
      expect(engine.hasQueuedInterrupt()).toBe(true);
      // Now a question: it neither takes a second question nor is a hand
      expect(engine.attachQuestion('again')).toBe(false);
      expect(engine.lowerHand()).toBe(false);

      fireEnded();
      await flushPromises();
      expect(callbacks.onUserInterrupt).toHaveBeenCalledExactlyOnceWith('Q');
      expect(callbacks.onHandCalled).not.toHaveBeenCalled();
      expect(engine.getMode()).toBe('live');
      engine.handleEndDiscussion();
      expect(engine.getSnapshot().actionIndex).toBe(1);
    });

    it('gives the upgraded text back on cancel', async () => {
      const { engine } = setup([speech('a'), speech('b')]);
      engine.start();
      await flushPromises();
      engine.raiseHand();
      engine.attachQuestion('Q');
      expect(engine.cancelQueuedInterrupt()).toBe('Q');
      engine.stop();
    });
  });

  describe('flush on pause', () => {
    it('calls the learner immediately, mid-line', async () => {
      const { engine, callbacks, player, audio } = setup([speech('a'), speech('b')]);
      engine.start();
      await flushPromises();
      audio.currentTime = 1000;
      engine.raiseHand();

      expect(engine.flushQueuedInterrupt()).toBe(true);
      expect(engine.getMode()).toBe('paused');
      expect(engine.getHandState()).toBe('called');
      expect(player.pause).toHaveBeenCalledOnce();
      expect(callbacks.onHandCalled).toHaveBeenCalledExactlyOnceWith({ atBoundary: false });
      expect(callbacks.onUserInterrupt).not.toHaveBeenCalled();
      expect(engine.flushQueuedInterrupt()).toBe(false);
    });

    it('a question then replays the cut line', async () => {
      const { engine } = setup([speech('a'), speech('b')]);
      engine.start();
      await flushPromises();
      engine.raiseHand();
      engine.flushQueuedInterrupt();

      engine.handleUserInterrupt('Q');
      engine.handleEndDiscussion();
      expect(engine.getSnapshot().actionIndex).toBe(0);
    });

    it('lowering the hand continues the cut line where it paused', async () => {
      const { engine, fireEnded, player, spoken } = setup([speech('a'), speech('b')]);
      engine.start();
      await flushPromises();
      engine.raiseHand();
      engine.flushQueuedInterrupt();

      engine.lowerHand();
      expect(engine.getMode()).toBe('playing');
      expect(player.resume).toHaveBeenCalledOnce();
      fireEnded();
      await flushPromises();
      expect(spoken()).toEqual(['a', 'b']);
      engine.stop();
    });
  });

  describe('raised while paused or idle', () => {
    it('calls the learner at once while paused; a question replays the cut line', async () => {
      const { engine, callbacks } = setup([speech('a'), speech('b')]);
      engine.start();
      await flushPromises();
      engine.pause();

      expect(engine.raiseHand()).toBe(true);
      expect(engine.getMode()).toBe('paused');
      expect(engine.getHandState()).toBe('called');
      expect(callbacks.onHandCalled).toHaveBeenCalledExactlyOnceWith({ atBoundary: false });

      engine.handleUserInterrupt('Q');
      engine.handleEndDiscussion();
      expect(engine.getSnapshot().actionIndex).toBe(0);
    });

    it('calls a hand that waited through an engine pause', async () => {
      const { engine, callbacks } = setup([speech('a'), speech('b')]);
      engine.start();
      await flushPromises();
      engine.raiseHand();
      engine.pause();
      expect(engine.getHandState()).toBe('raised');

      expect(engine.raiseHand()).toBe(true);
      expect(engine.getHandState()).toBe('called');
      expect(engine.hasQueuedInterrupt()).toBe(false);
      expect(callbacks.onHandCalled).toHaveBeenCalledOnce();
    });

    it('calls the learner at once while idle; lowering it stays idle', async () => {
      const { engine, callbacks } = setup([speech('a'), speech('b')]);
      expect(engine.raiseHand()).toBe(true);
      expect(engine.getMode()).toBe('idle');
      expect(engine.getHandState()).toBe('called');
      expect(callbacks.onHandCalled).toHaveBeenCalledExactlyOnceWith({ atBoundary: false });

      expect(engine.lowerHand()).toBe(true);
      expect(engine.getMode()).toBe('idle');
      expect(engine.getHandState()).toBeNull();
      expect(callbacks.onSpeechStart).not.toHaveBeenCalled();
    });

    it('start() after an idle call ends it', () => {
      const { engine } = setup([speech('a')]);
      engine.raiseHand();
      engine.start();
      expect(engine.getHandState()).toBeNull();
      engine.stop();
    });
  });

  describe('refusals', () => {
    it('refuses in a live Q&A, while called, and while something already waits', async () => {
      const { engine, fireEnded } = setup([speech('a'), speech('b'), speech('c')]);
      engine.start();
      await flushPromises();

      expect(engine.raiseHand()).toBe(true);
      expect(engine.raiseHand()).toBe(false);
      engine.lowerHand();

      engine.queueUserInterrupt('Q');
      expect(engine.raiseHand()).toBe(false);
      engine.pause();
      // A question waiting through a pause keeps its turn
      expect(engine.raiseHand()).toBe(false);
      engine.resume();
      fireEnded();
      await flushPromises();
      expect(engine.getMode()).toBe('live');
      expect(engine.raiseHand()).toBe(false);

      // A paused discussion is still a Q&A
      engine.pause();
      expect(engine.raiseHand()).toBe(false);
    });

    it('refuses a second raise once called', async () => {
      const { engine, callbacks } = setup([speech('a')]);
      engine.start();
      await flushPromises();
      engine.pause();
      engine.raiseHand();
      expect(engine.raiseHand()).toBe(false);
      expect(callbacks.onHandCalled).toHaveBeenCalledOnce();
    });
  });

  describe('resets', () => {
    const raiseAndCall = async (ctx: ReturnType<typeof setup>) => {
      ctx.engine.start();
      await flushPromises();
      ctx.engine.raiseHand();
      ctx.fireEnded();
      await flushPromises();
      expect(ctx.engine.getHandState()).toBe('called');
    };
    const raiseOnly = async (ctx: ReturnType<typeof setup>) => {
      ctx.engine.start();
      await flushPromises();
      ctx.engine.raiseHand();
      expect(ctx.engine.getHandState()).toBe('raised');
    };

    it.each([
      ['waiting', raiseOnly],
      ['called', raiseAndCall],
    ])('stop() clears a %s hand', async (_label, raise) => {
      const ctx = setup([speech('a'), speech('b')]);
      await raise(ctx);
      ctx.engine.stop();
      expect(ctx.engine.getHandState()).toBeNull();
      expect(ctx.engine.hasQueuedInterrupt()).toBe(false);

      // A later question is not mistaken for one asked at a boundary
      ctx.engine.start();
      await flushPromises();
      ctx.engine.pause();
      ctx.engine.handleUserInterrupt('Q');
      ctx.engine.handleEndDiscussion();
      expect(ctx.engine.getSnapshot().actionIndex).toBe(0);
    });

    it.each([
      ['waiting', raiseOnly],
      ['called', raiseAndCall],
    ])('jumpToAction() clears a %s hand', async (_label, raise) => {
      const ctx = setup([speech('a'), speech('b'), speech('c')]);
      await raise(ctx);
      const calls = ctx.callbacks.onHandCalled.mock.calls.length;
      expect(await ctx.engine.jumpToAction(2, { autoplay: false })).toBe(true);
      expect(ctx.engine.getHandState()).toBeNull();
      expect(ctx.engine.hasQueuedInterrupt()).toBe(false);

      ctx.engine.resume();
      await flushPromises();
      ctx.fireEnded();
      await flushPromises();
      // No stale hand is called at the jumped-to line's boundary
      expect(ctx.callbacks.onHandCalled).toHaveBeenCalledTimes(calls);
      expect(ctx.engine.getMode()).toBe('idle');
      expect(ctx.spoken().at(-1)).toBe('c');
      ctx.engine.stop();
    });

    it.each([
      ['waiting', raiseOnly],
      ['called', raiseAndCall],
    ])('restoreFromSnapshot() clears a %s hand', async (_label, raise) => {
      const ctx = setup([speech('a'), speech('b')]);
      await raise(ctx);
      ctx.engine.restoreFromSnapshot({ sceneIndex: 0, actionIndex: 0, consumedDiscussions: [] });
      expect(ctx.engine.getHandState()).toBeNull();
      expect(ctx.engine.hasQueuedInterrupt()).toBe(false);
      ctx.engine.stop();
    });
  });

  describe('a raised hand outranks a pending discussion', () => {
    it('jumps ahead of the card delay and re-offers the discussion when lowered', async () => {
      vi.useFakeTimers();
      const { engine, fireEnded, callbacks, lastProgress } = setup([
        speech('a'),
        discussion('d'),
        speech('b'),
      ]);
      engine.start();
      await flushPromises();
      fireEnded();
      await flushPromises();

      // Waiting on the 3s trigger delay: the hand is called right away
      expect(engine.raiseHand()).toBe(true);
      expect(engine.getMode()).toBe('paused');
      expect(engine.getHandState()).toBe('called');
      expect(callbacks.onHandCalled).toHaveBeenCalledExactlyOnceWith({
        atBoundary: true,
        deferredDiscussion: expect.objectContaining({ id: 'd', agentId: 'agent-1' }),
      });
      expect(lastProgress()).toEqual([
        expect.objectContaining({ actionIndex: 1 }),
        { atBoundary: true },
      ]);
      await vi.advanceTimersByTimeAsync(5000);
      expect(callbacks.onProactiveShow).not.toHaveBeenCalled();
      expect(engine.getSnapshot().consumedDiscussions).not.toContain('d');

      engine.lowerHand();
      await vi.advanceTimersByTimeAsync(4000);
      expect(callbacks.onProactiveShow).toHaveBeenCalledOnce();
      expect(callbacks.onProactiveShow.mock.calls[0][0].id).toBe('d');
      engine.stop();
    });

    it.each(['playing', 'paused'] as const)(
      'withdraws a shown card unconsumed and re-offers it after the Q&A (%s)',
      async (mode) => {
        vi.useFakeTimers();
        const { engine, fireEnded, callbacks } = setup([speech('a'), discussion('d')]);
        engine.start();
        await flushPromises();
        fireEnded();
        await vi.advanceTimersByTimeAsync(4000);
        expect(callbacks.onProactiveShow).toHaveBeenCalledOnce();
        if (mode === 'paused') engine.pause();

        expect(engine.raiseHand()).toBe(true);
        expect(callbacks.onProactiveHide).toHaveBeenCalled();
        expect(callbacks.onHandCalled.mock.calls[0][0].deferredDiscussion?.id).toBe('d');
        expect(engine.getSnapshot().consumedDiscussions).not.toContain('d');

        // A stale "Join" can't consume it while the learner holds the floor
        engine.confirmDiscussion();
        expect(callbacks.onDiscussionConfirmed).not.toHaveBeenCalled();

        engine.handleUserInterrupt('Q');
        engine.handleEndDiscussion();
        expect(engine.getSnapshot().actionIndex).toBe(1);
        engine.continuePlayback();
        await vi.advanceTimersByTimeAsync(4000);
        expect(callbacks.onProactiveShow).toHaveBeenCalledTimes(2);
        engine.stop();
      },
    );

    it('re-offers the same trigger, so the agent named for the deferred card carries over', async () => {
      vi.useFakeTimers();
      const { engine, fireEnded, callbacks } = setup([
        speech('a'),
        { id: 'd', type: 'discussion', topic: 'topic-d' } as unknown as DiscussionAction,
        discussion('e'),
      ]);
      // The UI picks an agent when the card shows (onProactiveShow) or, for a
      // card still in its delay, when the hand is called
      callbacks.onProactiveShow.mockImplementation((trigger) => {
        trigger.agentId ??= 'picked-on-show';
      });
      callbacks.onHandCalled.mockImplementation(({ deferredDiscussion }) => {
        if (deferredDiscussion && !deferredDiscussion.agentId) {
          deferredDiscussion.agentId = 'picked-on-call';
        }
      });
      engine.start();
      await flushPromises();
      fireEnded();
      await flushPromises();

      engine.raiseHand();
      const deferred = callbacks.onHandCalled.mock.calls[0][0].deferredDiscussion;
      expect(deferred).toMatchObject({ id: 'd', agentId: 'picked-on-call' });

      engine.lowerHand();
      await vi.advanceTimersByTimeAsync(4000);
      expect(callbacks.onProactiveShow).toHaveBeenCalledOnce();
      expect(callbacks.onProactiveShow.mock.calls[0][0]).toBe(deferred);

      // The re-offered card is the one confirmed
      engine.confirmDiscussion();
      expect(callbacks.onDiscussionConfirmed).toHaveBeenCalledWith(
        'topic-d',
        undefined,
        'picked-on-call',
      );
      engine.stop();
    });

    it('keeps the agent picked for a shown card across a Q&A', async () => {
      vi.useFakeTimers();
      const { engine, fireEnded, callbacks } = setup([
        speech('a'),
        { id: 'd', type: 'discussion', topic: 'topic-d' } as unknown as DiscussionAction,
      ]);
      let picks = 0;
      callbacks.onProactiveShow.mockImplementation((trigger) => {
        trigger.agentId ??= `pick-${++picks}`;
      });
      engine.start();
      await flushPromises();
      fireEnded();
      await vi.advanceTimersByTimeAsync(4000);
      expect(callbacks.onProactiveShow.mock.calls[0][0].agentId).toBe('pick-1');

      engine.raiseHand();
      expect(callbacks.onHandCalled.mock.calls[0][0].deferredDiscussion?.agentId).toBe('pick-1');
      engine.handleUserInterrupt('Q');
      engine.handleEndDiscussion();
      engine.continuePlayback();
      await vi.advanceTimersByTimeAsync(4000);
      expect(callbacks.onProactiveShow).toHaveBeenCalledTimes(2);
      expect(callbacks.onProactiveShow.mock.calls[1][0].agentId).toBe('pick-1');
      engine.stop();
    });

    it('drops a deferred trigger on stop, so a replay picks afresh', async () => {
      vi.useFakeTimers();
      const { engine, fireEnded, callbacks } = setup([
        speech('a'),
        { id: 'd', type: 'discussion', topic: 'topic-d' } as unknown as DiscussionAction,
      ]);
      callbacks.onHandCalled.mockImplementation(({ deferredDiscussion }) => {
        if (deferredDiscussion) deferredDiscussion.agentId = 'picked-on-call';
      });
      engine.start();
      await flushPromises();
      fireEnded();
      await flushPromises();
      engine.raiseHand();
      engine.stop();

      engine.start();
      await flushPromises();
      fireEnded();
      await vi.advanceTimersByTimeAsync(4000);
      expect(callbacks.onProactiveShow).toHaveBeenCalledOnce();
      expect(callbacks.onProactiveShow.mock.calls[0][0].agentId).toBeUndefined();
      engine.stop();
    });
  });

  describe('getSpeechProgress', () => {
    it('follows the audio position and is null without a spoken line in flight', async () => {
      const { engine, audio, fireEnded } = setup([
        speech('a'),
        { id: 's', type: 'wb_open' } as Action,
        speech('b'),
      ]);
      expect(engine.getSpeechProgress()).toBeNull();
      engine.start();
      await flushPromises();
      audio.duration = 8000;
      audio.currentTime = 2000;
      expect(engine.getSpeechProgress()).toBe(0.25);

      // Frozen while paused
      engine.pause();
      expect(engine.getSpeechProgress()).toBe(0.25);
      engine.resume();

      engine.raiseHand();
      fireEnded();
      await flushPromises();
      // Called: no line in flight any more
      expect(engine.getSpeechProgress()).toBeNull();
    });

    it('follows the reading timer, frozen while paused', async () => {
      vi.useFakeTimers();
      const text = 'A fairly long first line to read.';
      const total = estimateSpeechDurationMs(text, { speed: 1 });
      const { engine } = setup([speech('a', text), speech('b')], { audio: false });
      engine.start();
      await flushPromises();
      expect(engine.getSpeechProgress()).toBe(0);

      await vi.advanceTimersByTimeAsync(total / 2);
      expect(engine.getSpeechProgress()).toBeCloseTo(0.5, 2);

      engine.pause();
      await vi.advanceTimersByTimeAsync(total);
      expect(engine.getSpeechProgress()).toBeCloseTo(0.5, 2);

      engine.resume();
      await vi.advanceTimersByTimeAsync(total / 4);
      expect(engine.getSpeechProgress()).toBeCloseTo(0.75, 2);
      engine.stop();
      expect(engine.getSpeechProgress()).toBeNull();
    });

    it('counts browser-TTS chunks, across a pause', async () => {
      const utterances = stubBrowserTTS();
      const { engine } = setup([speech('a', 'One. Two. Three. Four.'), speech('b')], {
        audio: false,
      });
      engine.start();
      await flushPromises();
      expect(utterances).toHaveLength(1);
      expect(engine.getSpeechProgress()).toBe(0);

      utterances[0].onend?.();
      await flushPromises();
      expect(engine.getSpeechProgress()).toBe(0.25);

      // Resuming re-speaks only the remaining chunks; progress keeps counting
      engine.pause();
      expect(engine.getSpeechProgress()).toBe(0.25);
      engine.resume();
      await flushPromises();
      expect(engine.getSpeechProgress()).toBe(0.25);
      utterances.at(-1)?.onend?.();
      await flushPromises();
      expect(engine.getSpeechProgress()).toBe(0.5);
      engine.stop();
    });

    it('follows the reading timer after an audio line, not the ended clip', async () => {
      vi.useFakeTimers();
      const text = 'A line whose narration failed to generate.';
      const total = estimateSpeechDurationMs(text, { speed: 1 });
      const { engine, audio, player, fireEnded, spoken } = setup([
        speech('a'),
        speech('b', text),
        speech('c'),
      ]);
      engine.start();
      await flushPromises();
      audio.duration = 8000;
      audio.currentTime = 8000;
      // Like the real player: no audio for the next line returns false before
      // the ended element is dropped
      player.play.mockImplementation(async () => false);
      fireEnded();
      await flushPromises();
      expect(audio.active).toBe(true);
      expect(spoken()).toEqual(['a', text]);
      expect(engine.getSpeechProgress()).toBe(0);

      await vi.advanceTimersByTimeAsync(total / 2);
      expect(engine.getSpeechProgress()).toBeCloseTo(0.5, 2);
      engine.pause();
      expect(engine.getSpeechProgress()).toBeCloseTo(0.5, 2);

      // Resuming reschedules the timer instead of replaying the ended clip
      engine.resume();
      expect(player.resume).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(total / 4);
      expect(engine.getSpeechProgress()).toBeCloseTo(0.75, 2);
      await vi.advanceTimersByTimeAsync(total);
      expect(spoken()).toEqual(['a', text, 'c']);
      engine.stop();
    });

    it("reads 0, not the previous line's ended clip, until the next audio starts", async () => {
      const { engine, audio, player, fireEnded } = setup([speech('a'), speech('b')]);
      engine.start();
      await flushPromises();
      audio.duration = 8000;
      audio.currentTime = 8000;
      expect(engine.getSpeechProgress()).toBe(1);

      let startAudio: (started: boolean) => void = () => {};
      player.play.mockImplementation(
        () =>
          new Promise<boolean>((resolve) => {
            startAudio = resolve;
          }),
      );
      fireEnded();
      await flushPromises();
      // Line b is in flight while its bytes resolve; the element is still a's
      expect(engine.getSpeechProgress()).toBe(0);

      audio.currentTime = 0;
      startAudio(true);
      await flushPromises();
      audio.currentTime = 2000;
      expect(engine.getSpeechProgress()).toBe(0.25);
      engine.stop();
    });
  });
});
