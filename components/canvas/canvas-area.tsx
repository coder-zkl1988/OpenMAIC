'use client';

import { useCallback, useEffect, useRef, type ReactNode, type Ref } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import {
  GraduationCap,
  ListChecks,
  Loader2,
  MousePointerClick,
  Play,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { SceneRenderer } from '@/components/stage/scene-renderer';
import { SceneProvider } from '@/lib/contexts/scene-context';
import { Whiteboard } from '@/components/whiteboard';
import type { Scene, StageMode } from '@/lib/types/stage';
import { useI18n } from '@/lib/hooks/use-i18n';
import { ClassroomCompletePageConnected } from '@/components/scene-renderers/classroom-complete';
import { ContainBox } from '@/components/edit/ContainBox';
import { useInWorkbenchPanel } from '@/lib/workbench/panel-context';
import type { PPTElement } from '@openmaic/dsl';
import type { WhiteboardElementReference } from '@/lib/types/chat';
import { SlideElementPickOverlay } from '@/components/canvas/slide-element-pick-overlay';
import { StageColumn } from '@/components/classroom/stage-column';
import { useCanvasStore } from '@/lib/store/canvas';

interface CanvasAreaProps {
  readonly currentScene: Scene | null;
  readonly mode: StageMode;
  readonly engineState: 'idle' | 'playing' | 'paused';
  /** A Q&A / discussion owns the slide: no click-to-play, no play hint */
  readonly isLiveSession?: boolean;
  readonly whiteboardOpen: boolean;
  readonly onPlayPause: () => void;
  /** The docked slide (PiP) was clicked: back to the slide */
  readonly onWhiteboardClose: () => void;
  /** 1-based page of the current scene, for the PiP's 课件 · 第 N 页 badge */
  readonly pageNumber?: number;
  readonly isPresenting?: boolean;
  readonly isPendingScene?: boolean;
  readonly isCourseComplete?: boolean;
  readonly isGenerationFailed?: boolean;
  /** The pending scene will never be produced (its generation was interrupted). */
  readonly isGenerationInterrupted?: boolean;
  readonly onRetryGeneration?: () => void;
  readonly elementPickActive?: boolean;
  readonly whiteboardElementReference?: WhiteboardElementReference;
  readonly onPickWhiteboardElement?: (element: PPTElement) => void;
  readonly onPickElement?: (element: PPTElement) => void;
  readonly onCancelElementPick?: () => void;
  /** The caption strip under the slide (the shell decides when it shows) */
  readonly caption?: ReactNode;
}

export function CanvasArea({
  currentScene,
  mode,
  engineState,
  isLiveSession,
  whiteboardOpen,
  onPlayPause,
  onWhiteboardClose,
  pageNumber,
  isPresenting,
  isPendingScene,
  isCourseComplete,
  isGenerationFailed,
  isGenerationInterrupted,
  onRetryGeneration,
  elementPickActive,
  whiteboardElementReference,
  onPickElement,
  onPickWhiteboardElement,
  onCancelElementPick,
  caption,
}: CanvasAreaProps) {
  const { t } = useI18n();
  const inWorkbenchPanel = useInWorkbenchPanel();
  const isInteractive = currentScene?.type === 'interactive';
  // The course-complete page adapts its own layout to the height it gets
  // (compact below FULL_MIN, full above FULL_SAFE), so it takes the whole slot
  // instead of a width-driven 16:9 box
  const showCompletePage = !!isPendingScene && !currentScene && !!isCourseComplete;
  // The standalone classroom lays the slide and its caption out as one column
  // (Classroom.dc.html); a workbench pane and fullscreen keep the slim frame
  const stageColumn = !isInteractive && !inWorkbenchPanel && !isPresenting;
  const showControls = mode === 'playback' && !whiteboardOpen;
  const sceneRef = useRef<HTMLDivElement>(null);

  // The slide stays mounted while the board has its slot: a playing video
  // pauses rather than keep playing (with sound) in the PiP, and clearing
  // playingVideoElementId releases a play_video the engine is waiting on
  useEffect(() => {
    if (!whiteboardOpen) return;
    const canvas = useCanvasStore.getState();
    if (canvas.playingVideoElementId) canvas.pauseVideo();
    sceneRef.current?.querySelectorAll('video').forEach((video) => video.pause());
  }, [whiteboardOpen]);

  const handleSlideClick = useCallback(
    (e: React.MouseEvent) => {
      if (!showControls || isLiveSession || currentScene?.type !== 'slide') return;
      // Don't trigger page play/pause when clicking inside a video element's visual area.
      // Video elements may be visually covered by other slide elements (e.g. text),
      // so we check click coordinates against all video element bounding rects.
      const container = e.currentTarget as HTMLElement;
      const videoEls = container.querySelectorAll('[data-video-element]');
      for (const el of videoEls) {
        const rect = el.getBoundingClientRect();
        if (
          e.clientX >= rect.left &&
          e.clientX <= rect.right &&
          e.clientY >= rect.top &&
          e.clientY <= rect.bottom
        ) {
          return;
        }
      }
      onPlayPause();
    },
    [showControls, isLiveSession, onPlayPause, currentScene?.type],
  );

  const board = (
    <SceneProvider>
      <Whiteboard
        isOpen={whiteboardOpen}
        elementPickActive={elementPickActive && whiteboardOpen}
        whiteboardElementReference={whiteboardElementReference}
        onPickElement={onPickWhiteboardElement}
        onCancelElementPick={onCancelElementPick}
      />
    </SceneProvider>
  );

  const renderScene = ({ docked }: { readonly docked: boolean }) => {
    // Held until a docked slide is back at full size (it is inert meanwhile)
    const sceneControls = showControls && !docked;
    const showPlayHint =
      sceneControls &&
      engineState !== 'playing' &&
      currentScene?.type === 'slide' &&
      !isLiveSession &&
      !isPendingScene;

    return (
      <StageViewport
        fill={isInteractive || showCompletePage}
        className={cn(
          'bg-card overflow-hidden relative',
          sceneControls && !isLiveSession && currentScene?.type === 'slide' && 'cursor-pointer',
          isInteractive
            ? cn(SCENE_TRANSITION, INTERACTIVE_FRAME)
            : currentScene?.type === 'slide'
              ? // A docked slide clips to the PiP's real 10px corners (the stage
                // column scales the radius up as it scales the slide down) and,
                // as on the artboard, drops its shadow under the PiP's own ring
                cn(
                  'rounded-[var(--stage-scene-radius,10px)] [transition:box-shadow_700ms,background-color_700ms,border-radius_550ms_cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none',
                  docked ? 'shadow-none' : SLIDE_SHADOW,
                )
              : cn(SCENE_TRANSITION, 'rounded-[10px]', SLIDE_SHADOW),
        )}
        onClick={handleSlideClick}
        contentRef={sceneRef}
      >
        {/* Scene Content — a slide stays mounted while it is docked; an interactive
            scene gives its pooled iframe up (it would paint over the board) and
            takes it back, without a reload, once the slide slot is its own again */}
        {currentScene && !(isInteractive && docked) && (
          <div className="absolute inset-0">
            <SceneProvider>
              <SceneRenderer scene={currentScene} mode={mode} />
            </SceneProvider>
          </div>
        )}

        {elementPickActive &&
          !docked &&
          onPickElement &&
          onCancelElementPick &&
          currentScene?.type === 'slide' &&
          currentScene.content.type === 'slide' && (
            <SlideElementPickOverlay
              scene={currentScene}
              scopeRef={sceneRef}
              onPick={onPickElement}
              onCancel={onCancelElementPick}
            />
          )}

        {/* Pending Scene Loading / Completion Overlay */}
        <AnimatePresence>
          {showCompletePage && (
            <motion.div
              key="course-complete"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3, ease: 'easeOut' }}
              className="absolute inset-0"
            >
              <ClassroomCompletePageConnected />
            </motion.div>
          )}
          {isPendingScene && !currentScene && !isCourseComplete && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4, ease: 'easeOut' }}
              className="absolute inset-0 z-[105] flex flex-col items-center justify-center bg-white dark:bg-gray-800"
            >
              {isGenerationFailed || isGenerationInterrupted ? (
                <div className="flex flex-col items-center gap-3">
                  <div className="w-12 h-12 rounded-full bg-red-50 dark:bg-red-900/20 flex items-center justify-center">
                    <svg
                      className="w-6 h-6 text-red-400 dark:text-red-500"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={1.5}
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M12 9v3.75m9-.75a9 9 0 11-18 0 9 9 0 0118 0zm-9 3.75h.008v.008H12v-.008z"
                      />
                    </svg>
                  </div>
                  <span className="text-sm text-red-500 dark:text-red-400 font-medium">
                    {isGenerationInterrupted
                      ? t('stage.generationInterrupted')
                      : t('stage.generationFailed')}
                  </span>
                  {onRetryGeneration && !isGenerationInterrupted && (
                    <button
                      onClick={onRetryGeneration}
                      className="mt-1 px-4 py-1.5 text-xs font-medium rounded-full bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 hover:bg-red-100 dark:hover:bg-red-900/40 transition-colors active:scale-95"
                    >
                      {t('generation.retryScene')}
                    </button>
                  )}
                </div>
              ) : (
                <div className="flex flex-col items-center gap-4">
                  {/* Spinner */}
                  <div className="relative w-12 h-12">
                    <div className="absolute inset-0 rounded-full border-2 border-gray-100 dark:border-gray-700" />
                    <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-purple-500 dark:border-t-purple-400 animate-spin" />
                  </div>
                  {/* Text */}
                  <motion.span
                    initial={{ opacity: 0, y: 4 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.2, duration: 0.3 }}
                    className="text-sm text-gray-400 dark:text-gray-500 font-medium"
                  >
                    {t('stage.generatingNextPage')}
                  </motion.span>
                </div>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Play hint — breathing button when idle or paused (slides only); the
              control bar's play button is the labelled control */}
        <AnimatePresence>
          {showPlayHint && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.3 }}
              className="absolute inset-0 z-[102] flex items-center justify-center pointer-events-none"
            >
              <motion.div
                data-testid="play-hint"
                className="opacity-50 group-hover/canvas:opacity-100 transition-opacity duration-300 pointer-events-auto cursor-pointer"
                exit={{ pointerEvents: 'none' }}
                onClick={(e) => {
                  e.stopPropagation();
                  onPlayPause();
                }}
              >
                <motion.div
                  initial={{ scale: 0.85 }}
                  animate={{ scale: [1, 1.06] }}
                  exit={{ scale: 1.15, opacity: 0 }}
                  transition={{
                    default: { duration: 0.3, ease: [0.4, 0, 0.2, 1] },
                    scale: {
                      repeat: Infinity,
                      repeatType: 'mirror',
                      duration: 1,
                      ease: 'easeInOut',
                    },
                  }}
                  className="w-20 h-20 rounded-full bg-white/95 dark:bg-gray-800/95 flex items-center justify-center shadow-[0_4px_30px_rgba(147,51,234,0.15),inset_0_0_0_1px_rgba(233,213,255,0.5)] dark:shadow-[0_4px_30px_rgba(147,51,234,0.3),inset_0_0_0_1px_rgba(126,34,206,0.3)]"
                  style={{ willChange: 'transform' }}
                >
                  <Play className="w-7 h-7 text-purple-600 dark:text-purple-400 fill-purple-600/90 dark:fill-purple-400/90 ml-0.5" />
                </motion.div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </StageViewport>
    );
  };

  return (
    <div
      className={cn(
        'w-full h-full flex flex-col items-center bg-page group/canvas',
        // TabletLandscape.dc.html seats the slide right under the header
        stageColumn ? 'px-4 pt-1 pb-4 @max-desktop/classroom:pt-0' : 'p-2',
        isInteractive && 'bg-blue-50/30 dark:bg-blue-900/10',
      )}
    >
      <StageColumn
        className={cn(stageColumn && 'max-w-[1280px]')}
        // Clip an interactive scene's shadow at its own slot, not the column's:
        // the PiP, its focus ring and the board card's ring stay whole
        sceneClassName={cn(isInteractive && 'overflow-hidden')}
        boardOpen={whiteboardOpen}
        pipKind={currentScene?.type === 'slide' ? 'slide' : 'card'}
        pipCard={<PipSceneCard scene={currentScene} isCourseComplete={!!isCourseComplete} />}
        pageNumber={pageNumber ?? (currentScene?.order ?? 0) + 1}
        // A click on the PiP while it fades out must not reopen the board
        onReturn={() => {
          if (whiteboardOpen) onWhiteboardClose();
        }}
        renderScene={renderScene}
        board={board}
        caption={caption}
        floatingPip={!caption && !!isPresenting}
      />
    </div>
  );
}

const SCENE_TRANSITION = 'transition-[box-shadow,background-color] duration-700';
const INTERACTIVE_FRAME =
  'rounded-lg shadow-2xl shadow-blue-200/50 dark:shadow-blue-900/50 ring-1 ring-blue-900/5 dark:ring-blue-500/10';
const SLIDE_SHADOW =
  'shadow-[0_25px_50px_-12px_rgba(229,231,235,0.6),0_0_0_1px_rgba(3,7,18,0.06)] dark:shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5),0_0_0_1px_rgba(255,255,255,0.06)]';

const PIP_SCENE_ICONS: Partial<Record<Scene['type'], LucideIcon>> = {
  quiz: ListChecks,
  interactive: MousePointerClick,
  pbl: Users,
};

/** What the PiP shows for a scene that is not a slide (it does not shrink live) */
function PipSceneCard({
  scene,
  isCourseComplete,
}: {
  readonly scene: Scene | null;
  readonly isCourseComplete: boolean;
}) {
  const { t } = useI18n();
  const Icon = scene
    ? (PIP_SCENE_ICONS[scene.type] ?? ListChecks)
    : isCourseComplete
      ? GraduationCap
      : Loader2;
  const title = scene
    ? scene.title || t(`edit.sceneType.${scene.type}`)
    : isCourseComplete
      ? t('stage.courseComplete')
      : t('stage.generatingNextPage');
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-1.5 bg-subtle px-4 pb-5 text-center">
      <Icon
        className={cn(
          'size-5 shrink-0 text-icon-muted',
          Icon === Loader2 && 'motion-safe:animate-spin',
        )}
        aria-hidden="true"
      />
      <span className="line-clamp-2 text-xs font-semibold text-fg-secondary">{title}</span>
    </div>
  );
}

function StageViewport({
  fill,
  className,
  onClick,
  contentRef,
  children,
}: {
  /** Take the whole slot (interactive scenes, the course-complete page) */
  readonly fill: boolean;
  readonly className?: string;
  readonly onClick?: (event: React.MouseEvent) => void;
  /** The box the scene renders in (its media, the slide picker's scope) */
  readonly contentRef?: Ref<HTMLDivElement>;
  readonly children: ReactNode;
}) {
  if (fill) {
    return (
      <div ref={contentRef} className={cn('h-full w-full', className)} onClick={onClick}>
        {children}
      </div>
    );
  }
  // Contain-fit 16:9 in whatever the slot leaves (the caption below, a
  // workbench pane's width): never height-driven, so the slide cannot overflow
  return (
    <ContainBox fit="contain" className={className}>
      <div ref={contentRef} className="relative h-full w-full" onClick={onClick}>
        {children}
      </div>
    </ContainBox>
  );
}
