'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Maximize2,
  Minimize2,
  Pause,
  PencilLine,
  Play,
  Quote,
  Repeat,
  Volume1,
  Volume2,
  VolumeX,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import { useStageStore } from '@/lib/store';
import { useI18n } from '@/lib/hooks/use-i18n';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import type { StopKind } from '@/components/canvas/use-playback-controls';

export interface ControlBarProps {
  readonly currentSceneIndex: number;
  readonly scenesCount: number;
  readonly engineState: 'idle' | 'playing' | 'paused';
  /**
   * A Q&A / discussion is open: the stop pill (with the live pause / resume
   * button) replaces play and prev/next are disabled
   */
  readonly showStop?: boolean;
  readonly stopKind?: StopKind;
  readonly onStop?: () => void;
  /** The live answer's text reveal is paused (Q&A / discussion) */
  readonly livePaused?: boolean;
  /** Whether the live answer can be paused or resumed right now */
  readonly canToggleLivePause?: boolean;
  /** Buffer-level pause / resume of the live answer, shown next to the stop pill */
  readonly onToggleLivePause?: () => void;
  readonly onPrev: () => void;
  readonly onNext: () => void;
  /** The primary play action (usePlaybackControls().primaryAction) */
  readonly onPlayPause: () => void;
  readonly whiteboardOpen: boolean;
  readonly onToggleWhiteboard: () => void;
  readonly isPresenting?: boolean;
  readonly onTogglePresentation?: () => void;
  // Audio / playback settings
  readonly ttsEnabled?: boolean;
  readonly ttsMuted?: boolean;
  readonly ttsVolume?: number;
  readonly onToggleMute?: () => void;
  readonly onVolumeChange?: (volume: number) => void;
  readonly autoPlayLecture?: boolean;
  readonly onToggleAutoPlay?: () => void;
  readonly playbackSpeed?: number;
  readonly onCycleSpeed?: () => void;
  // Element reference ("Reference content")
  readonly showElementReference?: boolean;
  readonly canPickElement?: boolean;
  readonly elementPickActive?: boolean;
  readonly onToggleElementPick?: () => void;
  /** `bar`: the 48px strip under the stage; `floating`: the fullscreen pill */
  readonly variant?: 'bar' | 'floating';
  readonly className?: string;
}

/* 32px icon button (Classroom.dc.html control bar) */
const iconBtn = cn(
  'relative flex size-8 shrink-0 items-center justify-center rounded-[10px] text-icon',
  'transition-colors outline-none cursor-pointer hover:bg-subtle hover:text-fg active:scale-95',
  'focus-visible:ring-2 focus-visible:ring-ring/50',
  'disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:active:scale-100',
);

/* Pressed state shared by the 白板 toggle and the reference picker */
const pressedBtn =
  'bg-accent-soft text-accent-text ring-1 ring-inset ring-accent-line hover:bg-accent-soft hover:text-accent-text';

function Divider() {
  return <div aria-hidden="true" className="mx-1.5 h-4 w-px shrink-0 bg-line" />;
}

function VolumeIcon({
  muted,
  volume,
  disabled,
}: {
  muted: boolean;
  volume: number;
  disabled: boolean;
}) {
  const cls = 'size-4';
  if (disabled || muted || volume === 0) return <VolumeX className={cls} />;
  if (volume < 0.5) return <Volume1 className={cls} />;
  return <Volume2 className={cls} />;
}

/**
 * The classroom control bar: page counter, prev / play / next (or the red
 * stop pill during a Q&A / discussion), speed, volume, auto-play, the labeled
 * whiteboard toggle, "Reference content" and fullscreen. The shell renders it
 * under the stage, and as an auto-hiding pill while presenting.
 */
export function ControlBar({
  currentSceneIndex,
  scenesCount,
  engineState,
  showStop,
  stopKind = 'discussion',
  onStop,
  livePaused,
  canToggleLivePause,
  onToggleLivePause,
  onPrev,
  onNext,
  onPlayPause,
  whiteboardOpen,
  onToggleWhiteboard,
  isPresenting,
  onTogglePresentation,
  ttsEnabled,
  ttsMuted,
  ttsVolume = 1,
  onToggleMute,
  onVolumeChange,
  autoPlayLecture,
  onToggleAutoPlay,
  playbackSpeed = 1,
  onCycleSpeed,
  showElementReference,
  canPickElement,
  elementPickActive,
  onToggleElementPick,
  variant = 'bar',
  className,
}: ControlBarProps) {
  const { t } = useI18n();
  const inSession = !!showStop && !!onStop;
  // Leaving the page mid-session goes through the stop pill (owner decision)
  const canGoPrev = !inSession && currentSceneIndex > 0;
  const canGoNext = !inSession && currentSceneIndex < scenesCount - 1;
  const isPlaying = engineState === 'playing';

  const whiteboardElementCount = useStageStore(
    (s) => s.stage?.whiteboard?.[0]?.elements?.length || 0,
  );

  // Volume slider hover state
  const [volumeHover, setVolumeHover] = useState(false);
  const volumeTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const handleVolumeEnter = useCallback(() => {
    clearTimeout(volumeTimerRef.current);
    setVolumeHover(true);
  }, []);
  const handleVolumeLeave = useCallback(() => {
    volumeTimerRef.current = setTimeout(() => setVolumeHover(false), 300);
  }, []);
  useEffect(() => () => clearTimeout(volumeTimerRef.current), []);

  const effectiveVolume = ttsMuted ? 0 : ttsVolume;
  const presentationLabel = isPresenting ? t('stage.exitFullscreen') : t('stage.fullscreen');
  const stopLabel = stopKind === 'qa' ? t('roundtable.stopQA') : t('roundtable.stopDiscussion');
  const livePauseLabel = livePaused ? t('stage.resumeAnswer') : t('stage.pauseAnswer');
  const whiteboardTitle = whiteboardOpen ? t('whiteboard.minimize') : t('whiteboard.open');

  return (
    <div
      data-testid="control-bar"
      data-variant={variant}
      className={cn(
        'flex items-center gap-3',
        variant === 'bar'
          ? 'h-12 w-full shrink-0 border-t border-line bg-background/85 pl-4 pr-3'
          : 'h-12 rounded-full border border-line bg-background/85 px-3 shadow-[0_8px_32px_rgba(0,0,0,0.08)] backdrop-blur-xl dark:shadow-[0_8px_32px_rgba(0,0,0,0.4)]',
        className,
      )}
    >
      {/* ── Left: page counter ── */}
      <span
        data-testid="page-counter"
        className={cn(
          'shrink-0 select-none whitespace-nowrap text-xs font-medium tabular-nums text-fg-tertiary',
          variant === 'bar' && 'min-w-[72px]',
        )}
      >
        {t('stage.pageCounter', { current: currentSceneIndex + 1, total: scenesCount })}
      </span>

      {/* ── Centre: transport, playback settings, whiteboard, reference ── */}
      <div className="flex min-w-0 flex-1 items-center justify-center gap-1">
        <button
          type="button"
          onClick={onPrev}
          disabled={!canGoPrev}
          className={iconBtn}
          aria-label={t('stage.previousScene')}
        >
          <ChevronLeft className="size-4" />
        </button>

        {inSession ? (
          <>
            {/* The mouse path to pause / resume a live answer (Space works too) */}
            {onToggleLivePause && (
              <button
                type="button"
                onClick={onToggleLivePause}
                disabled={!livePaused && !canToggleLivePause}
                className={iconBtn}
                aria-label={livePauseLabel}
                title={livePauseLabel}
              >
                {livePaused ? (
                  <Play className="ml-0.5 size-3.5 fill-current" />
                ) : (
                  <Pause className="size-3.5 fill-current" />
                )}
              </button>
            )}
            <button
              type="button"
              onClick={onStop}
              className="flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[10px] border border-danger/30 bg-danger-soft px-3 text-xs font-semibold text-danger transition-colors hover:border-danger/50 active:scale-95 cursor-pointer"
            >
              <CircleStop className="size-3" />
              {stopLabel}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onPlayPause}
            className="flex size-8 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_2px_8px_color-mix(in_srgb,var(--primary)_30%,transparent)] transition-colors outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-95 cursor-pointer"
            aria-label={isPlaying ? t('stage.pause') : t('stage.play')}
          >
            {isPlaying ? (
              <Pause className="size-3.5 fill-current" />
            ) : (
              <Play className="ml-0.5 size-3.5 fill-current" />
            )}
          </button>
        )}

        <button
          type="button"
          onClick={onNext}
          disabled={!canGoNext}
          className={iconBtn}
          aria-label={t('stage.nextScene')}
        >
          <ChevronRight className="size-4" />
        </button>

        <Divider />

        {onCycleSpeed && (
          <TooltipProvider delayDuration={0}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onCycleSpeed}
                  className={cn(
                    iconBtn,
                    'w-9 text-xs font-semibold tabular-nums',
                    playbackSpeed !== 1 && 'bg-accent-soft text-accent-text',
                  )}
                  aria-label={t('stage.playbackSpeed')}
                >
                  {`${playbackSpeed}x`}
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                {t('roundtable.speed')}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}

        {/* Volume with a vertical slider that pops up on hover */}
        {onToggleMute && (
          <div
            className="relative flex items-center"
            onMouseEnter={handleVolumeEnter}
            onMouseLeave={handleVolumeLeave}
          >
            <button
              type="button"
              onClick={onToggleMute}
              disabled={!ttsEnabled}
              className={cn(iconBtn, ttsEnabled && ttsMuted && 'text-danger hover:text-danger')}
              aria-label={ttsMuted ? t('stage.unmute') : t('stage.mute')}
            >
              <VolumeIcon muted={!!ttsMuted} volume={ttsVolume} disabled={!ttsEnabled} />
            </button>
            <div
              className={cn(
                'pointer-events-none absolute bottom-full left-1/2 mb-2 flex -translate-x-1/2 flex-col items-center opacity-0',
                'transition-opacity duration-200 ease-out',
                volumeHover && ttsEnabled && 'pointer-events-auto opacity-100',
              )}
            >
              <div className="flex flex-col items-center gap-1.5 rounded-[10px] border border-line bg-popover px-2 py-2.5 shadow-lg">
                <span className="select-none text-[10px] font-medium tabular-nums text-fg-tertiary">
                  {Math.round(effectiveVolume * 100)}
                </span>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={effectiveVolume}
                  aria-label={t('stage.volume')}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    onVolumeChange?.(v);
                    if (v > 0 && ttsMuted) onToggleMute?.();
                  }}
                  className={cn(
                    'h-16 w-1 cursor-pointer appearance-none rounded-full bg-line-strong',
                    '[direction:rtl] [writing-mode:vertical-lr]',
                    '[&::-webkit-slider-thumb]:size-3 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none',
                    '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow-sm',
                    '[&::-moz-range-thumb]:size-3 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-primary',
                  )}
                />
              </div>
            </div>
          </div>
        )}

        {onToggleAutoPlay && (
          <TooltipProvider delayDuration={0}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onToggleAutoPlay}
                  className={cn(
                    iconBtn,
                    autoPlayLecture && 'text-accent-text hover:text-accent-text',
                  )}
                  aria-label={t('roundtable.autoPlay')}
                  aria-pressed={!!autoPlayLecture}
                >
                  <Repeat className="size-4" />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                {autoPlayLecture ? t('roundtable.autoPlayOff') : t('roundtable.autoPlay')}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}

        <Divider />

        {/* Labeled whiteboard toggle */}
        <button
          type="button"
          onClick={onToggleWhiteboard}
          aria-pressed={whiteboardOpen}
          title={whiteboardTitle}
          className={cn(
            'relative flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[10px] pl-2.5 pr-3 text-xs font-semibold',
            'transition-colors outline-none cursor-pointer active:scale-95 focus-visible:ring-2 focus-visible:ring-ring/50',
            whiteboardOpen ? pressedBtn : 'text-icon hover:bg-subtle hover:text-fg',
          )}
        >
          <PencilLine className="size-4" />
          {t('stage.whiteboardToggle')}
          {/* The board has content to come back to */}
          {!whiteboardOpen && whiteboardElementCount > 0 && (
            <span
              aria-hidden="true"
              className="absolute right-1 top-1 size-1.5 rounded-full bg-primary"
            />
          )}
        </button>

        {showElementReference && (
          <button
            type="button"
            onClick={onToggleElementPick}
            disabled={!canPickElement}
            className={cn(iconBtn, elementPickActive && pressedBtn)}
            aria-label={t('chat.elementReference.button')}
            aria-pressed={!!elementPickActive}
            title={
              canPickElement
                ? t('chat.elementReference.button')
                : t('chat.elementReference.unavailable')
            }
          >
            <Quote className="size-[15px]" />
          </button>
        )}
      </div>

      {/* ── Right: fullscreen ── */}
      <div className={cn('flex shrink-0 justify-end', variant === 'bar' && 'min-w-[72px]')}>
        {onTogglePresentation && (
          <button
            type="button"
            onClick={onTogglePresentation}
            className={cn(iconBtn, isPresenting && 'text-accent-text hover:text-accent-text')}
            aria-label={presentationLabel}
            title={presentationLabel}
          >
            {isPresenting ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </button>
        )}
      </div>
    </div>
  );
}
