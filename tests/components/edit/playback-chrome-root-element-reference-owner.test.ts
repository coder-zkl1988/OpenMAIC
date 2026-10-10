// @vitest-environment jsdom

import { act, createElement, createRef } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  /** Agents the registry knows by id (getAgent) */
  registryAgents: {} as Record<string, { name: string }>,
  sendMessage: vi.fn(),
  whiteboardOpen: false,
  /** Who is drawing on the board (canvasStore.whiteboardDrawing) */
  whiteboardDrawing: null as { agentId?: string } | null,
  runtimeProjection: null as {
    stageId: string;
    lastSeq: number | null;
    whiteboard: import('@/lib/types/stage').Whiteboard | null;
  } | null,
  // The fullscreen dock (mounted only while presenting) and its handle
  presentationDockProps: undefined as Record<string, unknown> | undefined,
  dockOpenText: vi.fn(),
  dockToggleVoice: vi.fn(),
  dockContinueText: vi.fn(),
  dockClose: vi.fn(),
  dockShowUserMessage: vi.fn(),
  dockCloseAfterSend: vi.fn(),
  // How many times the (one) composer mounted
  composerMounts: 0,
  // The interaction panel's composer, participants and inline discussion card
  composerProps: undefined as Record<string, unknown> | undefined,
  participantsProps: undefined as Record<string, unknown> | undefined,
  proactiveProps: undefined as Record<string, unknown> | undefined,
  canvasProps: undefined as Record<string, unknown> | undefined,
  controlBarProps: undefined as Record<string, unknown> | undefined,
  captionProps: undefined as Record<string, unknown> | undefined,
  piEnabled: true,
  coursewareReferenceEnabled: true,
  topicActive: false,
  engineMode: 'idle' as 'idle' | 'playing' | 'paused' | 'live',
  engineOptions: undefined as
    | {
        onModeChange?: (mode: 'idle' | 'playing' | 'paused' | 'live') => void;
        onProgress?: (
          snapshot: { actionIndex: number; sceneId: string },
          progress?: { atBoundary?: boolean },
        ) => void;
        onUserInterrupt?: (text: string) => void;
        onHandCalled?: (call: {
          atBoundary: boolean;
          deferredDiscussion?: { id: string; question: string; agentId?: string };
        }) => void;
        onComplete?: () => void;
        onDiscussionEnd?: () => void;
      }
    | undefined,
  startLecture: vi.fn(),
  pauseBuffer: vi.fn(),
  endSession: vi.fn(),
  engineStop: vi.fn(),
  engineStart: vi.fn(),
  engineContinuePlayback: vi.fn(),
  handleUserInterrupt: vi.fn(),
  // Raised hand: the fake engine's queued slot and its spies
  queuedText: null as string | null,
  queueUserInterrupt: vi.fn(),
  // The engine refuses to queue (waiting on a discussion trigger)
  queueRefused: false,
  // A bare raised hand (engine getHandState) and its spies
  handState: null as 'raised' | 'called' | null,
  raiseHand: vi.fn(),
  lowerHand: vi.fn(),
  attachQuestion: vi.fn(),
  engineResume: vi.fn(),
  cancelQueuedInterrupt: vi.fn(),
  flushQueuedInterrupt: vi.fn(),
  enginePause: vi.fn(),
  lectureCompletionPending: false,
  engineExhausted: false,
  // Whether a spoken line is in flight when a hand is raised
  speechInFlight: true,
  engineCanJumpToAction: vi.fn((_actionIndex: number, _options?: unknown) => false),
  engineJumpToAction: vi.fn(async (_actionIndex: number, _options?: unknown) => false),
  // Run the real action-resume / action-navigation helpers on jsdom sessionStorage
  realActionResume: false,
  shouldAutoResume: vi.fn((_args: unknown) => false),
  lastSendResult: undefined as unknown,
  chatAreaProps: undefined as Record<string, unknown> | undefined,
  openTextInput: vi.fn(),
  focusComposer: vi.fn(),
  toggleVoice: vi.fn(),
  dismissComposer: vi.fn(),
  toggleHand: vi.fn(),
  switchToTab: vi.fn(),
  confirmDiscussion: vi.fn(),
  skipDiscussion: vi.fn(),
}));

const textElement = {
  id: 'text-1',
  type: 'text',
  content: '<p>First grounded fact</p>',
  defaultFontName: 'Arial',
  defaultColor: '#000',
  left: 0,
  top: 0,
  width: 100,
  height: 40,
  rotate: 0,
};
const shapeElement = {
  id: 'shape-1',
  type: 'shape',
  viewBox: [100, 100],
  path: 'M0 0',
  fixedRatio: false,
  fill: '#fff',
  left: 0,
  top: 0,
  width: 100,
  height: 40,
  rotate: 0,
};
const scene = {
  id: 'scene-1',
  stageId: 'stage-1',
  title: 'Slide',
  order: 0,
  type: 'slide',
  actions: [],
  content: {
    type: 'slide',
    canvas: { elements: [textElement, shapeElement] },
  },
};
const secondScene = {
  ...scene,
  id: 'scene-2',
  title: 'Second slide',
  order: 1,
};
const interactiveScene = {
  id: 'scene-interactive',
  stageId: 'stage-1',
  title: 'Projectile simulation',
  order: 0,
  type: 'interactive',
  actions: [],
  content: {
    type: 'interactive',
    widgetType: 'simulation',
    html: '<label for="angle-slider">Angle</label><input id="angle-slider" type="range" min="0" max="90" value="45">',
  },
};

const stageState = {
  mode: 'playback',
  stage: { id: 'stage-1', whiteboard: [] as import('@/lib/types/stage').Whiteboard[] },
  getCurrentScene: () =>
    stageState.scenes.find((candidate) => candidate.id === stageState.currentSceneId),
  scenes: [scene, secondScene] as Array<typeof scene | typeof interactiveScene>,
  currentSceneId: scene.id,
  setCurrentSceneId: vi.fn((sceneId: string) => {
    stageState.currentSceneId = sceneId;
  }),
  generatingOutlines: [],
  outlines: [],
};

vi.mock('@/lib/store', () => {
  const useStageStore = Object.assign(() => stageState, {
    use: {
      failedOutlines: () => [],
      generationComplete: () => true,
      generationInterrupted: () => false,
    },
    getState: () => stageState,
  });
  return { useStageStore };
});

vi.mock('@/lib/store/canvas', () => ({
  useCanvasStore: {
    use: {
      whiteboardOpen: () => mocks.whiteboardOpen,
      whiteboardDrawing: () => mocks.whiteboardDrawing,
      runtimeWhiteboardProjection: () => mocks.runtimeProjection,
      whiteboardClearing: () => false,
      setWhiteboardOpenManually: () => (open: boolean) => {
        mocks.whiteboardOpen = open;
      },
    },
    getState: () => ({
      whiteboardOpen: mocks.whiteboardOpen,
      whiteboardDrawing: mocks.whiteboardDrawing,
      runtimeWhiteboardProjection: mocks.runtimeProjection,
      whiteboardClearing: false,
    }),
  },
}));

const settingsState = {
  sidebarCollapsed: false,
  setSidebarCollapsed: vi.fn(),
  chatAreaWidth: 320,
  setChatAreaWidth: vi.fn(),
  chatAreaCollapsed: false,
  setChatAreaCollapsed: vi.fn(),
  setTTSMuted: vi.fn(),
  setTTSVolume: vi.fn(),
  selectedAgentIds: [],
  ttsMuted: false,
  ttsEnabled: false,
  ttsVolume: 1,
  playbackSpeed: 1,
  autoPlayLecture: false,
};
vi.mock('@/lib/store/settings', () => ({
  useSettingsStore: Object.assign(
    (selector: (state: typeof settingsState) => unknown) => selector(settingsState),
    { getState: () => settingsState },
  ),
}));

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) => {
      if (key === 'chat.lectureNotes.pageLabel') return `Page ${options?.n}`;
      const summaries: Record<string, string> = {
        'chat.elementReference.summary.noText': 'No text',
        'chat.elementReference.summary.emptyContent': 'No content',
        'chat.elementReference.summary.code': 'Code',
        'chat.elementReference.summary.line': 'Line',
        'chat.elementReference.summary.imageMetadata': 'Image (metadata only)',
        'chat.elementReference.summary.videoMetadata': 'Video (metadata only)',
        'chat.elementReference.summary.audioMetadata': 'Audio (metadata only)',
        'edit.element.text': 'Text',
        'edit.element.image': 'Image',
        'edit.element.shape': 'Shape',
        'edit.element.line': 'Line',
        'edit.element.chart': 'Chart',
        'edit.element.table': 'Table',
        'edit.element.latex': 'Formula',
        'edit.element.video': 'Video',
        'edit.element.audio': 'Audio',
        'edit.element.code': 'Code',
        'edit.sceneType.interactive': 'Interactive',
      };
      return summaries[key] ?? key;
    },
  }),
}));

vi.mock('@/components/stage/scene-sidebar', () => ({ SceneSidebar: () => null }));
vi.mock('@/components/header', () => ({ Header: () => null }));
vi.mock('@/components/canvas/canvas-area', async () => {
  const React = await import('react');
  return {
    CanvasArea: (props: Record<string, unknown>) => {
      mocks.canvasProps = props;
      return React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'pick-text',
          onClick: () =>
            (props.onPickElement as ((element: unknown) => void) | undefined)?.(textElement),
        },
        'pick text',
      );
    },
  };
});
// The fullscreen dock: its handle, and the card that adopts the composer's slot
vi.mock('@/components/classroom/presentation-dock', async () => {
  const React = await import('react');
  return {
    PresentationDock: (props: Record<string, unknown>) => {
      mocks.presentationDockProps = props;
      React.useImperativeHandle(props.dockRef as React.Ref<unknown>, () => ({
        openText: mocks.dockOpenText,
        toggleVoice: mocks.dockToggleVoice,
        continueText: mocks.dockContinueText,
        close: mocks.dockClose,
        showUserMessage: mocks.dockShowUserMessage,
        closeAfterSend: mocks.dockCloseAfterSend,
      }));
      return React.createElement(
        'div',
        { 'data-testid': 'presentation-dock' },
        props.composerSlot as React.ReactNode,
      );
    },
  };
});
// The panel composer: a send button and the reference chip it shows
vi.mock('@/components/classroom/interaction/composer', async () => {
  const React = await import('react');
  return {
    Composer: (props: Record<string, unknown>) => {
      mocks.composerProps = props;
      React.useEffect(() => {
        mocks.composerMounts += 1;
      }, []);
      React.useImperativeHandle(props.composerRef as React.Ref<unknown>, () => ({
        openTextInput: mocks.openTextInput,
        focus: mocks.focusComposer,
        toggleVoice: mocks.toggleVoice,
        dismiss: mocks.dismissComposer,
        toggleHand: mocks.toggleHand,
      }));
      const pill = props.elementReferencePill as
        | { sceneLabel: string; displaySummary: string; elementType: string }
        | undefined;
      return React.createElement(
        'div',
        null,
        React.createElement(
          'button',
          {
            type: 'button',
            'data-testid': 'send',
            onClick: () => {
              mocks.lastSendResult = (
                props.onMessageSend as ((message: string) => unknown) | undefined
              )?.('Explain this');
            },
          },
          'send',
        ),
        pill
          ? React.createElement(
              'div',
              { 'data-testid': 'owner-pill' },
              `${pill.sceneLabel} · ${pill.elementType} · ${pill.displaySummary}`,
            )
          : null,
      );
    },
  };
});
vi.mock('@/components/classroom/interaction/participants', () => ({
  Participants: (props: Record<string, unknown>) => {
    mocks.participantsProps = props;
    return null;
  },
}));
vi.mock('@/components/chat/proactive-card', () => ({
  ProactiveCard: (props: Record<string, unknown>) => {
    mocks.proactiveProps = props;
    return null;
  },
}));
// The shell-owned control bar: the "Reference content" entry, prev / next and play
vi.mock('@/components/classroom/control-bar', async () => {
  const React = await import('react');
  return {
    ControlBar: (props: Record<string, unknown>) => {
      mocks.controlBarProps = props;
      return props.showElementReference
        ? React.createElement(
            'button',
            {
              type: 'button',
              'data-testid': 'toggle-pick',
              onClick: () => (props.onToggleElementPick as (() => void) | undefined)?.(),
            },
            'toggle pick',
          )
        : null;
    },
  };
});
vi.mock('@/components/classroom/caption-strip', () => ({
  CaptionStrip: (props: Record<string, unknown>) => {
    mocks.captionProps = props;
    return null;
  },
}));
vi.mock('@/components/chat/chat-area', async () => {
  const React = await import('react');
  return {
    ChatArea: React.forwardRef(function MockChatArea(props: Record<string, unknown>, ref) {
      React.useEffect(() => {
        mocks.chatAreaProps = props;
      });
      React.useImperativeHandle(ref, () => ({
        sendMessage: mocks.sendMessage,
        endActiveSession: vi.fn().mockResolvedValue(undefined),
        endSession: mocks.endSession,
        startLecture: mocks.startLecture,
        addLectureMessage: vi.fn(),
        getLectureMessageId: vi.fn(),
        startDiscussion: vi.fn(),
        switchToTab: mocks.switchToTab,
        resumeActiveLiveBuffer: vi.fn(),
        pauseActiveLiveBuffer: vi.fn(),
        stopActiveSession: vi.fn(),
        continueActiveSoftClosingSession: vi.fn(),
        getActiveSessionType: vi.fn(),
        pauseBuffer: mocks.pauseBuffer,
        resumeBuffer: vi.fn(),
        resumeActiveSession: vi.fn(),
      }));
      // The 互动 tab's slots: participants, the inline card, the composer
      return React.createElement(
        React.Fragment,
        null,
        props.header as React.ReactNode,
        props.streamTrailing as React.ReactNode,
        props.footer as React.ReactNode,
      );
    }),
  };
});

vi.mock('@/lib/playback', async () => ({
  // The pure resume rule runs for real: the caption countdown must agree with it
  willResumeAfterSoftClose: (
    await vi.importActual<typeof import('@/lib/playback/auto-resume')>('@/lib/playback/auto-resume')
  ).willResumeAfterSoftClose,
  PlaybackEngine: class {
    constructor(
      _scenes: unknown,
      _actionEngine: unknown,
      _audioPlayer: unknown,
      options: {
        onModeChange?: (mode: 'idle' | 'playing' | 'paused' | 'live') => void;
        onUserInterrupt?: (text: string) => void;
        onComplete?: () => void;
        onDiscussionEnd?: () => void;
      },
    ) {
      mocks.engineOptions = options;
      options.onModeChange?.(mocks.engineMode);
    }
    stop() {
      mocks.queuedText = null;
      mocks.handState = null;
      mocks.engineStop();
    }
    raiseHand() {
      mocks.raiseHand();
      if (mocks.engineMode === 'live' || mocks.handState || mocks.queuedText !== null) return false;
      if (mocks.engineMode === 'playing') {
        mocks.handState = 'raised';
      } else {
        // Paused or idle: called at once
        mocks.handState = 'called';
        mocks.engineOptions?.onHandCalled?.({ atBoundary: false });
      }
      return true;
    }
    attachQuestion(text: string) {
      mocks.attachQuestion(text);
      if (mocks.handState !== 'raised') return false;
      mocks.handState = null;
      mocks.queuedText = text;
      return true;
    }
    lowerHand() {
      mocks.lowerHand();
      if (!mocks.handState) return false;
      const wasCalled = mocks.handState === 'called';
      mocks.handState = null;
      if (wasCalled && mocks.engineMode === 'paused') this.resume();
      return true;
    }
    getHandState() {
      return mocks.handState;
    }
    resume() {
      mocks.engineResume();
      mocks.handState = null;
      mocks.engineMode = 'playing';
      mocks.engineOptions?.onModeChange?.('playing');
    }
    queueUserInterrupt(text: string) {
      mocks.queueUserInterrupt(text);
      if (
        mocks.engineMode !== 'playing' ||
        mocks.queueRefused ||
        mocks.queuedText !== null ||
        mocks.handState !== null
      ) {
        return false;
      }
      mocks.queuedText = text;
      return true;
    }
    hasQueuedInterrupt() {
      return mocks.queuedText !== null;
    }
    cancelQueuedInterrupt() {
      mocks.cancelQueuedInterrupt();
      const text = mocks.queuedText;
      mocks.queuedText = null;
      if (mocks.handState === 'raised') mocks.handState = null;
      return text;
    }
    flushQueuedInterrupt() {
      mocks.flushQueuedInterrupt();
      if (mocks.handState === 'raised') {
        // A bare hand is called now: the engine pauses mid-line
        mocks.handState = 'called';
        mocks.engineMode = 'paused';
        mocks.engineOptions?.onModeChange?.('paused');
        mocks.engineOptions?.onHandCalled?.({ atBoundary: false });
        return true;
      }
      const text = mocks.queuedText;
      if (text === null) return false;
      this.handleUserInterrupt(text);
      return true;
    }
    hasLectureInterruption() {
      return mocks.lectureCompletionPending;
    }
    hasPendingLectureCompletion() {
      return mocks.lectureCompletionPending;
    }
    handleEndDiscussion() {
      mocks.engineOptions?.onDiscussionEnd?.();
    }
    getCurrentSceneId() {
      return 'scene-1';
    }
    getMode() {
      return mocks.engineMode;
    }
    isExhausted() {
      return mocks.engineExhausted;
    }
    getSpeechProgress() {
      return 0.4;
    }
    isSpeechInFlight() {
      return mocks.speechInFlight;
    }
    canJumpToAction(actionIndex: number, options?: unknown) {
      return mocks.engineCanJumpToAction(actionIndex, options);
    }
    jumpToAction(actionIndex: number, options?: unknown) {
      return mocks.engineJumpToAction(actionIndex, options);
    }
    handleUserInterrupt(text: string) {
      mocks.queuedText = null;
      mocks.handState = null;
      mocks.handleUserInterrupt(text);
      mocks.engineOptions?.onUserInterrupt?.(text);
    }
    start() {
      mocks.engineStart();
    }
    continuePlayback() {
      mocks.engineContinuePlayback();
    }
    pause() {
      mocks.enginePause();
    }
    confirmDiscussion() {
      mocks.confirmDiscussion();
    }
    skipDiscussion() {
      mocks.skipDiscussion();
    }
  },
  computePlaybackView: () => ({ kind: 'idle', isTopicActive: mocks.topicActive }),
  shouldAutoResumeLecture: (args: unknown) => mocks.shouldAutoResume(args),
}));
vi.mock('@/lib/playback/action-navigation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/playback/action-navigation')>();
  return {
    canJumpWithinReconstructablePrefix: (
      ...args: Parameters<typeof actual.canJumpWithinReconstructablePrefix>
    ) => mocks.realActionResume && actual.canJumpWithinReconstructablePrefix(...args),
    isUnsafePlaybackNavigationAction: (
      ...args: Parameters<typeof actual.isUnsafePlaybackNavigationAction>
    ) => mocks.realActionResume && actual.isUnsafePlaybackNavigationAction(...args),
  };
});
vi.mock('@/lib/playback/action-resume', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/playback/action-resume')>();
  return {
    getActionResumeRestoreCursor: (
      ...args: Parameters<typeof actual.getActionResumeRestoreCursor>
    ) =>
      mocks.realActionResume
        ? actual.getActionResumeRestoreCursor(...args)
        : { actionIndex: 0, position: null },
    clearActionResumePosition: (...args: Parameters<typeof actual.clearActionResumePosition>) => {
      if (mocks.realActionResume) actual.clearActionResumePosition(...args);
    },
    createActionResumePosition: (...args: Parameters<typeof actual.createActionResumePosition>) =>
      mocks.realActionResume ? actual.createActionResumePosition(...args) : null,
    getActionResumeStorageKey: (...args: Parameters<typeof actual.getActionResumeStorageKey>) =>
      mocks.realActionResume ? actual.getActionResumeStorageKey(...args) : 'resume-key',
    isActionBoundaryResumePositionAt: (
      ...args: Parameters<typeof actual.isActionBoundaryResumePositionAt>
    ) => mocks.realActionResume && actual.isActionBoundaryResumePositionAt(...args),
    readActionResumeState: (...args: Parameters<typeof actual.readActionResumeState>) =>
      mocks.realActionResume ? actual.readActionResumeState(...args) : null,
    saveActionResumePosition: (...args: Parameters<typeof actual.saveActionResumePosition>) => {
      if (mocks.realActionResume) actual.saveActionResumePosition(...args);
    },
  };
});
vi.mock('@/lib/playback/cursor', () => ({
  loadCursor: vi.fn().mockResolvedValue(null),
  saveCursor: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('@/lib/action/engine', () => ({ ActionEngine: class {} }));
vi.mock('@/lib/utils/audio-player', () => ({
  createAudioPlayer: () => ({
    destroy: vi.fn(),
    setMuted: vi.fn(),
    setVolume: vi.fn(),
    setPlaybackRate: vi.fn(),
  }),
}));
vi.mock('@/lib/hooks/use-discussion-tts', () => ({
  useDiscussionTTS: () => ({
    cleanup: vi.fn(),
    pause: vi.fn(),
    resume: vi.fn(),
    handleSegmentSealed: vi.fn(),
    shouldHold: vi.fn(() => false),
  }),
}));
vi.mock('@/lib/store/widget-iframe', () => ({
  useWidgetIframeStore: { getState: () => ({ getSendMessage: () => undefined }) },
}));
vi.mock('@/lib/orchestration/registry/store', () => ({
  agentsToParticipants: () => [],
  useAgentRegistry: Object.assign(
    (selector: (state: { agents: Record<string, unknown> }) => unknown) => selector({ agents: {} }),
    { getState: () => ({ getAgent: (id: string) => mocks.registryAgents[id] }) },
  ),
}));
vi.mock('@/lib/hooks/use-asr-available', () => ({ useASRAvailable: () => true }));
vi.mock('@/lib/config/feature-flags', () => ({
  isPiChatEnabled: () => mocks.piEnabled,
  isCoursewareReferenceEnabled: () => mocks.coursewareReferenceEnabled,
}));

import { toast } from 'sonner';
import {
  PlaybackChromeRoot,
  type PlaybackChromeRootHandle,
} from '@/components/edit/PlaybackChromeRoot';

describe('PlaybackChromeRoot element-reference ownership', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mocks.registryAgents = {};
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    mocks.whiteboardOpen = false;
    mocks.whiteboardDrawing = null;
    mocks.runtimeProjection = null;
    stageState.stage.whiteboard = [];
    mocks.sendMessage.mockReset();
    mocks.sendMessage.mockResolvedValue(undefined);
    mocks.presentationDockProps = undefined;
    mocks.composerMounts = 0;
    for (const spy of [
      mocks.dockOpenText,
      mocks.dockToggleVoice,
      mocks.dockContinueText,
      mocks.dockClose,
      mocks.dockShowUserMessage,
      mocks.dockCloseAfterSend,
    ]) {
      spy.mockReset();
    }
    mocks.composerProps = undefined;
    mocks.participantsProps = undefined;
    mocks.proactiveProps = undefined;
    mocks.focusComposer.mockReset();
    mocks.openTextInput.mockReset();
    mocks.toggleVoice.mockReset();
    mocks.dismissComposer.mockReset();
    mocks.switchToTab.mockReset();
    mocks.confirmDiscussion.mockReset();
    mocks.skipDiscussion.mockReset();
    settingsState.chatAreaCollapsed = false;
    settingsState.setChatAreaCollapsed.mockReset();
    mocks.canvasProps = undefined;
    mocks.controlBarProps = undefined;
    mocks.captionProps = undefined;
    mocks.piEnabled = true;
    mocks.coursewareReferenceEnabled = true;
    mocks.topicActive = false;
    mocks.engineMode = 'idle';
    mocks.engineOptions = undefined;
    mocks.startLecture.mockReset();
    mocks.startLecture.mockResolvedValue('lecture-1');
    mocks.endSession.mockReset();
    mocks.endSession.mockResolvedValue(undefined);
    mocks.engineStop.mockReset();
    mocks.engineStart.mockReset();
    mocks.engineContinuePlayback.mockReset();
    mocks.handleUserInterrupt.mockReset();
    mocks.queuedText = null;
    mocks.queueUserInterrupt.mockReset();
    mocks.queueRefused = false;
    mocks.handState = null;
    mocks.raiseHand.mockReset();
    mocks.lowerHand.mockReset();
    mocks.attachQuestion.mockReset();
    mocks.engineResume.mockReset();
    mocks.toggleHand.mockReset();
    mocks.cancelQueuedInterrupt.mockReset();
    mocks.flushQueuedInterrupt.mockReset();
    mocks.enginePause.mockReset();
    mocks.pauseBuffer.mockReset();
    mocks.lectureCompletionPending = false;
    mocks.engineExhausted = false;
    mocks.speechInFlight = true;
    mocks.engineCanJumpToAction.mockReset();
    mocks.engineCanJumpToAction.mockReturnValue(false);
    mocks.engineJumpToAction.mockReset();
    mocks.engineJumpToAction.mockResolvedValue(false);
    mocks.realActionResume = false;
    window.sessionStorage.clear();
    stageState.mode = 'playback';
    mocks.shouldAutoResume.mockReset();
    mocks.shouldAutoResume.mockReturnValue(false);
    mocks.lastSendResult = undefined;
    mocks.chatAreaProps = undefined;
    stageState.scenes = [scene, secondScene];
    stageState.currentSceneId = scene.id;
    stageState.setCurrentSceneId.mockClear();
    settingsState.autoPlayLecture = false;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.sessionStorage.clear();
    vi.unstubAllGlobals();
  });

  /** Props of the caption strip element passed to the (mocked) canvas */
  function captionElementProps() {
    return (mocks.canvasProps?.caption as { props?: Record<string, unknown> } | null)?.props;
  }

  function click(testId: string) {
    act(() => {
      container
        .querySelector(`[data-testid="${testId}"]`)!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    });
  }

  async function renderOwner(props: Record<string, unknown> = {}) {
    await act(async () => {
      root.render(createElement(PlaybackChromeRoot, props));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  async function rerenderOwner() {
    await act(async () => {
      root.render(createElement(PlaybackChromeRoot));
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  /** Leave the page in-app (route change, Pro mode), then come back. */
  async function remountOwner(props: Record<string, unknown> = {}) {
    act(() => root.unmount());
    root = createRoot(container);
    await renderOwner(props);
  }

  it('selects the stage snapshot whiteboard and sends an identity-only reference', async () => {
    const board = {
      id: 'board',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements: [textElement as import('@openmaic/dsl').PPTElement],
    };
    mocks.whiteboardOpen = true;
    stageState.stage.whiteboard = [board];
    await renderOwner();
    expect(mocks.controlBarProps?.canPickElement).toBe(true);
    click('toggle-pick');
    act(() =>
      (mocks.canvasProps?.onPickWhiteboardElement as (element: unknown) => void)(textElement),
    );
    expect(mocks.canvasProps?.elementPickActive).toBe(false);
    expect(container.querySelector('[data-testid="owner-pill"]')?.textContent).toContain(
      'whiteboard.title · Text · First grounded fact',
    );
    expect((mocks.composerProps?.canSendMessage as () => boolean)()).toBe(true);
    click('send');
    expect(mocks.sendMessage.mock.calls[0][1].elementReference).toEqual({
      kind: 'whiteboard_element',
      whiteboardId: 'board',
      elementId: 'text-1',
    });
    act(() =>
      mocks.sendMessage.mock.calls[0][1].onResponseAccepted(
        new Response('', { headers: { 'X-OpenMAIC-Element-Reference-Accepted': '1' } }),
      ),
    );
    expect(container.querySelector('[data-testid="owner-pill"]')).toBeNull();
  });

  it.each([false, true])(
    'disables selection under runtime authority (already armed: %s)',
    async (alreadyArmed) => {
      const board = {
        id: 'board',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [textElement as import('@openmaic/dsl').PPTElement],
      };
      mocks.whiteboardOpen = true;
      stageState.stage.whiteboard = [board];
      if (alreadyArmed) {
        await renderOwner();
        click('toggle-pick');
        expect(mocks.canvasProps?.elementPickActive).toBe(true);
      }
      mocks.runtimeProjection = { stageId: 'stage-1', lastSeq: 7, whiteboard: board };
      await renderOwner();
      expect(mocks.controlBarProps?.canPickElement).toBe(false);
      click('toggle-pick');
      expect(mocks.canvasProps?.elementPickActive).toBe(false);
      act(() =>
        (mocks.canvasProps?.onPickWhiteboardElement as (element: unknown) => void)(textElement),
      );
      expect(container.querySelector('[data-testid="owner-pill"]')).toBeNull();
    },
  );

  it('keeps a stale whiteboard selection visible and blocks sending until reselected or removed', async () => {
    mocks.whiteboardOpen = true;
    stageState.stage.whiteboard = [
      {
        id: 'board',
        viewportSize: 1000,
        viewportRatio: 0.5625,
        elements: [textElement as import('@openmaic/dsl').PPTElement],
      },
    ];
    await renderOwner();
    click('toggle-pick');
    act(() =>
      (mocks.canvasProps?.onPickWhiteboardElement as (element: unknown) => void)(textElement),
    );
    stageState.stage.whiteboard[0].elements = [];
    await rerenderOwner();
    expect((mocks.composerProps?.canSendMessage as () => boolean)()).toBe(false);
    expect(mocks.sendMessage).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="owner-pill"]')).not.toBeNull();
    act(() => (mocks.composerProps?.onClearElementReference as () => void)());
    expect((mocks.composerProps?.canSendMessage as () => boolean)()).toBe(true);
  });

  it('does not clear a slide draft merely because the whiteboard opens', async () => {
    await renderOwner();
    click('toggle-pick');
    click('pick-text');
    mocks.whiteboardOpen = true;
    await rerenderOwner();
    expect(container.querySelector('[data-testid="owner-pill"]')?.textContent).toContain('Page 1');
  });

  describe('whiteboard transitions end an armed picker', () => {
    const pickableBoard = () => ({
      id: 'board',
      viewportSize: 1000,
      viewportRatio: 0.5625,
      elements: [textElement as import('@openmaic/dsl').PPTElement],
    });

    it.each([
      ['manual close', true, 'toggle'],
      ['manual open', false, 'toggle'],
      ['automatic close', true, 'store'],
      ['automatic open', false, 'store'],
    ] as const)('%s', async (_label, startsOpen, trigger) => {
      stageState.stage.whiteboard = [pickableBoard()];
      mocks.whiteboardOpen = startsOpen;
      await renderOwner();
      click('toggle-pick');
      expect(mocks.canvasProps?.elementPickActive).toBe(true);

      if (trigger === 'toggle') {
        act(() => (mocks.canvasProps?.onWhiteboardClose as () => void)());
      } else {
        mocks.whiteboardOpen = !startsOpen;
      }
      await rerenderOwner();

      expect(mocks.whiteboardOpen).toBe(!startsOpen);
      // The destination surface is pickable, so only the transition cancels.
      expect(mocks.controlBarProps?.canPickElement).toBe(true);
      expect(mocks.canvasProps?.elementPickActive).toBe(false);
    });

    it('keeps an armed picker across re-renders without a transition', async () => {
      stageState.stage.whiteboard = [pickableBoard()];
      await renderOwner();
      click('toggle-pick');
      await rerenderOwner();
      expect(mocks.canvasProps?.elementPickActive).toBe(true);
    });

    it('keeps a selected whiteboard draft when the whiteboard closes', async () => {
      stageState.stage.whiteboard = [pickableBoard()];
      mocks.whiteboardOpen = true;
      await renderOwner();
      click('toggle-pick');
      act(() =>
        (mocks.canvasProps?.onPickWhiteboardElement as (element: unknown) => void)(textElement),
      );
      mocks.whiteboardOpen = false;
      await rerenderOwner();
      expect(mocks.canvasProps?.elementPickActive).toBe(false);
      expect(container.querySelector('[data-testid="owner-pill"]')?.textContent).toContain(
        'whiteboard.title · Text · First grounded fact',
      );
    });
  });

  it('owns pick state, freezes one request snapshot, and clears only on an accepted receipt', async () => {
    await renderOwner();

    click('toggle-pick');
    expect(mocks.canvasProps?.elementPickActive).toBe(true);
    click('pick-text');
    expect(container.querySelector('[data-testid="owner-pill"]')?.textContent).toContain(
      'Page 1 · Text · First grounded fact',
    );

    click('send');
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    const [, options] = mocks.sendMessage.mock.calls[0] as [
      string,
      { elementReference: unknown; onResponseAccepted: (response: Response) => void },
    ];
    expect(options.elementReference).toEqual({
      kind: 'slide_element',
      sceneId: 'scene-1',
      elementId: 'text-1',
    });
    act(() =>
      options.onResponseAccepted(
        new Response(null, { headers: { 'X-OpenMAIC-Element-Reference-Accepted': '1' } }),
      ),
    );
    expect(container.querySelector('[data-testid="owner-pill"]')).toBeNull();
  });

  it('consumes one PPT picker arm synchronously and rejects a stale second pick', async () => {
    await renderOwner();
    click('toggle-pick');

    act(() => {
      const onPickElement = mocks.canvasProps?.onPickElement as (element: unknown) => void;
      onPickElement(textElement);
      onPickElement(shapeElement);
    });

    expect(container.querySelector('[data-testid="owner-pill"]')?.textContent).toContain(
      'Page 1 · Text · First grounded fact',
    );
    click('send');
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      'Explain this',
      expect.objectContaining({
        elementReference: {
          kind: 'slide_element',
          sceneId: 'scene-1',
          elementId: 'text-1',
        },
      }),
    );
  });

  it('keeps a newer owner draft when an older request receipt arrives', async () => {
    await renderOwner();
    click('toggle-pick');
    click('pick-text');
    click('send');
    const [, options] = mocks.sendMessage.mock.calls[0] as [
      string,
      { onResponseAccepted: (response: Response) => void },
    ];

    click('toggle-pick');
    act(() => {
      (mocks.canvasProps?.onPickElement as (element: unknown) => void)(shapeElement);
    });
    act(() =>
      options.onResponseAccepted(
        new Response(null, { headers: { 'X-OpenMAIC-Element-Reference-Accepted': '1' } }),
      ),
    );

    expect(container.querySelector('[data-testid="owner-pill"]')?.textContent).toContain(
      'Page 1 · Shape · No text',
    );
  });

  it.each(['paused', 'live'] as const)(
    'freezes the draft through the synchronous %s interrupt bridge and sends exactly once',
    async (mode) => {
      mocks.engineMode = mode;
      await renderOwner();
      expect(mocks.controlBarProps?.engineState).toBe(mode === 'live' ? 'playing' : mode);

      click('toggle-pick');
      click('pick-text');
      click('send');

      expect(mocks.handleUserInterrupt).toHaveBeenCalledOnce();
      expect(mocks.handleUserInterrupt).toHaveBeenCalledWith('Explain this');
      expect(mocks.sendMessage).toHaveBeenCalledOnce();
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        'Explain this',
        expect.objectContaining({
          elementReference: {
            kind: 'slide_element',
            sceneId: 'scene-1',
            elementId: 'text-1',
          },
        }),
      );
    },
  );

  it('hides the entry and sends an ordinary unreferenced message when Pi is off', async () => {
    mocks.piEnabled = false;
    await renderOwner();

    expect(mocks.controlBarProps).toMatchObject({
      showElementReference: false,
      canPickElement: false,
      elementPickActive: false,
    });
    expect(container.querySelector('[data-testid="toggle-pick"]')).toBeNull();

    click('send');

    expect(mocks.handleUserInterrupt).not.toHaveBeenCalled();
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    expect(mocks.sendMessage).toHaveBeenCalledWith('Explain this', undefined);
  });

  it('keeps Pi messaging available while the independent reference gate clears its UI state', async () => {
    await renderOwner();
    click('toggle-pick');
    click('pick-text');
    expect(container.querySelector('[data-testid="owner-pill"]')).not.toBeNull();

    mocks.coursewareReferenceEnabled = false;
    await rerenderOwner();

    expect(mocks.controlBarProps).toMatchObject({
      showElementReference: false,
      canPickElement: false,
      elementPickActive: false,
    });
    expect(container.querySelector('[data-testid="toggle-pick"]')).toBeNull();
    expect(container.querySelector('[data-testid="owner-pill"]')).toBeNull();

    click('send');
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    expect(mocks.sendMessage).toHaveBeenCalledWith('Explain this', undefined);
  });

  it('owns an Interactive identity delivered through the Stage sibling seam', async () => {
    stageState.scenes = [interactiveScene];
    stageState.currentSceneId = interactiveScene.id;
    const pickerStates: unknown[] = [];
    const ownerRef = createRef<PlaybackChromeRootHandle>();
    await renderOwner({
      ref: ownerRef,
      onInteractivePickerChange: (state: unknown) => pickerStates.push(state),
    });

    expect(mocks.controlBarProps).toMatchObject({
      showElementReference: true,
      canPickElement: true,
    });
    click('toggle-pick');
    expect(pickerStates).toContainEqual({
      sceneId: interactiveScene.id,
      active: true,
      selectedSelector: undefined,
    });

    act(() => {
      expect(
        ownerRef.current?.acceptInteractivePick({
          sceneId: interactiveScene.id,
          selector: '#angle-slider',
        }),
      ).toBe(true);
      expect(
        ownerRef.current?.acceptInteractivePick({
          sceneId: interactiveScene.id,
          selector: '#stale-second-pick',
        }),
      ).toBe(false);
    });
    expect(container.querySelector('[data-testid="owner-pill"]')?.textContent).toContain(
      'Page 1 · Interactive · #angle-slider',
    );
    expect(pickerStates).toContainEqual({
      sceneId: interactiveScene.id,
      active: false,
      selectedSelector: '#angle-slider',
    });

    click('send');
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      'Explain this',
      expect.objectContaining({
        elementReference: {
          kind: 'interactive_component',
          sceneId: interactiveScene.id,
          selector: '#angle-slider',
        },
      }),
    );
    const [, options] = mocks.sendMessage.mock.calls[0] as [
      string,
      { onResponseAccepted: (response: Response) => void },
    ];
    act(() =>
      options.onResponseAccepted(
        new Response(null, { headers: { 'X-OpenMAIC-Element-Reference-Accepted': '1' } }),
      ),
    );
    expect(pickerStates.at(-1)).toEqual({
      sceneId: interactiveScene.id,
      active: false,
      selectedSelector: undefined,
    });
  });

  it('rejects an Interactive pick synchronously after the owner cancels', async () => {
    stageState.scenes = [interactiveScene];
    stageState.currentSceneId = interactiveScene.id;
    const ownerRef = createRef<PlaybackChromeRootHandle>();
    await renderOwner({ ref: ownerRef });

    click('toggle-pick');
    act(() => {
      ownerRef.current?.cancelElementPick();
      expect(
        ownerRef.current?.acceptInteractivePick({
          sceneId: interactiveScene.id,
          selector: '#stale-after-cancel',
        }),
      ).toBe(false);
    });

    expect(container.querySelector('[data-testid="owner-pill"]')).toBeNull();
  });

  it('cancels an armed Interactive picker with Escape from playback chrome', async () => {
    stageState.scenes = [interactiveScene];
    stageState.currentSceneId = interactiveScene.id;
    const pickerStates: unknown[] = [];
    const ownerRef = createRef<PlaybackChromeRootHandle>();
    await renderOwner({
      ref: ownerRef,
      onInteractivePickerChange: (state: unknown) => pickerStates.push(state),
    });

    click('toggle-pick');
    expect(pickerStates.at(-1)).toEqual({
      sceneId: interactiveScene.id,
      active: true,
      selectedSelector: undefined,
    });

    const escape = new KeyboardEvent('keydown', {
      key: 'Escape',
      bubbles: true,
      cancelable: true,
    });
    act(() => window.dispatchEvent(escape));

    expect(escape.defaultPrevented).toBe(true);
    expect(pickerStates.at(-1)).toEqual({
      sceneId: interactiveScene.id,
      active: false,
      selectedSelector: undefined,
    });
    expect(
      ownerRef.current?.acceptInteractivePick({
        sceneId: interactiveScene.id,
        selector: '#stale-after-escape',
      }),
    ).toBe(false);
  });

  it('freezes one Interactive identity for exactly one send and preserves it without a receipt', async () => {
    stageState.scenes = [interactiveScene];
    stageState.currentSceneId = interactiveScene.id;
    const ownerRef = createRef<PlaybackChromeRootHandle>();
    await renderOwner({ ref: ownerRef });

    click('toggle-pick');
    act(() => {
      ownerRef.current?.acceptInteractivePick({
        sceneId: interactiveScene.id,
        selector: '#angle-slider',
      });
    });
    click('send');

    expect(mocks.handleUserInterrupt).not.toHaveBeenCalled();
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    const [, options] = mocks.sendMessage.mock.calls[0] as [
      string,
      {
        elementReference: unknown;
        onResponseAccepted: (response: Response) => void;
      },
    ];
    expect(options.elementReference).toEqual({
      kind: 'interactive_component',
      sceneId: interactiveScene.id,
      selector: '#angle-slider',
    });
    act(() => options.onResponseAccepted(new Response(null)));
    expect(container.querySelector('[data-testid="owner-pill"]')?.textContent).toContain(
      '#angle-slider',
    );
  });

  it('clears the owner draft after manual scene navigation settles', async () => {
    await renderOwner();
    click('toggle-pick');
    click('pick-text');
    expect(container.querySelector('[data-testid="owner-pill"]')).not.toBeNull();

    act(() => {
      (mocks.controlBarProps?.onNext as (() => void) | undefined)?.();
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(stageState.setCurrentSceneId).toHaveBeenCalledWith(secondScene.id);

    await rerenderOwner();
    expect(container.querySelector('[data-testid="owner-pill"]')).toBeNull();

    click('send');
    expect(mocks.sendMessage).toHaveBeenCalledWith('Explain this', undefined);
  });

  it('keeps the owner draft while a gated scene navigation has not settled', async () => {
    mocks.topicActive = true;
    await renderOwner();
    click('toggle-pick');
    click('pick-text');

    act(() => {
      (mocks.controlBarProps?.onNext as (() => void) | undefined)?.();
    });

    expect(stageState.setCurrentSceneId).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="owner-pill"]')).not.toBeNull();
  });

  it('stops the previous engine when switching to a non-playable scene', async () => {
    await renderOwner();
    expect(mocks.engineStop).not.toHaveBeenCalled();
    const previousEngineOptions = mocks.engineOptions;

    stageState.scenes = [scene, interactiveScene];
    stageState.currentSceneId = interactiveScene.id;
    await rerenderOwner();

    expect(mocks.engineStop).toHaveBeenCalledOnce();
    act(() => previousEngineOptions?.onProgress?.({ actionIndex: 1, sceneId: scene.id }));
    expect(mocks.chatAreaProps?.currentActionIndex).toBe(0);
  });

  it('does not resume manual playback after its engine is superseded', async () => {
    let resolveStartLecture!: (sessionId: string) => void;
    mocks.startLecture.mockReturnValueOnce(
      new Promise<string>((resolve) => {
        resolveStartLecture = resolve;
      }),
    );
    await renderOwner();
    const onPlayPause = mocks.canvasProps?.onPlayPause as () => Promise<void>;

    let playPromise!: Promise<void>;
    act(() => {
      playPromise = onPlayPause();
    });
    stageState.scenes = [scene, interactiveScene];
    stageState.currentSceneId = interactiveScene.id;
    await rerenderOwner();

    await act(async () => {
      resolveStartLecture('stale-lecture');
      await playPromise;
    });

    expect(mocks.engineContinuePlayback).not.toHaveBeenCalled();
    expect(mocks.endSession).toHaveBeenCalledWith('stale-lecture');
  });

  it('does not auto-start playback after its engine is superseded', async () => {
    vi.useFakeTimers();
    settingsState.autoPlayLecture = true;
    try {
      await renderOwner();
      act(() => mocks.engineOptions?.onComplete?.());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });

      let resolveStartLecture!: (sessionId: string) => void;
      mocks.startLecture.mockReturnValueOnce(
        new Promise<string>((resolve) => {
          resolveStartLecture = resolve;
        }),
      );
      await rerenderOwner();

      stageState.scenes = [scene, secondScene, interactiveScene];
      stageState.currentSceneId = interactiveScene.id;
      await rerenderOwner();

      await act(async () => {
        resolveStartLecture('stale-auto-lecture');
        await Promise.resolve();
      });

      expect(mocks.engineStart).not.toHaveBeenCalled();
      expect(mocks.endSession).toHaveBeenCalledWith('stale-auto-lecture');
    } finally {
      vi.useRealTimers();
    }
  });

  it('clears the owner draft after automatic playback advances the scene', async () => {
    vi.useFakeTimers();
    settingsState.autoPlayLecture = true;
    try {
      await renderOwner();
      click('toggle-pick');
      click('pick-text');
      expect(container.querySelector('[data-testid="owner-pill"]')).not.toBeNull();

      act(() => mocks.engineOptions?.onComplete?.());
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1500);
      });
      expect(stageState.setCurrentSceneId).toHaveBeenCalledWith(secondScene.id);

      await rerenderOwner();
      expect(container.querySelector('[data-testid="owner-pill"]')).toBeNull();

      click('send');
      expect(mocks.sendMessage).toHaveBeenCalledWith('Explain this', undefined);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('raised hand while the lecture plays', () => {
    const textReference = { kind: 'slide_element', sceneId: 'scene-1', elementId: 'text-1' };

    function queuedQuestion() {
      return mocks.composerProps?.queuedQuestion as
        | { id: number; text: string; status: string }
        | null
        | undefined;
    }

    /** The engine clears its slot, then calls back at the action boundary. */
    function deliverAtBoundary(text: string) {
      mocks.queuedText = null;
      act(() => mocks.engineOptions?.onUserInterrupt?.(text));
    }

    async function raiseHandWithTextReference() {
      mocks.engineMode = 'playing';
      await renderOwner();
      click('toggle-pick');
      click('pick-text');
      click('send');
    }

    it('queues the question instead of interrupting, then sends the frozen reference on delivery', async () => {
      await raiseHandWithTextReference();

      expect(mocks.lastSendResult).toBe('queued');
      expect(mocks.queueUserInterrupt).toHaveBeenCalledExactlyOnceWith('Explain this');
      expect(mocks.handleUserInterrupt).not.toHaveBeenCalled();
      expect(mocks.sendMessage).not.toHaveBeenCalled();
      expect(queuedQuestion()).toMatchObject({ text: 'Explain this', status: 'queued' });

      // The draft changes while the hand is up; the question keeps its own reference
      click('toggle-pick');
      act(() => (mocks.canvasProps?.onPickElement as (element: unknown) => void)(shapeElement));
      expect(container.querySelector('[data-testid="owner-pill"]')?.textContent).toContain('Shape');

      deliverAtBoundary('Explain this');
      expect(mocks.sendMessage).toHaveBeenCalledOnce();
      expect(mocks.sendMessage).toHaveBeenCalledWith(
        'Explain this',
        expect.objectContaining({ elementReference: textReference }),
      );
      expect(queuedQuestion()).toMatchObject({ text: 'Explain this', status: 'delivered' });
    });

    it('cancels: gives the text back and drops the frozen reference', async () => {
      await raiseHandWithTextReference();
      const { id } = queuedQuestion()!;

      act(() => (mocks.composerProps?.onCancelQueuedQuestion as () => void)());
      expect(mocks.cancelQueuedInterrupt).toHaveBeenCalledOnce();
      expect(queuedQuestion()).toEqual({ id, text: 'Explain this', status: 'cancelled' });

      // Anything later is an ordinary interrupt, without the dropped snapshot
      act(() => mocks.engineOptions?.onUserInterrupt?.('Explain this'));
      expect(mocks.sendMessage).toHaveBeenCalledExactlyOnceWith('Explain this', undefined);
    });

    it('pausing with a raised hand delivers it now instead of pausing', async () => {
      await raiseHandWithTextReference();

      await act(async () => {
        await (mocks.canvasProps?.onPlayPause as () => Promise<void>)();
      });
      expect(mocks.flushQueuedInterrupt).toHaveBeenCalledOnce();
      expect(mocks.enginePause).not.toHaveBeenCalled();
      expect(mocks.handleUserInterrupt).toHaveBeenCalledExactlyOnceWith('Explain this');
      expect(mocks.sendMessage).toHaveBeenCalledExactlyOnceWith(
        'Explain this',
        expect.objectContaining({ elementReference: textReference }),
      );
      expect(queuedQuestion()?.status).toBe('delivered');

      // With no raised hand, pause is an ordinary pause again
      await act(async () => {
        await (mocks.canvasProps?.onPlayPause as () => Promise<void>)();
      });
      expect(mocks.enginePause).toHaveBeenCalledOnce();
    });

    it('voice freezes the lecture text with the audio, like the pause button', async () => {
      mocks.engineMode = 'idle';
      await renderOwner();
      // Start the lecture so it has a session whose text reveal can freeze
      await act(async () => {
        await (mocks.canvasProps?.onPlayPause as () => Promise<void>)();
      });
      mocks.engineMode = 'playing';
      mocks.pauseBuffer.mockClear();
      act(() => (mocks.composerProps?.onInputActivate as (kind: 'voice') => void)('voice'));
      expect(mocks.enginePause).toHaveBeenCalledOnce();
      expect(mocks.pauseBuffer).toHaveBeenCalledWith('lecture-1');
    });

    it('keeps playing while typing, but pauses for voice and in live Q&A', async () => {
      mocks.engineMode = 'playing';
      await renderOwner();
      const onInputActivate = mocks.composerProps?.onInputActivate as (
        kind: 'text' | 'voice',
      ) => void;

      act(() => onInputActivate('text'));
      expect(mocks.enginePause).not.toHaveBeenCalled();
      act(() => onInputActivate('voice'));
      expect(mocks.enginePause).toHaveBeenCalledOnce();

      mocks.engineMode = 'live';
      act(() => onInputActivate('text'));
      expect(mocks.enginePause).toHaveBeenCalledTimes(2);
    });

    it('cancels before awaiting a scene switch so it is never answered in the old scene', async () => {
      await raiseHandWithTextReference();

      act(() => (mocks.controlBarProps?.onNext as () => void)());
      expect(mocks.cancelQueuedInterrupt).toHaveBeenCalledOnce();
      expect(queuedQuestion()).toMatchObject({ text: 'Explain this', status: 'cancelled' });
      expect(stageState.setCurrentSceneId).not.toHaveBeenCalled();

      await act(async () => {
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(stageState.setCurrentSceneId).toHaveBeenCalledWith(secondScene.id);
      deliverAtBoundary('Explain this');
      expect(mocks.sendMessage).toHaveBeenCalledExactlyOnceWith('Explain this', undefined);
    });

    it('refuses a delivery after the scene changed underneath and gives the text back', async () => {
      await raiseHandWithTextReference();

      // The store moved on before the scene-init effect could cancel it
      stageState.currentSceneId = secondScene.id;
      deliverAtBoundary('Explain this');

      expect(mocks.sendMessage).not.toHaveBeenCalled();
      expect(queuedQuestion()?.status).toBe('cancelled');
      // Stopped right away (and again by the scene-init effect catching up)
      expect(mocks.engineStop).toHaveBeenCalled();
    });

    it('blocks a second question while one is waiting', async () => {
      await raiseHandWithTextReference();
      click('send');

      expect(mocks.lastSendResult).toBe('blocked');
      expect(mocks.queueUserInterrupt).toHaveBeenCalledOnce();
      expect(mocks.handleUserInterrupt).not.toHaveBeenCalled();
      expect(mocks.sendMessage).not.toHaveBeenCalled();
    });

    it('surfaces the text of a waiting question when playback is torn down', async () => {
      const toastInfo = vi.spyOn(toast, 'info');
      try {
        mocks.engineMode = 'playing';
        const ownerRef = createRef<PlaybackChromeRootHandle>();
        await renderOwner({ ref: ownerRef });
        click('send');

        await act(async () => {
          await ownerRef.current?.teardown();
        });
        expect(mocks.cancelQueuedInterrupt).toHaveBeenCalledOnce();
        expect(toastInfo).toHaveBeenCalledWith('roundtable.queuedQuestionNotSent', {
          description: 'Explain this',
        });
        expect(mocks.sendMessage).not.toHaveBeenCalled();
      } finally {
        toastInfo.mockRestore();
      }
    });

    it('resumes into completion when the question was answered after the last line', async () => {
      await renderOwner();
      mocks.lectureCompletionPending = true;
      mocks.shouldAutoResume.mockReturnValue(true);

      await act(async () => {
        await (mocks.chatAreaProps?.onStopSession as (payload: unknown) => Promise<void>)({
          sessionId: 'qa-1',
          source: 'soft_close_confirmed',
          endReason: 'user_done',
        });
      });
      expect(mocks.shouldAutoResume).toHaveBeenCalledWith(
        expect.objectContaining({ hadLectureInterruption: true, lectureCompletionPending: true }),
      );
      expect(mocks.engineContinuePlayback).toHaveBeenCalledOnce();
    });

    it('interrupts right away when the engine will not queue (waiting on a discussion)', async () => {
      mocks.queueRefused = true;
      await raiseHandWithTextReference();

      expect(mocks.queueUserInterrupt).toHaveBeenCalledExactlyOnceWith('Explain this');
      expect(mocks.lastSendResult).toBeUndefined();
      expect(queuedQuestion()).toBeNull();
      expect(mocks.handleUserInterrupt).toHaveBeenCalledExactlyOnceWith('Explain this');
      expect(mocks.sendMessage).toHaveBeenCalledExactlyOnceWith(
        'Explain this',
        expect.objectContaining({ elementReference: textReference }),
      );
    });

    it.each([
      ['continues into the completion', true],
      ['restarts', false],
    ] as const)(
      'Play after an exhausted Q&A stopped by hand %s (pending completion: %s)',
      async (_label, pendingCompletion) => {
        await renderOwner();
        mocks.engineExhausted = true;
        mocks.lectureCompletionPending = pendingCompletion;

        await act(async () => {
          await (mocks.chatAreaProps?.onStopSession as (payload: unknown) => Promise<void>)({
            sessionId: 'qa-1',
            source: 'manual_stop',
          });
        });
        await act(async () => {
          await (mocks.canvasProps?.onPlayPause as () => Promise<void>)();
        });

        if (pendingCompletion) {
          // A raised hand answered after the last line: Play runs the
          // completion it preempted (onComplete), never a restart from 0
          expect(mocks.engineContinuePlayback).toHaveBeenCalledOnce();
          expect(mocks.engineStart).not.toHaveBeenCalled();
        } else {
          expect(mocks.engineStart).toHaveBeenCalledOnce();
          expect(mocks.engineContinuePlayback).not.toHaveBeenCalled();
        }
      },
    );

    it.each([
      ['a spoken line', true, 'sentence'],
      ['another step', false, 'step'],
    ] as const)(
      'words the raised hand by what is in flight: %s',
      async (_label, inFlight, waitsFor) => {
        mocks.speechInFlight = inFlight;
        mocks.engineMode = 'playing';
        await renderOwner();
        click('send');

        expect(queuedQuestion()).toMatchObject({ status: 'queued', waitsFor });
      },
    );

    describe('an unsent raised hand outlives the page', () => {
      const draftKey = 'openmaic:raised-hand-draft:stage-1';
      let toastInfo: ReturnType<typeof vi.spyOn>;

      beforeEach(() => {
        toastInfo = vi.spyOn(toast, 'info');
      });
      afterEach(() => {
        toastInfo.mockRestore();
      });

      function storedDraft() {
        const raw = window.sessionStorage.getItem(draftKey);
        return raw ? (JSON.parse(raw) as { text: string }).text : null;
      }

      async function raiseHand() {
        mocks.engineMode = 'playing';
        await renderOwner();
        click('send');
        expect(queuedQuestion()?.status).toBe('queued');
      }

      function pageHide() {
        act(() => {
          window.dispatchEvent(new Event('pagehide'));
        });
      }

      it('keeps it as a draft when the classroom unmounts, without sending it', async () => {
        await raiseHand();
        act(() => root.unmount());

        expect(storedDraft()).toBe('Explain this');
        expect(mocks.sendMessage).not.toHaveBeenCalled();
        expect(toastInfo).not.toHaveBeenCalled();
      });

      it('writes the draft synchronously on pagehide, never asking to stay', async () => {
        await renderOwner();
        pageHide();
        expect(storedDraft()).toBeNull();

        await raiseHand();
        const beforeUnload = new Event('beforeunload', { cancelable: true });
        act(() => {
          window.dispatchEvent(beforeUnload);
        });
        pageHide();
        expect(beforeUnload.defaultPrevented).toBe(false);
        expect(storedDraft()).toBe('Explain this');

        // Still on the page (back/forward cache): the waiting hand is not
        // restored over itself, and once answered it leaves no draft
        await rerenderOwner();
        expect(queuedQuestion()?.status).toBe('queued');
        expect(toastInfo).not.toHaveBeenCalled();
        deliverAtBoundary('Explain this');
        await act(async () => {
          await Promise.resolve();
        });
        expect(storedDraft()).toBeNull();
      });

      it('leaves no draft once the question is cancelled', async () => {
        await raiseHand();
        pageHide();
        act(() => (mocks.composerProps?.onCancelQueuedQuestion as () => void)());
        expect(storedDraft()).toBeNull();

        act(() => root.unmount());
        expect(storedDraft()).toBeNull();
      });

      it('keeps a delivered question until the server accepts it', async () => {
        await raiseHand();
        // The request is still going out when the page goes away (a reload
        // started before the line ended)
        mocks.sendMessage.mockReturnValueOnce(new Promise(() => {}));
        deliverAtBoundary('Explain this');
        pageHide();
        expect(storedDraft()).toBe('Explain this');

        const [, options] = mocks.sendMessage.mock.calls[0] as [
          string,
          { onResponseAccepted: (response: Response) => void },
        ];
        act(() => options.onResponseAccepted(new Response('')));
        expect(storedDraft()).toBeNull();
        act(() => root.unmount());
        expect(storedDraft()).toBeNull();
      });

      /** A delivered request that settles later, unaccepted (as an abort does). */
      function deliverWithPendingRequest() {
        let settle!: () => void;
        mocks.sendMessage.mockReturnValueOnce(new Promise<void>((resolve) => (settle = resolve)));
        deliverAtBoundary('Explain this');
        return async () => {
          await act(async () => {
            settle();
            await Promise.resolve();
            await Promise.resolve();
          });
        };
      }

      it('keeps the draft when leaving aborts the delivered request', async () => {
        await raiseHand();
        const settleRequest = deliverWithPendingRequest();

        // A route change: ChatArea's unmount aborts the request, which settles
        // the send without the server ever accepting it
        act(() => root.unmount());
        await settleRequest();
        expect(storedDraft()).toBe('Explain this');

        root = createRoot(container);
        await renderOwner();
        expect(queuedQuestion()).toMatchObject({ text: 'Explain this', status: 'restored' });
      });

      it('Pro mode keeps a delivered question whose request it aborts', async () => {
        const ownerRef = createRef<PlaybackChromeRootHandle>();
        mocks.engineMode = 'playing';
        await renderOwner({ ref: ownerRef });
        click('send');
        const settleRequest = deliverWithPendingRequest();

        // Ending the session aborts the request before playback unmounts
        await act(async () => {
          await ownerRef.current?.teardown();
        });
        await settleRequest();
        expect(storedDraft()).toBeNull();

        mocks.engineMode = 'idle';
        await remountOwner();
        expect(queuedQuestion()).toMatchObject({ text: 'Explain this', status: 'restored' });
      });

      it('Pro mode still reports it, and the next visit puts it back', async () => {
        const ownerRef = createRef<PlaybackChromeRootHandle>();
        mocks.engineMode = 'playing';
        await renderOwner({ ref: ownerRef });
        click('send');

        await act(async () => {
          await ownerRef.current?.teardown();
        });
        expect(toastInfo).toHaveBeenCalledWith('roundtable.queuedQuestionNotSent', {
          description: 'Explain this',
        });
        // Written only if playback really unmounts (a failed edit-mode entry stays)
        await rerenderOwner();
        expect(storedDraft()).toBeNull();
        expect(toastInfo).not.toHaveBeenCalledWith('roundtable.queuedQuestionRestored');

        mocks.engineMode = 'idle';
        await remountOwner();
        expect(queuedQuestion()).toMatchObject({ text: 'Explain this', status: 'restored' });
        expect(toastInfo).toHaveBeenCalledWith('roundtable.queuedQuestionRestored');
        expect(storedDraft()).toBeNull();
      });

      it('drops what Pro mode gave back once something else is sent', async () => {
        const ownerRef = createRef<PlaybackChromeRootHandle>();
        mocks.engineMode = 'playing';
        await renderOwner({ ref: ownerRef });
        click('send');
        await act(async () => {
          await ownerRef.current?.teardown();
        });

        mocks.engineMode = 'idle';
        click('send');
        expect(mocks.sendMessage).toHaveBeenCalledOnce();
        act(() => root.unmount());
        expect(storedDraft()).toBeNull();
      });

      it('puts a draft back into the input on mount, once, and never sends it', async () => {
        window.sessionStorage.setItem(
          draftKey,
          JSON.stringify({ version: 1, text: 'Left behind' }),
        );
        const otherKey = 'openmaic:raised-hand-draft:stage-2';
        window.sessionStorage.setItem(otherKey, JSON.stringify({ version: 1, text: 'Elsewhere' }));
        mocks.engineMode = 'playing';
        await renderOwner();

        expect(queuedQuestion()).toMatchObject({ text: 'Left behind', status: 'restored' });
        expect(toastInfo).toHaveBeenCalledExactlyOnceWith('roundtable.queuedQuestionRestored');
        expect(storedDraft()).toBeNull();
        expect(window.sessionStorage.getItem(otherKey)).not.toBeNull();
        expect(mocks.queueUserInterrupt).not.toHaveBeenCalled();
        expect(mocks.handleUserInterrupt).not.toHaveBeenCalled();
        expect(mocks.sendMessage).not.toHaveBeenCalled();

        await rerenderOwner();
        expect(toastInfo).toHaveBeenCalledOnce();
      });

      it('waits for playback mode, where the input is, to restore a draft', async () => {
        window.sessionStorage.setItem(
          draftKey,
          JSON.stringify({ version: 1, text: 'Left behind' }),
        );
        stageState.mode = 'autonomous';
        await renderOwner();
        expect(mocks.composerProps).toBeUndefined();
        expect(storedDraft()).toBe('Left behind');

        stageState.mode = 'playback';
        await rerenderOwner();
        expect(queuedQuestion()).toMatchObject({ text: 'Left behind', status: 'restored' });
      });
    });

    describe('scene auto-advance while the student is composing', () => {
      beforeEach(() => {
        vi.useFakeTimers();
        settingsState.autoPlayLecture = true;
        mocks.engineExhausted = true;
      });
      afterEach(() => {
        vi.useRealTimers();
      });

      async function completeWhileComposing() {
        await renderOwner();
        setComposing(true);
        act(() => mocks.engineOptions?.onComplete?.());
        await act(async () => {
          await vi.advanceTimersByTimeAsync(1500);
        });
      }

      function setComposing(active: boolean) {
        act(() => (mocks.composerProps?.onInteractionChange as (active: boolean) => void)(active));
      }

      it('holds the advance until the input closes', async () => {
        await completeWhileComposing();
        expect(stageState.setCurrentSceneId).not.toHaveBeenCalled();

        setComposing(false);
        expect(stageState.setCurrentSceneId).toHaveBeenCalledExactlyOnceWith(secondScene.id);
      });

      it('drops the held advance when the student asks a question instead', async () => {
        await completeWhileComposing();
        click('send');
        expect(mocks.sendMessage).toHaveBeenCalledOnce();

        setComposing(false);
        expect(stageState.setCurrentSceneId).not.toHaveBeenCalled();
      });

      it('drops the held advance when playback moved on meanwhile', async () => {
        await completeWhileComposing();
        mocks.engineExhausted = false;

        setComposing(false);
        expect(stageState.setCurrentSceneId).not.toHaveBeenCalled();
      });
    });
  });

  describe('resume position after a raised hand is answered', () => {
    const resumeKey = 'openmaic:playback-action-resume:stage-1';
    const line = (id: string, text: string) => ({ id, type: 'speech', text });

    function storedPosition() {
      const raw = window.sessionStorage.getItem(resumeKey);
      return raw ? JSON.parse(raw).scenes['scene-1'] : undefined;
    }

    function progress(actionIndex: number, atBoundary?: boolean) {
      act(() =>
        mocks.engineOptions?.onProgress?.(
          { actionIndex, sceneId: scene.id },
          atBoundary ? { atBoundary } : undefined,
        ),
      );
    }

    async function pauseLiveQA() {
      mocks.engineMode = 'live';
      await act(async () => {
        await (mocks.canvasProps?.onPlayPause as () => Promise<void>)();
      });
    }

    async function withActions(actions: unknown[]) {
      mocks.realActionResume = true;
      stageState.scenes = [{ ...scene, actions } as typeof scene, secondScene];
      await renderOwner();
    }

    it('keeps the boundary before an unsafe action through the Q&A, unmount and reload', async () => {
      const discussion = { id: 'disc', type: 'discussion', topic: 'Why?' };
      await withActions([line('s1', 'First line'), discussion]);
      progress(0);
      expect(storedPosition()).toEqual({ actionIndex: 0, actionId: 's1', actionType: 'speech' });

      const boundary = {
        actionIndex: 1,
        actionId: 'disc',
        actionType: 'discussion',
        atBoundary: true,
      };
      progress(1, true);
      expect(storedPosition()).toEqual(boundary);
      // The auto-resume / restore jump publishes the same cursor unflagged
      progress(1);
      await pauseLiveQA();
      expect(mocks.enginePause).toHaveBeenCalledOnce();
      act(() => root.unmount());
      expect(storedPosition()).toEqual(boundary);

      mocks.engineMode = 'idle';
      mocks.engineCanJumpToAction.mockReturnValue(true);
      mocks.engineJumpToAction.mockResolvedValue(true);
      root = createRoot(container);
      await renderOwner();
      expect(mocks.engineCanJumpToAction).toHaveBeenCalledWith(1, { atBoundary: true });
      expect(mocks.engineJumpToAction).toHaveBeenCalledWith(1, {
        autoplay: false,
        atBoundary: true,
      });
      // The line that finished stays on screen, matching the line counter
      expect(mocks.chatAreaProps?.currentActionIndex).toBe(1);
      // The caption strip element the canvas receives shows the same line
      expect(captionElementProps()?.lectureSpeech).toBe('First line');
    });

    it('stores a boundary before a visual cue instead of the finished line', async () => {
      const cue = { id: 'sp1', type: 'spotlight', elementId: 'text-1' };
      await withActions([line('s1', 'First line'), cue, line('s2', 'Second line')]);
      progress(0);
      progress(1, true);
      expect(storedPosition()).toEqual({
        actionIndex: 1,
        actionId: 'sp1',
        actionType: 'spotlight',
        atBoundary: true,
      });

      // Once the lecture moves on, the next line replaces it
      progress(1);
      progress(2);
      expect(storedPosition()).toEqual({ actionIndex: 2, actionId: 's2', actionType: 'speech' });
    });

    it('still clears an unflagged unsafe cursor, so a cut line is not skipped over', async () => {
      const discussion = { id: 'disc', type: 'discussion', topic: 'Why?' };
      await withActions([line('s1', 'First line'), discussion]);
      progress(0);
      progress(1);
      expect(storedPosition()).toBeUndefined();
    });

    it('keeps the last line after a raised hand answered at the end, until completion', async () => {
      await withActions([line('s1', 'Only line')]);
      progress(0);
      mocks.lectureCompletionPending = true;
      progress(1, true);
      await pauseLiveQA();
      act(() => root.unmount());
      expect(storedPosition()).toEqual({ actionIndex: 0, actionId: 's1', actionType: 'speech' });
    });

    it('restores a plain speech position as an ordinary jump', async () => {
      mocks.realActionResume = true;
      stageState.scenes = [
        { ...scene, actions: [line('s1', 'First'), line('s2', 'Second')] } as typeof scene,
        secondScene,
      ];
      window.sessionStorage.setItem(
        resumeKey,
        JSON.stringify({
          version: 1,
          scenes: { 'scene-1': { actionIndex: 1, actionId: 's2', actionType: 'speech' } },
        }),
      );
      mocks.engineCanJumpToAction.mockReturnValue(true);
      mocks.engineJumpToAction.mockResolvedValue(true);
      await renderOwner();

      expect(mocks.engineJumpToAction).toHaveBeenCalledWith(1, {
        autoplay: false,
        atBoundary: false,
      });
      expect(captionElementProps()?.lectureSpeech).toBe('Second');
    });
  });

  describe('shell-owned control bar and caption', () => {
    it('feeds the control bar: page counter inputs, transport and the reference entry', async () => {
      await renderOwner();
      expect(mocks.controlBarProps).toMatchObject({
        variant: 'bar',
        currentSceneIndex: 0,
        // Two scenes plus the course-complete slot
        scenesCount: 3,
        engineState: 'idle',
        showStop: false,
        whiteboardOpen: false,
        showElementReference: true,
        canPickElement: true,
      });
      // The composer carries none of the bar's controls
      for (const key of ['onNextSlide', 'onPrevSlide', 'onToggleElementPick', 'onStopDiscussion']) {
        expect(mocks.composerProps).not.toHaveProperty(key);
      }
    });

    it('applies the one stop rule: a live engine shows the stop pill', async () => {
      mocks.engineMode = 'live';
      await renderOwner();
      expect(mocks.controlBarProps).toMatchObject({ showStop: true, stopKind: 'discussion' });
      // The live answer keeps a mouse path to pause / resume beside the pill
      expect(mocks.controlBarProps).toMatchObject({
        livePaused: false,
        canToggleLivePause: false,
      });
      expect(typeof mocks.controlBarProps?.onToggleLivePause).toBe('function');
    });

    it('routes play through the primary action, which plays the lecture outside a session', async () => {
      await renderOwner();
      await act(async () => {
        (mocks.controlBarProps?.onPlayPause as () => void)();
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(mocks.startLecture).toHaveBeenCalledWith('scene-1');
    });

    it('reopens the panel composer when the stream continues a soft-closing session', async () => {
      mocks.openTextInput.mockReset();
      // Collapsed: continuing must bring the composer it focuses into view
      settingsState.chatAreaCollapsed = true;
      await renderOwner();
      // The control bar no longer carries the soft-close "continue" (the
      // stream's soft-close row owns it): none of the old toolbar's props
      for (const key of ['onContinueDiscussion', 'isSoftClosing', 'softCloseDeadline']) {
        expect(mocks.controlBarProps).not.toHaveProperty(key);
      }
      expect(settingsState.setChatAreaCollapsed).not.toHaveBeenCalled();
      act(() => (mocks.chatAreaProps?.onSoftCloseContinued as () => void)());
      expect(mocks.openTextInput).toHaveBeenCalledOnce();
      expect(settingsState.setChatAreaCollapsed).toHaveBeenCalledWith(false);
      expect(mocks.switchToTab).toHaveBeenCalledWith('interaction');
    });

    it('shows the caption under slides only', async () => {
      await renderOwner();
      expect(mocks.canvasProps?.caption).toBeTruthy();

      stageState.scenes = [interactiveScene];
      stageState.currentSceneId = interactiveScene.id;
      await rerenderOwner();
      expect(mocks.canvasProps?.caption).toBeNull();
    });

    it('feeds the board mode: the PiP page, and 边讲边写 only while the open board is drawn on', async () => {
      const captionProps = () =>
        (mocks.canvasProps?.caption as { props: Record<string, unknown> } | null)?.props;
      mocks.whiteboardDrawing = { agentId: 'teacher-1' };
      await renderOwner();
      expect(mocks.canvasProps?.pageNumber).toBe(1);
      // The stage column sizes the caption (92px, 108px beside the PiP)
      expect(captionProps()?.className).toBe('h-full');
      expect(captionProps()?.isDrawingOnBoard).toBe(false);

      mocks.whiteboardOpen = true;
      await rerenderOwner();
      expect(captionProps()?.isDrawingOnBoard).toBe(true);

      mocks.whiteboardDrawing = null;
      await rerenderOwner();
      expect(captionProps()?.isDrawingOnBoard).toBe(false);
    });
  });

  describe('interaction panel: participants, composer and the inline discussion card', () => {
    function pressKey(key: string) {
      act(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
        );
      });
    }

    it('mounts participants and the composer in the panel, never the dock outside fullscreen', async () => {
      await renderOwner();
      expect(mocks.chatAreaProps?.header).toBeTruthy();
      expect(mocks.chatAreaProps?.footer).toBeTruthy();
      expect(mocks.participantsProps).toBeDefined();
      expect(mocks.composerProps).toBeDefined();
      expect(mocks.presentationDockProps).toBeUndefined();
      // The one composer sits in the panel's footer slot
      expect(
        container.querySelector('[data-testid="composer-slot"] [data-testid="send"]'),
      ).not.toBeNull();
      // The transient end flash is gone: the stream keeps persistent markers
      expect(mocks.composerProps).not.toHaveProperty('showEndFlash');
    });

    it('routes a mid-line question through raiseHand: queued, with the hand on the participants', async () => {
      mocks.engineMode = 'playing';
      await renderOwner();
      click('send');
      expect(mocks.queueUserInterrupt).toHaveBeenCalledExactlyOnceWith('Explain this');
      expect(mocks.lastSendResult).toBe('queued');
      expect(mocks.sendMessage).not.toHaveBeenCalled();
      expect(mocks.composerProps?.queuedQuestion).toMatchObject({
        text: 'Explain this',
        status: 'queued',
      });
      expect(mocks.participantsProps?.userHandRaised).toBe(true);
      // The status row's progress bar reads the line in flight from the engine
      expect((mocks.composerProps?.getSpeechProgress as () => number | null)()).toBe(0.4);
      // Lecture time: 举手 stays available
      expect(mocks.composerProps?.isLiveSession).toBe(false);
    });

    it('sends at once outside the lecture and treats the open Q&A as a live session', async () => {
      await renderOwner();
      click('send');
      expect(mocks.lastSendResult).toBeUndefined();
      expect(mocks.sendMessage).toHaveBeenCalledOnce();
      expect(mocks.switchToTab).toHaveBeenCalledWith('interaction');
      expect(mocks.composerProps?.isLiveSession).toBe(true);
    });

    it('T and V each reveal a collapsed panel on 互动 before focusing or recording', async () => {
      settingsState.chatAreaCollapsed = true;
      await renderOwner();
      pressKey('t');
      expect(settingsState.setChatAreaCollapsed).toHaveBeenCalledWith(false);
      expect(mocks.switchToTab).toHaveBeenCalledWith('interaction');
      expect(mocks.focusComposer).toHaveBeenCalledOnce();

      // The mocked store stays collapsed, so V must reveal on its own
      settingsState.setChatAreaCollapsed.mockClear();
      mocks.switchToTab.mockClear();
      pressKey('v');
      expect(mocks.toggleVoice).toHaveBeenCalledOnce();
      expect(settingsState.setChatAreaCollapsed).toHaveBeenCalledWith(false);
      expect(mocks.switchToTab).toHaveBeenCalledWith('interaction');
    });

    it('drops a recording when the composer goes out of sight (笔记 or collapsed)', async () => {
      await renderOwner();
      expect(mocks.dismissComposer).not.toHaveBeenCalled();
      act(() => (mocks.chatAreaProps?.onFooterHidden as () => void)());
      expect(mocks.dismissComposer).toHaveBeenCalledOnce();
    });

    it('Escape leaves the composer only while it is composing', async () => {
      await renderOwner();
      pressKey('Escape');
      expect(mocks.dismissComposer).not.toHaveBeenCalled();

      act(() => (mocks.composerProps?.onInteractionChange as (active: boolean) => void)(true));
      pressKey('Escape');
      expect(mocks.dismissComposer).toHaveBeenCalledOnce();
    });

    it('expands the collapsed panel on 互动 when the learner is cued', async () => {
      settingsState.chatAreaCollapsed = true;
      await renderOwner();
      expect(settingsState.setChatAreaCollapsed).not.toHaveBeenCalled();

      act(() => (mocks.chatAreaProps?.onCueUser as () => void)());
      expect(mocks.composerProps?.isCueUser).toBe(true);
      expect(settingsState.setChatAreaCollapsed).toHaveBeenCalledWith(false);
      expect(mocks.switchToTab).toHaveBeenCalledWith('interaction');
    });

    it('offers a discussion inline in the stream; join and skip go to the engine', async () => {
      mocks.engineMode = 'paused';
      await renderOwner();
      expect(mocks.proactiveProps).toBeUndefined();

      const options = mocks.engineOptions as unknown as {
        onProactiveShow: (trigger: Record<string, unknown>) => void;
      };
      mocks.switchToTab.mockClear();
      act(() =>
        options.onProactiveShow({ id: 'trigger-1', question: 'Why green?', agentId: 'agent-2' }),
      );
      expect(mocks.proactiveProps).toMatchObject({
        variant: 'inline',
        mode: 'paused',
        action: { topic: 'Why green?', agentId: 'agent-2' },
      });
      expect(mocks.participantsProps?.discussionAgentId).toBe('agent-2');
      // The lecture waits on join / skip: the offer is brought into view
      expect(mocks.switchToTab).toHaveBeenCalledWith('interaction');

      act(() => (mocks.proactiveProps?.onListen as () => void)());
      expect(mocks.confirmDiscussion).toHaveBeenCalledOnce();
      act(() => (mocks.proactiveProps?.onSkip as () => void)());
      expect(mocks.skipDiscussion).toHaveBeenCalledOnce();
    });
  });

  describe('a bare raised hand (举手 without a question)', () => {
    type ComposerHandProp = {
      state: 'raised' | 'called' | null;
      waitsFor?: 'sentence' | 'step';
      onRaise: () => boolean;
      onLower: () => boolean;
    };
    const composerHand = () => mocks.composerProps?.hand as ComposerHandProp;

    function pressKey(key: string) {
      act(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
        );
      });
    }

    /** The line ends: the engine pauses at the boundary and calls the learner */
    function callAtBoundary(deferredDiscussion?: {
      id: string;
      question: string;
      agentId?: string;
    }) {
      mocks.handState = 'called';
      mocks.engineMode = 'paused';
      act(() => {
        mocks.engineOptions?.onModeChange?.('paused');
        mocks.engineOptions?.onHandCalled?.({
          atBoundary: true,
          ...(deferredDiscussion ? { deferredDiscussion } : {}),
        });
      });
    }

    async function raiseWhilePlaying() {
      mocks.engineMode = 'playing';
      await renderOwner();
      let raised = false;
      act(() => {
        raised = composerHand().onRaise();
      });
      expect(raised).toBe(true);
    }

    it('raises through the composer, waits for the line, and is never kept as a draft', async () => {
      await raiseWhilePlaying();
      expect(mocks.raiseHand).toHaveBeenCalledOnce();
      expect(composerHand()).toMatchObject({ state: 'raised', waitsFor: 'sentence' });
      expect(mocks.participantsProps?.userHandRaised).toBe(true);
      // Typing does not pause the lecture, and neither does a raised hand
      expect(mocks.enginePause).not.toHaveBeenCalled();
      expect(mocks.composerProps?.isCueUser).toBe(false);
      expect(mocks.sendMessage).not.toHaveBeenCalled();

      // Leaving the page with only a hand up leaves no draft behind
      act(() => window.dispatchEvent(new Event('pagehide')));
      expect(window.sessionStorage.getItem('openmaic:raised-hand-draft:stage-1')).toBeNull();
      await remountOwner();
      expect(window.sessionStorage.getItem('openmaic:raised-hand-draft:stage-1')).toBeNull();
    });

    it('words the wait by what is in flight', async () => {
      mocks.speechInFlight = false;
      await raiseWhilePlaying();
      expect(composerHand().waitsFor).toBe('step');
    });

    it('onHandCalled cues the learner: the panel opens on 互动 and the composer takes focus', async () => {
      settingsState.chatAreaCollapsed = true;
      await raiseWhilePlaying();
      expect(settingsState.setChatAreaCollapsed).not.toHaveBeenCalled();

      callAtBoundary();
      expect(composerHand().state).toBe('called');
      expect(mocks.composerProps?.isCueUser).toBe(true);
      expect(captionElementProps()?.isCueUser).toBe(true);
      expect(mocks.participantsProps?.userHandRaised).toBe(true);
      expect(settingsState.setChatAreaCollapsed).toHaveBeenCalledWith(false);
      expect(mocks.switchToTab).toHaveBeenCalledWith('interaction');
      // Quietly: focusing must not count as opening the input
      expect(mocks.openTextInput).toHaveBeenCalledOnce();
      expect(mocks.focusComposer).not.toHaveBeenCalled();
    });

    it('does not steal focus from where the learner is busy outside the panel', async () => {
      await raiseWhilePlaying();
      const elsewhere = document.createElement('input');
      document.body.appendChild(elsewhere);
      try {
        elsewhere.focus();
        mocks.openTextInput.mockClear();
        callAtBoundary();
        expect(mocks.composerProps?.isCueUser).toBe(true);
        expect(mocks.openTextInput).not.toHaveBeenCalled();
        expect(document.activeElement).toBe(elsewhere);
      } finally {
        elsewhere.remove();
      }
    });

    it('放下 after the call resumes the lecture at once and ends the cue', async () => {
      await raiseWhilePlaying();
      callAtBoundary();
      let lowered = false;
      act(() => {
        lowered = composerHand().onLower();
      });
      expect(lowered).toBe(true);
      expect(mocks.lowerHand).toHaveBeenCalledOnce();
      expect(mocks.engineResume).toHaveBeenCalledOnce();
      expect(composerHand().state).toBeNull();
      expect(mocks.composerProps?.isCueUser).toBe(false);
    });

    it('撤回 before the boundary withdraws the hand and the lecture plays on', async () => {
      await raiseWhilePlaying();
      act(() => {
        composerHand().onLower();
      });
      expect(mocks.lowerHand).toHaveBeenCalledOnce();
      expect(mocks.engineResume).not.toHaveBeenCalled();
      expect(mocks.enginePause).not.toHaveBeenCalled();
      expect(composerHand().state).toBeNull();
      expect(mocks.participantsProps?.userHandRaised).toBe(false);
    });

    it('a question typed while the hand waits rides on it (attachQuestion), as a draft', async () => {
      await raiseWhilePlaying();
      click('send');
      expect(mocks.attachQuestion).toHaveBeenCalledExactlyOnceWith('Explain this');
      expect(mocks.queueUserInterrupt).not.toHaveBeenCalled();
      expect(mocks.handleUserInterrupt).not.toHaveBeenCalled();
      expect(mocks.lastSendResult).toBe('queued');
      expect(composerHand().state).toBeNull();
      expect(mocks.composerProps?.queuedQuestion).toMatchObject({
        text: 'Explain this',
        status: 'queued',
      });
      // Now there is text to give back: it is kept like any raised question
      act(() => window.dispatchEvent(new Event('pagehide')));
      expect(window.sessionStorage.getItem('openmaic:raised-hand-draft:stage-1')).toContain(
        'Explain this',
      );

      // Delivered at the same boundary, like any queued question
      mocks.queuedText = null;
      act(() => mocks.engineOptions?.onUserInterrupt?.('Explain this'));
      expect(mocks.sendMessage).toHaveBeenCalledOnce();
      expect(mocks.sendMessage.mock.calls[0][0]).toBe('Explain this');
      expect(mocks.composerProps?.queuedQuestion).toMatchObject({ status: 'delivered' });
    });

    it('a question sent once called goes out at once and ends the call', async () => {
      await raiseWhilePlaying();
      callAtBoundary();
      click('send');
      expect(mocks.handleUserInterrupt).toHaveBeenCalledExactlyOnceWith('Explain this');
      expect(mocks.sendMessage).toHaveBeenCalledOnce();
      expect(composerHand().state).toBeNull();
    });

    it('pause with a raised hand calls the learner immediately', async () => {
      await raiseWhilePlaying();
      await act(async () => {
        await (mocks.canvasProps?.onPlayPause as () => Promise<void>)();
      });
      expect(mocks.flushQueuedInterrupt).toHaveBeenCalledOnce();
      expect(mocks.enginePause).not.toHaveBeenCalled();
      expect(composerHand().state).toBe('called');
      expect(mocks.composerProps?.isCueUser).toBe(true);

      // Play again: the lecture resumes and the hand's turn is over
      await act(async () => {
        await (mocks.canvasProps?.onPlayPause as () => Promise<void>)();
      });
      expect(mocks.engineResume).toHaveBeenCalledOnce();
      expect(composerHand().state).toBeNull();
    });

    it('while paused or idle the learner is called at once', async () => {
      mocks.engineMode = 'paused';
      await renderOwner();
      act(() => {
        composerHand().onRaise();
      });
      expect(composerHand().state).toBe('called');
      expect(mocks.openTextInput).toHaveBeenCalledOnce();
    });

    it('voice with a raised hand calls it now (the mic would record the line) and keeps the recording', async () => {
      await raiseWhilePlaying();
      act(() => (mocks.composerProps?.onInputActivate as (kind: 'voice') => void)('voice'));
      expect(mocks.flushQueuedInterrupt).toHaveBeenCalledOnce();
      expect(mocks.enginePause).not.toHaveBeenCalled();
      expect(composerHand().state).toBe('called');
      expect(mocks.openTextInput).not.toHaveBeenCalled();
    });

    it('names the discussion the hand jumped ahead of, and hands it back when offered again', async () => {
      mocks.registryAgents = { 'default-1': { name: 'Kai' } };
      await raiseWhilePlaying();
      const trigger: { id: string; question: string; agentId?: string } = {
        id: 'trigger-1',
        question: 'Why green?',
      };
      callAtBoundary(trigger);
      // The agent is picked now, so the card offered later names the same one
      expect(trigger.agentId).toBe('default-1');
      expect(mocks.participantsProps?.discussionAgentId).toBe('default-1');
      // The row names whose discussion now waits behind the learner
      expect(container.querySelector('[data-testid="stream-hand-raised"]')?.textContent).toBe(
        'stage.handRaise.aheadOfDiscussion',
      );
      expect(container.querySelector('[data-testid="stream-cue"]')?.textContent).toContain(
        'stage.handRaise.calledBy',
      );

      act(() => {
        composerHand().onLower();
      });
      const options = mocks.engineOptions as unknown as {
        onProactiveShow: (trigger: Record<string, unknown>) => void;
      };
      act(() => options.onProactiveShow(trigger));
      expect(mocks.proactiveProps).toMatchObject({ action: { agentId: 'default-1' } });
      expect(container.querySelector('[data-testid="stream-hand-raised"]')).toBeNull();
    });

    it('shows the queued question as a pending bubble in the stream', async () => {
      mocks.engineMode = 'playing';
      await renderOwner();
      expect(container.querySelector('[data-testid="stream-pending-question"]')).toBeNull();
      click('send');
      const bubble = container.querySelector('[data-testid="stream-pending-question"]');
      expect(bubble?.textContent).toContain('Explain this');
      expect(bubble?.textContent).toContain('stage.handRaise.pendingQuestion');
    });

    it('H raises or lowers through the composer, opening a collapsed panel', async () => {
      settingsState.chatAreaCollapsed = true;
      await renderOwner();
      pressKey('h');
      expect(mocks.toggleHand).toHaveBeenCalledOnce();
      expect(settingsState.setChatAreaCollapsed).toHaveBeenCalledWith(false);
    });

    it('counts the caption down to the lecture while an interrupting Q&A soft-closes', async () => {
      await renderOwner();
      const onSoftClosingChange = () =>
        mocks.chatAreaProps?.onSoftClosingChange as (
          soft: boolean,
          deadline?: number,
          endReason?: string,
        ) => void;
      act(() => onSoftClosingChange()(true, 12_345, 'back_to_lesson'));
      // No lecture to go back to: no countdown
      expect(captionElementProps()?.lectureResumeDeadline).toBeUndefined();

      mocks.lectureCompletionPending = true; // the fake engine's hasLectureInterruption
      act(() => onSoftClosingChange()(true, 12_345, 'back_to_lesson'));
      expect(captionElementProps()?.lectureResumeDeadline).toBe(12_345);
      act(() => onSoftClosingChange()(false));
      expect(captionElementProps()?.lectureResumeDeadline).toBeUndefined();

      // A close that will not hand back to the lecture (the learner said
      // goodbye, or no reason yet) promises no resume
      act(() => onSoftClosingChange()(true, 12_345, 'user_goodbye'));
      expect(captionElementProps()?.lectureResumeDeadline).toBeUndefined();
      act(() => onSoftClosingChange()(true, 12_345));
      expect(captionElementProps()?.lectureResumeDeadline).toBeUndefined();
      act(() => onSoftClosingChange()(true, 12_345, 'user_done'));
      expect(captionElementProps()?.lectureResumeDeadline).toBe(12_345);
    });

    it('reveals a collapsed panel on 互动 for a discussion offer, as for a cue', async () => {
      settingsState.chatAreaCollapsed = true;
      mocks.engineMode = 'playing';
      await renderOwner();
      const options = mocks.engineOptions as unknown as {
        onProactiveShow: (trigger: Record<string, unknown>) => void;
      };
      act(() => options.onProactiveShow({ id: 'trigger-2', question: 'Why?', agentId: 'a' }));
      expect(settingsState.setChatAreaCollapsed).toHaveBeenCalledWith(false);
      expect(mocks.switchToTab).toHaveBeenCalledWith('interaction');
    });
  });

  describe('fullscreen: the presentation dock holds the one composer', () => {
    let fullscreenElement: Element | null = null;

    function pressKey(key: string) {
      act(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }),
        );
      });
    }

    async function togglePresentation() {
      await act(async () => {
        await (mocks.controlBarProps?.onTogglePresentation as () => Promise<void>)();
      });
    }

    beforeEach(() => {
      fullscreenElement = null;
      Object.defineProperty(document, 'fullscreenElement', {
        configurable: true,
        get: () => fullscreenElement,
      });
      HTMLElement.prototype.requestFullscreen = vi.fn(function (this: HTMLElement) {
        // The element asked for fullscreen gets it
        return Promise.resolve(this).then((element) => {
          fullscreenElement = element;
          document.dispatchEvent(new Event('fullscreenchange'));
        });
      });
      document.exitFullscreen = vi.fn(async () => {
        fullscreenElement = null;
        document.dispatchEvent(new Event('fullscreenchange'));
      });
      settingsState.setSidebarCollapsed.mockReset();
    });

    afterEach(() => {
      Reflect.deleteProperty(document, 'fullscreenElement');
      Reflect.deleteProperty(HTMLElement.prototype, 'requestFullscreen');
      Reflect.deleteProperty(document, 'exitFullscreen');
    });

    it('moves the composer into the dock and back without remounting it, restoring the panels', async () => {
      await renderOwner();
      expect(mocks.composerMounts).toBe(1);

      await togglePresentation();
      expect(fullscreenElement).not.toBeNull();
      expect(mocks.presentationDockProps).toBeDefined();
      expect(settingsState.setChatAreaCollapsed).toHaveBeenCalledWith(true);
      expect(settingsState.setSidebarCollapsed).toHaveBeenCalledWith(true);
      // One composer, now in the dock's card: no second instance to react to
      // a returned or restored raised hand
      expect(container.querySelectorAll('[data-testid="send"]')).toHaveLength(1);
      expect(
        container.querySelector('[data-testid="presentation-dock"] [data-testid="send"]'),
      ).not.toBeNull();
      expect(mocks.composerMounts).toBe(1);
      expect(mocks.composerProps?.className).toContain('p-0');
      // The control bar floats inside the dock
      const controlBar = mocks.presentationDockProps?.controlBar as {
        props?: Record<string, unknown>;
      };
      expect(controlBar.props?.variant).toBe('floating');

      settingsState.setChatAreaCollapsed.mockClear();
      await togglePresentation();
      expect(fullscreenElement).toBeNull();
      expect(container.querySelector('[data-testid="presentation-dock"]')).toBeNull();
      expect(container.querySelectorAll('[data-testid="send"]')).toHaveLength(1);
      expect(mocks.composerMounts).toBe(1);
      // The panels come back as they were (both open here); an open panel
      // takes the composer as it is
      expect(settingsState.setChatAreaCollapsed).toHaveBeenCalledWith(false);
      expect(settingsState.setSidebarCollapsed).toHaveBeenLastCalledWith(false);
      expect(mocks.dismissComposer).not.toHaveBeenCalled();
    });

    it('drops a recording on the way out when the panel goes back collapsed', async () => {
      settingsState.chatAreaCollapsed = true;
      await renderOwner();
      await togglePresentation();
      await togglePresentation();
      expect(settingsState.setChatAreaCollapsed).toHaveBeenLastCalledWith(true);
      expect(mocks.dismissComposer).toHaveBeenCalledOnce();
    });

    it("routes T, V, Escape and the stream's continue to the dock; S and C do nothing", async () => {
      await renderOwner();
      await togglePresentation();
      settingsState.setChatAreaCollapsed.mockClear();
      settingsState.setSidebarCollapsed.mockClear();
      mocks.openTextInput.mockClear();

      pressKey('t');
      expect(mocks.dockOpenText).toHaveBeenCalledOnce();
      expect(mocks.focusComposer).not.toHaveBeenCalled();
      pressKey('v');
      expect(mocks.dockToggleVoice).toHaveBeenCalledOnce();
      expect(mocks.toggleVoice).not.toHaveBeenCalled();
      // Fullscreen keeps both panels collapsed: no reveal, no S / C
      pressKey('s');
      pressKey('c');
      expect(settingsState.setChatAreaCollapsed).not.toHaveBeenCalled();
      expect(settingsState.setSidebarCollapsed).not.toHaveBeenCalled();

      act(() => (mocks.chatAreaProps?.onSoftCloseContinued as () => void)());
      expect(mocks.dockContinueText).toHaveBeenCalledOnce();
      expect(mocks.openTextInput).not.toHaveBeenCalled();

      // Composing (the dock's open card): Escape closes it and stays in fullscreen
      act(() =>
        (mocks.presentationDockProps?.onInteractionChange as (active: boolean) => void)(true),
      );
      pressKey('Escape');
      expect(mocks.dockClose).toHaveBeenCalledOnce();
      expect(document.exitFullscreen).not.toHaveBeenCalled();
      expect(fullscreenElement).not.toBeNull();

      // Not composing: Escape leaves fullscreen
      act(() =>
        (mocks.presentationDockProps?.onInteractionChange as (active: boolean) => void)(false),
      );
      await act(async () => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
        await Promise.resolve();
      });
      expect(mocks.dockClose).toHaveBeenCalledOnce();
      expect(document.exitFullscreen).toHaveBeenCalledOnce();
    });

    it("hands the composer's line, its sends and the raised hand to the dock", async () => {
      mocks.engineMode = 'playing';
      await renderOwner();
      await togglePresentation();

      act(() => (mocks.composerProps?.onInteractionChange as (active: boolean) => void)(true));
      expect(mocks.presentationDockProps?.isComposing).toBe(true);

      click('send');
      expect(mocks.lastSendResult).toBe('queued');
      expect(mocks.presentationDockProps?.hasRaisedHand).toBe(true);

      act(() => (mocks.composerProps?.onSent as () => void)());
      expect(mocks.dockCloseAfterSend).toHaveBeenCalledOnce();

      // A bare hand keeps the card up too, and its call cues the dock
      act(() => (mocks.composerProps?.onCancelQueuedQuestion as () => void)());
      expect(mocks.presentationDockProps?.hasRaisedHand).toBe(false);
      act(() => {
        (mocks.composerProps?.hand as { onRaise: () => boolean }).onRaise();
      });
      expect(mocks.presentationDockProps?.hasRaisedHand).toBe(true);
      mocks.handState = 'called';
      mocks.engineMode = 'paused';
      act(() => mocks.engineOptions?.onHandCalled?.({ atBoundary: true }));
      expect(mocks.presentationDockProps?.isCueUser).toBe(true);
      expect(mocks.dockContinueText).toHaveBeenCalledOnce();
      act(() => (mocks.composerProps?.onUserMessage as (text: string) => void)('Explain this'));
      expect(mocks.dockShowUserMessage).toHaveBeenCalledExactlyOnceWith('Explain this');
    });

    it('offers a discussion over the dock, portaled into the fullscreen element', async () => {
      mocks.engineMode = 'paused';
      await renderOwner();
      await togglePresentation();
      mocks.switchToTab.mockClear();

      const options = mocks.engineOptions as unknown as {
        onProactiveShow: (trigger: Record<string, unknown>) => void;
      };
      act(() =>
        options.onProactiveShow({ id: 'trigger-1', question: 'Why green?', agentId: 'agent-2' }),
      );
      // Not in the (collapsed) stream: over the dock
      expect(mocks.proactiveProps).toBeUndefined();
      expect(mocks.switchToTab).not.toHaveBeenCalled();
      expect(mocks.presentationDockProps?.discussionRequest).toMatchObject({
        topic: 'Why green?',
        agentId: 'agent-2',
      });
      const portalRef = mocks.presentationDockProps?.portalContainerRef as {
        current: Element | null;
      };
      expect(portalRef.current).toBe(fullscreenElement);

      act(() => (mocks.presentationDockProps?.onDiscussionStart as () => void)());
      expect(mocks.confirmDiscussion).toHaveBeenCalledOnce();
      act(() => (mocks.presentationDockProps?.onDiscussionSkip as () => void)());
      expect(mocks.skipDiscussion).toHaveBeenCalledOnce();
    });
  });
});
