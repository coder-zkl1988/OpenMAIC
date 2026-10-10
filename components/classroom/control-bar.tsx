'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Check,
  Maximize2,
  Minimize2,
  MoreHorizontal,
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
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
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
  /**
   * `touch` (tablet and narrower, TabletLandscape.dc.html): a 56px bar of
   * 44px targets, centred, with no page counter (the header shows "n / m")
   * and an icon-only whiteboard toggle
   */
  readonly density?: 'default' | 'touch';
  /**
   * The page counter on the left. Defaults to on for `default` density and
   * off for `touch`; the host turns it back on when no header carries it
   */
  readonly showPageCounter?: boolean;
  /**
   * Phone (ClassroomPhone.dc.html, with `touch`): a 52px bar where speed,
   * volume and auto-play fold into a ⋯ sheet, and the disabled prev / next
   * step aside for the stop pill during a Q&A / discussion
   */
  readonly condensed?: boolean;
  /** Where the ⋯ sheet portals (the fullscreen stage element while presenting) */
  readonly portalContainer?: HTMLElement | null;
  readonly className?: string;
}

/* 32px icon button (Classroom.dc.html control bar) */
const iconBtn = cn(
  'relative flex size-8 shrink-0 items-center justify-center rounded-[10px] text-icon',
  'transition-colors outline-none cursor-pointer hover:bg-subtle hover:text-fg active:scale-95',
  'focus-visible:ring-2 focus-visible:ring-ring/50',
  'disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent disabled:active:scale-100',
);

/* 44px touch target (TabletLandscape.dc.html control bar) */
const touchBtn = cn(iconBtn, 'size-11');

/* A 44px row of the phone's ⋯ sheet */
const sheetRow = cn(
  'flex h-11 w-full items-center gap-2.5 rounded-[10px] px-2.5 text-sm text-fg',
  'transition-colors outline-none cursor-pointer hover:bg-subtle focus-visible:ring-2 focus-visible:ring-ring/50',
  'disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent',
);

/* Pressed state shared by the 白板 toggle and the reference picker */
const pressedBtn =
  'bg-accent-soft text-accent-text ring-1 ring-inset ring-accent-line hover:bg-accent-soft hover:text-accent-text';

/* The phone bar (ClassroomPhone.dc.html) spaces its dividers 4px, the tablet 8px */
function Divider({ touch, condensed }: { touch?: boolean; condensed?: boolean }) {
  return (
    <div
      aria-hidden="true"
      className={cn(
        'shrink-0 w-px bg-line',
        condensed ? 'mx-1 h-5' : touch ? 'mx-2 h-5' : 'mx-1.5 h-4',
      )}
    />
  );
}

function VolumeIcon({
  muted,
  volume,
  disabled,
  touch,
}: {
  muted: boolean;
  volume: number;
  disabled: boolean;
  touch?: boolean;
}) {
  const cls = touch ? 'size-[18px]' : 'size-4';
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
  density = 'default',
  showPageCounter,
  condensed = false,
  portalContainer,
  className,
}: ControlBarProps) {
  const { t } = useI18n();
  const touch = density === 'touch';
  const withPageCounter = showPageCounter ?? !touch;
  const btn = touch ? touchBtn : iconBtn;
  const icon = touch ? 'size-[18px]' : 'size-4';
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
  // Phone: prev / next are disabled during a session anyway, so they give the
  // stop pill their room
  const showSceneNav = !(condensed && inSession);

  // Phone: speed, volume and auto-play in one ⋯ sheet above the bar
  const hasPlaybackSettings = !!(onCycleSpeed || onToggleMute || onToggleAutoPlay);
  const playbackSheet = condensed && hasPlaybackSettings && (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="control-bar-more"
          className={cn(
            btn,
            'data-[state=open]:bg-subtle data-[state=open]:text-fg',
            // Something in the sheet is off its default: hint at it
            (playbackSpeed !== 1 || (ttsEnabled && ttsMuted)) && 'text-accent-text',
          )}
          aria-label={t('stage.playbackMenu')}
          title={t('stage.playbackMenu')}
        >
          <MoreHorizontal className={icon} />
        </button>
      </PopoverTrigger>
      <PopoverContent
        container={portalContainer}
        side="top"
        align="end"
        sideOffset={8}
        aria-label={t('stage.playbackMenu')}
        data-testid="control-bar-sheet"
        className="w-[min(18rem,calc(100vw-1.5rem))] rounded-[14px] p-1.5"
      >
        {onCycleSpeed && (
          <button
            type="button"
            onClick={onCycleSpeed}
            className={sheetRow}
            aria-label={`${t('stage.playbackSpeed')} ${playbackSpeed}x`}
          >
            <span className="flex-1 text-start">{t('stage.playbackSpeed')}</span>
            <span
              aria-hidden="true"
              className={cn(
                'rounded-md px-1.5 text-[13px] font-semibold tabular-nums',
                playbackSpeed !== 1 ? 'bg-accent-soft text-accent-text' : 'text-fg-secondary',
              )}
            >
              {`${playbackSpeed}x`}
            </span>
          </button>
        )}
        {onToggleMute && (
          <div className="flex h-11 items-center gap-1 pe-2.5">
            <button
              type="button"
              onClick={onToggleMute}
              disabled={!ttsEnabled}
              className={cn(touchBtn, ttsEnabled && ttsMuted && 'text-danger hover:text-danger')}
              aria-label={ttsMuted ? t('stage.unmute') : t('stage.mute')}
            >
              <VolumeIcon muted={!!ttsMuted} volume={ttsVolume} disabled={!ttsEnabled} touch />
            </button>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={effectiveVolume}
              disabled={!ttsEnabled}
              aria-label={t('stage.volume')}
              onChange={(e) => {
                const v = parseFloat(e.target.value);
                onVolumeChange?.(v);
                if (v > 0 && ttsMuted) onToggleMute?.();
              }}
              className={cn(
                'h-1 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-line-strong disabled:cursor-not-allowed disabled:opacity-40',
                '[&::-webkit-slider-thumb]:size-5 [&::-webkit-slider-thumb]:cursor-pointer [&::-webkit-slider-thumb]:appearance-none',
                '[&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow-sm',
                '[&::-moz-range-thumb]:size-5 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0 [&::-moz-range-thumb]:bg-primary',
              )}
            />
            <span
              aria-hidden="true"
              className="w-8 shrink-0 select-none text-end text-xs font-medium tabular-nums text-fg-tertiary"
            >
              {Math.round(effectiveVolume * 100)}
            </span>
          </div>
        )}
        {onToggleAutoPlay && (
          <button
            type="button"
            onClick={onToggleAutoPlay}
            className={sheetRow}
            aria-pressed={!!autoPlayLecture}
          >
            <Repeat
              aria-hidden="true"
              className={cn('size-[18px]', autoPlayLecture ? 'text-accent-text' : 'text-icon')}
            />
            <span className="flex-1 text-start">{t('roundtable.autoPlay')}</span>
            {autoPlayLecture && <Check aria-hidden="true" className="size-4 text-accent-text" />}
          </button>
        )}
      </PopoverContent>
    </Popover>
  );

  const fullscreenButton = onTogglePresentation && (
    <button
      type="button"
      onClick={onTogglePresentation}
      className={cn(btn, isPresenting && 'text-accent-text hover:text-accent-text')}
      aria-label={presentationLabel}
      title={presentationLabel}
    >
      {isPresenting ? <Minimize2 className={icon} /> : <Maximize2 className={icon} />}
    </button>
  );

  return (
    <div
      data-testid="control-bar"
      data-variant={variant}
      data-density={density}
      className={cn(
        'flex items-center gap-3',
        variant === 'bar'
          ? cn(
              'w-full shrink-0 border-t border-line bg-background/85',
              touch ? cn(condensed ? 'h-13' : 'h-14', 'px-2') : 'h-12 pl-4 pr-3',
            )
          : cn(
              'rounded-full border border-line bg-background/85 shadow-[0_8px_32px_rgba(0,0,0,0.08)] backdrop-blur-xl dark:shadow-[0_8px_32px_rgba(0,0,0,0.4)]',
              touch ? cn(condensed ? 'h-13' : 'h-14', 'px-2') : 'h-12 px-3',
            ),
        className,
      )}
    >
      {/* ── Left: page counter (touch: the header shows "n / m") ── */}
      {withPageCounter && (
        <span
          data-testid="page-counter"
          className={cn(
            'shrink-0 select-none whitespace-nowrap text-xs font-medium tabular-nums text-fg-tertiary',
            variant === 'bar' && 'min-w-[72px]',
          )}
        >
          {t('stage.pageCounter', { current: currentSceneIndex + 1, total: scenesCount })}
        </span>
      )}

      {/* ── Centre: transport, playback settings, whiteboard, reference ── */}
      <div className="flex min-w-0 flex-1 items-center justify-center gap-1">
        {showSceneNav && (
          <button
            type="button"
            onClick={onPrev}
            disabled={!canGoPrev}
            className={btn}
            aria-label={t('stage.previousScene')}
          >
            <ChevronLeft className={icon} />
          </button>
        )}

        {inSession ? (
          <>
            {/* The mouse path to pause / resume a live answer (Space works too) */}
            {onToggleLivePause && (
              <button
                type="button"
                onClick={onToggleLivePause}
                disabled={!livePaused && !canToggleLivePause}
                className={btn}
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
              className={cn(
                'flex items-center gap-1.5 whitespace-nowrap rounded-[10px] border border-danger/30 bg-danger-soft px-3 font-semibold text-danger transition-colors hover:border-danger/50 active:scale-95 cursor-pointer',
                touch ? 'h-11 text-sm' : 'h-8 text-xs',
                // Phone: a long label truncates rather than push the bar wide
                condensed ? 'min-w-0 shrink' : 'shrink-0',
              )}
              title={condensed ? stopLabel : undefined}
            >
              <CircleStop className="size-3 shrink-0" />
              {condensed ? <span className="min-w-0 truncate">{stopLabel}</span> : stopLabel}
            </button>
          </>
        ) : (
          <button
            type="button"
            onClick={onPlayPause}
            className={cn(
              'flex shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground shadow-[0_2px_8px_color-mix(in_srgb,var(--primary)_30%,transparent)] transition-colors outline-none hover:bg-primary/90 focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-95 cursor-pointer',
              touch ? 'size-11' : 'size-8',
            )}
            aria-label={isPlaying ? t('stage.pause') : t('stage.play')}
          >
            {isPlaying ? (
              <Pause className={cn('fill-current', touch ? 'size-4' : 'size-3.5')} />
            ) : (
              <Play className={cn('ml-0.5 fill-current', touch ? 'size-4' : 'size-3.5')} />
            )}
          </button>
        )}

        {showSceneNav && (
          <button
            type="button"
            onClick={onNext}
            disabled={!canGoNext}
            className={btn}
            aria-label={t('stage.nextScene')}
          >
            <ChevronRight className={icon} />
          </button>
        )}

        <Divider touch={touch} condensed={condensed} />

        {!condensed && onCycleSpeed && (
          <TooltipProvider delayDuration={0}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onCycleSpeed}
                  className={cn(
                    btn,
                    touch
                      ? 'text-[13px] font-semibold tabular-nums'
                      : 'w-9 text-xs font-semibold tabular-nums',
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
        {!condensed && onToggleMute && (
          <div
            className="relative flex items-center"
            onMouseEnter={handleVolumeEnter}
            onMouseLeave={handleVolumeLeave}
          >
            <button
              type="button"
              onClick={onToggleMute}
              disabled={!ttsEnabled}
              className={cn(btn, ttsEnabled && ttsMuted && 'text-danger hover:text-danger')}
              aria-label={ttsMuted ? t('stage.unmute') : t('stage.mute')}
            >
              <VolumeIcon
                muted={!!ttsMuted}
                volume={ttsVolume}
                disabled={!ttsEnabled}
                touch={touch}
              />
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

        {!condensed && onToggleAutoPlay && (
          <TooltipProvider delayDuration={0}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  onClick={onToggleAutoPlay}
                  className={cn(btn, autoPlayLecture && 'text-accent-text hover:text-accent-text')}
                  aria-label={t('roundtable.autoPlay')}
                  aria-pressed={!!autoPlayLecture}
                >
                  <Repeat className={icon} />
                </button>
              </TooltipTrigger>
              <TooltipContent side="top" className="text-xs">
                {autoPlayLecture ? t('roundtable.autoPlayOff') : t('roundtable.autoPlay')}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        )}

        {!condensed && <Divider touch={touch} />}

        {/* Labeled whiteboard toggle (touch: the 44px icon button) */}
        <button
          type="button"
          data-testid="whiteboard-toggle"
          onClick={onToggleWhiteboard}
          aria-pressed={whiteboardOpen}
          aria-label={touch ? t('stage.whiteboardToggle') : undefined}
          title={whiteboardTitle}
          className={cn(
            touch
              ? cn(touchBtn, 'hover:bg-subtle')
              : 'relative flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-[10px] pl-2.5 pr-3 text-xs font-semibold',
            'transition-colors outline-none cursor-pointer active:scale-95 focus-visible:ring-2 focus-visible:ring-ring/50',
            whiteboardOpen ? pressedBtn : 'text-icon hover:bg-subtle hover:text-fg',
          )}
        >
          <PencilLine className={icon} />
          {!touch && t('stage.whiteboardToggle')}
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
            className={cn(btn, elementPickActive && pressedBtn)}
            aria-label={t('chat.elementReference.button')}
            aria-pressed={!!elementPickActive}
            title={
              canPickElement
                ? t('chat.elementReference.button')
                : t('chat.elementReference.unavailable')
            }
          >
            <Quote className={touch ? 'size-[17px]' : 'size-[15px]'} />
          </button>
        )}

        {playbackSheet}

        {touch && fullscreenButton}
      </div>

      {/* ── Right: fullscreen (touch: in the centre cluster) ── */}
      {!touch && (
        <div className={cn('flex shrink-0 justify-end', variant === 'bar' && 'min-w-[72px]')}>
          {fullscreenButton}
        </div>
      )}
    </div>
  );
}
