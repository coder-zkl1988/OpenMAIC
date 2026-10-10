import { describe, expect, it, vi } from 'vitest';

import { PlaybackEngine } from '@/lib/playback/engine';
import type { Action } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';
import type { ActionEngine } from '@/lib/action/engine';
import type { AudioPlayer } from '@/lib/utils/audio-player';

/**
 * Lecture actions carry no agent of their own. The engine names the lecture's
 * narrator (getLectureAgentId) when it executes them, so the whiteboard's
 * "… is drawing" chip shows who draws instead of guessing.
 */

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

const drawText = { id: 'wb-1', type: 'wb_draw_text', content: 'E = mc²' } as unknown as Action;

function createActionEngine() {
  return {
    execute: vi.fn(async () => {}),
    clearEffects: vi.fn(),
    resetPlaybackVisualState: vi.fn(),
  };
}

function createAudioPlayer(): AudioPlayer {
  return {
    play: vi.fn(async () => false),
    onEnded: vi.fn(),
    stop: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    isPlaying: vi.fn(() => false),
    hasActiveAudio: vi.fn(() => false),
  } as unknown as AudioPlayer;
}

async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('lecture whiteboard actions name their performer', () => {
  it('passes the lecture agent id to ActionEngine.execute', async () => {
    const actionEngine = createActionEngine();
    const engine = new PlaybackEngine(
      [scene([drawText])],
      actionEngine as unknown as ActionEngine,
      createAudioPlayer(),
      { getLectureAgentId: () => 'teacher-agent' },
    );

    engine.start();
    await flush();

    expect(actionEngine.execute).toHaveBeenCalledWith(drawText, { agentId: 'teacher-agent' });
  });

  it('passes null when the host does not name one (the chip falls back to the teacher)', async () => {
    const actionEngine = createActionEngine();
    const engine = new PlaybackEngine(
      [scene([drawText])],
      actionEngine as unknown as ActionEngine,
      createAudioPlayer(),
    );

    engine.start();
    await flush();

    expect(actionEngine.execute).toHaveBeenCalledWith(drawText, { agentId: null });
  });
});
