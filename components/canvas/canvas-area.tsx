'use client';

import { useCallback, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Play } from 'lucide-react';
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

interface CanvasAreaProps {
  readonly currentScene: Scene | null;
  readonly mode: StageMode;
  readonly engineState: 'idle' | 'playing' | 'paused';
  /** A Q&A / discussion owns the slide: no click-to-play, no play hint */
  readonly isLiveSession?: boolean;
  readonly whiteboardOpen: boolean;
  readonly onPlayPause: () => void;
  readonly onWhiteboardClose: () => void;
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
  const showPlayHint =
    showControls &&
    engineState !== 'playing' &&
    currentScene?.type === 'slide' &&
    !isLiveSession &&
    !isPendingScene;

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

  return (
    <div
      className={cn(
        'w-full h-full flex flex-col items-center bg-page group/canvas',
        stageColumn ? 'gap-3 px-4 pt-1 pb-4' : 'p-2',
        isInteractive && 'bg-blue-50/30 dark:bg-blue-900/10',
      )}
    >
      {/* Slide slot — takes the height the caption leaves */}
      <div
        className={cn(
          'flex-1 min-h-0 w-full relative flex items-center justify-center',
          stageColumn && 'max-w-[1280px]',
          isInteractive && 'overflow-hidden',
        )}
      >
        <StageViewport
          fill={isInteractive || showCompletePage}
          className={cn(
            'bg-card overflow-hidden relative transition-[box-shadow,background-color] duration-700',
            showControls && !isLiveSession && currentScene?.type === 'slide' && 'cursor-pointer',
            isInteractive
              ? 'rounded-lg shadow-2xl shadow-blue-200/50 dark:shadow-blue-900/50 ring-1 ring-blue-900/5 dark:ring-blue-500/10'
              : 'rounded-[10px] shadow-[0_25px_50px_-12px_rgba(229,231,235,0.6),0_0_0_1px_rgba(3,7,18,0.06)] dark:shadow-[0_25px_50px_-12px_rgba(0,0,0,0.5),0_0_0_1px_rgba(255,255,255,0.06)]',
          )}
          onClick={handleSlideClick}
        >
          {/* Whiteboard Layer */}
          <div className="absolute inset-0 z-[110] pointer-events-none">
            <SceneProvider>
              <Whiteboard
                isOpen={whiteboardOpen}
                onClose={onWhiteboardClose}
                elementPickActive={elementPickActive && whiteboardOpen}
                whiteboardElementReference={whiteboardElementReference}
                onPickElement={onPickWhiteboardElement}
                onCancelElementPick={onCancelElementPick}
              />
            </SceneProvider>
          </div>

          {/* Scene Content */}
          {currentScene && !whiteboardOpen && (
            <div className="absolute inset-0">
              <SceneProvider>
                <SceneRenderer scene={currentScene} mode={mode} />
              </SceneProvider>
            </div>
          )}

          {elementPickActive &&
            !whiteboardOpen &&
            onPickElement &&
            onCancelElementPick &&
            currentScene?.type === 'slide' &&
            currentScene.content.type === 'slide' && (
              <SlideElementPickOverlay
                scene={currentScene}
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
      </div>

      {caption && (
        <div className={cn('w-full shrink-0', stageColumn && 'max-w-[1280px]')}>{caption}</div>
      )}
    </div>
  );
}

function StageViewport({
  fill,
  className,
  onClick,
  children,
}: {
  /** Take the whole slot (interactive scenes, the course-complete page) */
  readonly fill: boolean;
  readonly className?: string;
  readonly onClick?: (event: React.MouseEvent) => void;
  readonly children: ReactNode;
}) {
  if (fill) {
    return (
      <div className={cn('h-full w-full', className)} onClick={onClick}>
        {children}
      </div>
    );
  }
  // Contain-fit 16:9 in whatever the slot leaves (the caption below, a
  // workbench pane's width): never height-driven, so the slide cannot overflow
  return (
    <ContainBox fit="contain" className={className}>
      <div className="relative h-full w-full" onClick={onClick}>
        {children}
      </div>
    </ContainBox>
  );
}
