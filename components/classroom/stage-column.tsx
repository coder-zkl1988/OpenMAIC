'use client';

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { AnimatePresence, MotionConfig, motion, useReducedMotion } from 'motion/react';
import { Maximize2, Presentation } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { CLASSROOM_ASPECT_RATIO, containBox } from '@/lib/edit/contain-box';

/** The docked slide (ClassroomWhiteboard.dc.html): 192×108, 16:9. */
export const PIP_WIDTH = 192;
export const PIP_HEIGHT = 108;
/** The PiP's corner radius, at its real (docked) size. */
export const PIP_RADIUS = 10;
/** The caption under the slide; it grows to the PiP's height beside the board. */
export const CAPTION_HEIGHT = 92;
/** Between the slide (or the board card) and the caption row; also caption ↔ PiP. */
export const STAGE_GAP = 12;
/** The floating PiP's inset when there is no caption row (fullscreen). */
export const FLOATING_INSET = 16;
/**
 * Fullscreen has no caption row, and the presentation dock owns the bottom
 * corners (the teacher's line bottom left, the dock bottom right). The PiP
 * floats top left in a strip of its own, so it covers neither the board
 * sheet nor the teacher's bubble.
 */
export const FLOATING_STRIP = FLOATING_INSET + PIP_WIDTH + STAGE_GAP;
/** Board card chrome around the 16:9 sheet: 44px header, 12px padding, 1px border. */
const CARD_CHROME_X = 12 * 2 + 2;
const CARD_CHROME_Y = 44 + 12 * 2 + 2;
/**
 * How much taller than the slide's slot the board card is when it spans the
 * full width (its chrome is taller than it is wide at 16:9). A phone stage
 * grows by this while the board is open so the chip mode's board is full width.
 */
export const CHIP_BOARD_EXTRA_HEIGHT = Math.ceil(
  CARD_CHROME_Y - CARD_CHROME_X / CLASSROOM_ASPECT_RATIO,
);

/** The slide's morph into the PiP and back: 0.55s, the artboard's easing. */
const MORPH_EASE = [0.32, 0.72, 0, 1] as const;
const MORPH_S = 0.55;
/** The PiP's badge and expand icon fade in once the slide has nearly landed. */
const PIP_OVERLAY_DELAY_S = 0.4;

export interface StageGeometryInput {
  /** The column's layout size (untransformed). */
  readonly width: number;
  readonly height: number;
  /** A caption row sits under the slide. */
  readonly hasCaption: boolean;
  /** No caption row (fullscreen): the PiP floats top left, in its own strip. */
  readonly floatingPip: boolean;
  /**
   * `chip` (phone, below 600px): no PiP; the board takes the slide's whole
   * slot and a 返回课件 chip leads back. Defaults to `dock`.
   */
  readonly pipMode?: 'dock' | 'chip';
}

export interface StageGeometry {
  /** The board card hugging its 16:9 sheet, or null before the column is measured. */
  readonly card: { readonly width: number; readonly height: number } | null;
  /** Translate + scale (origin 0 0) that lands the slide's 16:9 box on the PiP. */
  readonly flip: { readonly x: number; readonly y: number; readonly scale: number };
}

/**
 * Where the board card and the docked slide go. The slide keeps the layout box
 * it has in slide mode (the slot above the 92px caption), so docking is only a
 * transform: no ResizeObserver fires and the global canvasScale is untouched.
 */
export function computeStageGeometry({
  width,
  height,
  hasCaption,
  floatingPip,
  pipMode = 'dock',
}: StageGeometryInput): StageGeometry {
  const slotHeight = Math.max(0, height - (hasCaption ? CAPTION_HEIGHT + STAGE_GAP : 0));
  const chip = pipMode === 'chip';
  const boardSlotWidth = Math.max(0, width - (floatingPip && !chip ? FLOATING_STRIP : 0));
  const boardSlotHeight = chip
    ? slotHeight
    : Math.max(0, height - (floatingPip ? 0 : PIP_HEIGHT + STAGE_GAP));
  const sheet = containBox(
    boardSlotWidth - CARD_CHROME_X,
    boardSlotHeight - CARD_CHROME_Y,
    CLASSROOM_ASPECT_RATIO,
  );
  const card =
    sheet.width > 0
      ? { width: sheet.width + CARD_CHROME_X, height: sheet.height + CARD_CHROME_Y }
      : null;

  // The slide is contain-fitted and centred in its slot (ContainBox); with the
  // chip it stays where it is and only fades
  const box = containBox(width, slotHeight, CLASSROOM_ASPECT_RATIO);
  if (box.width <= 0 || chip) return { card, flip: { x: 0, y: 0, scale: 1 } };
  const pipLeft = floatingPip ? FLOATING_INSET : width - PIP_WIDTH;
  const pipTop = floatingPip ? FLOATING_INSET : height - PIP_HEIGHT;
  const scale = PIP_WIDTH / box.width;
  return {
    card,
    flip: {
      x: pipLeft - scale * ((width - box.width) / 2),
      y: pipTop - scale * ((slotHeight - box.height) / 2),
      scale,
    },
  };
}

export interface StageColumnProps {
  /** The whiteboard has the slot; the scene is docked in the PiP. */
  readonly boardOpen: boolean;
  /**
   * `slide` morphs the live scene into the PiP; `card` hides the scene and the
   * PiP shows `pipCard` instead (interactive, quiz, PBL and the pending pages)
   */
  readonly pipKind: 'slide' | 'card';
  readonly pipCard?: ReactNode;
  /** 1-based page of the docked scene, for the PiP's badge and label. */
  readonly pageNumber: number;
  /** The PiP was clicked: back to the slide. */
  readonly onReturn: () => void;
  /**
   * The scene. `docked` stays true until the slide is back at full size, so
   * the scene can hold click-to-play, the play hint and the picker until then.
   * A docked slide reads `--stage-scene-radius` (PIP_RADIUS divided by the
   * dock's scale) for its corners, so it clips to the PiP's real 10px radius.
   */
  readonly renderScene: (state: { readonly docked: boolean }) => ReactNode;
  /** The whiteboard card; it fills the board slot and animates itself in and out. */
  readonly board: ReactNode;
  readonly caption?: ReactNode;
  /** No caption row (fullscreen): the PiP floats top left, beside the board. */
  readonly floatingPip?: boolean;
  /**
   * `chip` (phone, owner decision): below 600px a 192×108 PiP would crowd the
   * caption, so the board takes the slide's whole slot (the caption keeps its
   * full width) and a 返回课件 chip over the board's corner returns.
   */
  readonly pipMode?: 'dock' | 'chip';
  readonly className?: string;
  /** On the scene layer only (an interactive scene clips its shadow there). */
  readonly sceneClassName?: string;
}

/**
 * The stage column (ClassroomWhiteboard.dc.html). Slide mode: the scene over
 * the caption. Board mode: the board card takes the slide's slot, the caption
 * narrows to calc(100% − 204px) × 108px and the still-mounted slide morphs
 * into the 192×108 PiP beside it. The PiP (or the control bar's 白板 toggle)
 * swaps back; reduced motion swaps instantly. On a phone (`pipMode="chip"`)
 * the board takes the slide's slot instead and a 返回课件 chip swaps back.
 */
export function StageColumn({
  boardOpen,
  pipKind,
  pipCard,
  pageNumber,
  onReturn,
  renderScene,
  board,
  caption,
  floatingPip = false,
  pipMode = 'dock',
  className,
  sceneClassName,
}: StageColumnProps) {
  const { t } = useI18n();
  const reduceMotion = useReducedMotion() ?? false;
  const columnRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const hasCaption = !!caption;

  useLayoutEffect(() => {
    const el = columnRef.current;
    if (!el) return;
    const measure = () =>
      setSize((current) =>
        current.width === el.clientWidth && current.height === el.clientHeight
          ? current
          : { width: el.clientWidth, height: el.clientHeight },
      );
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Still docked while the slide flies back: the scene stays inert until it lands
  const [returning, setReturning] = useState(false);
  const [previousOpen, setPreviousOpen] = useState(boardOpen);
  if (previousOpen !== boardOpen) {
    setPreviousOpen(boardOpen);
    setReturning(!boardOpen && !reduceMotion);
  }
  useEffect(() => {
    if (!returning) return;
    const timer = window.setTimeout(() => setReturning(false), MORPH_S * 1000);
    return () => window.clearTimeout(timer);
  }, [returning]);
  const docked = boardOpen || returning;

  // A keyboard return lands on the slide once it is back (it is inert until
  // then), not on <body> after the PiP button unmounts
  const sceneBodyRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef(false);
  // The PiP and the phone's chip share it
  const handleReturn = (event: MouseEvent<HTMLButtonElement>) => {
    restoreFocusRef.current = document.activeElement === event.currentTarget;
    onReturn();
  };
  useEffect(() => {
    // Reopened before the slide landed: the board has the focus story now
    if (boardOpen) restoreFocusRef.current = false;
    if (docked || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    sceneBodyRef.current?.focus({ preventScroll: true });
  }, [boardOpen, docked]);

  const chip = pipMode === 'chip';
  const { card, flip } = computeStageGeometry({ ...size, hasCaption, floatingPip, pipMode });
  // A slide flies into the PiP; any other scene (and every scene with the
  // chip) fades out behind the board
  const sceneTarget =
    pipKind === 'slide' && !chip
      ? boardOpen
        ? { x: flip.x, y: flip.y, scale: flip.scale, opacity: 1 }
        : { x: 0, y: 0, scale: 1, opacity: 1 }
      : { x: 0, y: 0, scale: 1, opacity: boardOpen ? 0 : 1 };
  // The docked slide's corners at its real size match the PiP's ring
  const sceneRadius = pipKind === 'slide' && boardOpen ? PIP_RADIUS / flip.scale : PIP_RADIUS;
  const sceneTransition = reduceMotion
    ? { duration: 0 }
    : pipKind === 'slide' && !chip
      ? { duration: MORPH_S, ease: MORPH_EASE }
      : { duration: 0.2 };

  return (
    <MotionConfig reducedMotion="user">
      <div
        ref={columnRef}
        data-testid="stage-column"
        data-board-open={boardOpen ? 'true' : 'false'}
        className={cn('relative min-h-0 w-full flex-1', className)}
      >
        {/* Scene: first in the DOM, so a coinciding screen-element id resolves to the
            slide, and above the board while it morphs. Its layout box never changes */}
        <motion.div
          data-testid="stage-scene"
          className={cn(
            'absolute inset-x-0 top-0 z-[2]',
            docked && 'pointer-events-none',
            sceneClassName,
          )}
          style={{ bottom: hasCaption ? CAPTION_HEIGHT + STAGE_GAP : 0, transformOrigin: '0 0' }}
          initial={false}
          animate={sceneTarget}
          transition={sceneTransition}
        >
          <div
            ref={sceneBodyRef}
            className="flex h-full w-full items-center justify-center outline-none"
            inert={docked}
            aria-hidden={docked || undefined}
            role="group"
            aria-label={t('stage.currentScene')}
            tabIndex={-1}
            style={{ '--stage-scene-radius': `${sceneRadius}px` } as CSSProperties}
          >
            {renderScene({ docked })}
          </div>
        </motion.div>

        {/* Board slot: the card hugs its 16:9 sheet, centred like the slide */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 z-[1] flex items-center justify-center"
          style={
            chip
              ? { left: 0, bottom: hasCaption ? CAPTION_HEIGHT + STAGE_GAP : 0 }
              : {
                  left: floatingPip ? FLOATING_STRIP : 0,
                  bottom: floatingPip ? 0 : PIP_HEIGHT + STAGE_GAP,
                }
          }
        >
          <div
            className="relative"
            style={
              card ? { width: card.width, height: card.height } : { width: '100%', height: '100%' }
            }
          >
            {board}
          </div>
        </div>

        {/* Caption: full width under the slide, narrowed beside the PiP */}
        {hasCaption && (
          <div
            data-testid="stage-caption"
            className="absolute bottom-0 left-0 z-[1] transition-[width,height] duration-[550ms] ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none"
            style={{
              width: boardOpen && !chip ? `calc(100% - ${PIP_WIDTH + STAGE_GAP}px)` : '100%',
              height: boardOpen && !chip ? PIP_HEIGHT : CAPTION_HEIGHT,
            }}
          >
            {caption}
          </div>
        )}

        {/* Phone: the 返回课件 chip over the board's bottom-start corner */}
        <AnimatePresence>
          {boardOpen && chip && (
            <motion.button
              key="return-chip"
              type="button"
              data-testid="whiteboard-return-chip"
              onClick={handleReturn}
              aria-label={t('stage.pip.returnLabel', { n: pageNumber })}
              className="absolute start-2 z-[3] flex h-11 items-center gap-1.5 rounded-full border border-line bg-background/95 ps-3 pe-3.5 text-[13px] font-semibold text-fg-secondary shadow-[0_6px_16px_-8px_rgba(0,0,0,0.35)] outline-none backdrop-blur-sm transition-colors hover:text-fg focus-visible:ring-2 focus-visible:ring-accent-line cursor-pointer"
              style={{ bottom: (hasCaption ? CAPTION_HEIGHT + STAGE_GAP : 0) + 8 }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1, transition: { duration: reduceMotion ? 0 : 0.2 } }}
              exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : 0.15 } }}
            >
              <Presentation aria-hidden="true" className="size-4 shrink-0 text-icon" />
              {t('stage.pip.return')}
            </motion.button>
          )}
        </AnimatePresence>

        {/* PiP: a real button over the inert slide, badge and expand icon */}
        <AnimatePresence>
          {boardOpen && !chip && (
            <motion.div
              key="pip"
              data-testid="stage-pip"
              className={cn('absolute z-[3]', floatingPip ? 'top-4 left-4' : 'right-0 bottom-0')}
              style={{ width: PIP_WIDTH, height: PIP_HEIGHT }}
              initial={{ opacity: 0 }}
              animate={{
                opacity: 1,
                transition: reduceMotion
                  ? { duration: 0 }
                  : { duration: 0.2, delay: PIP_OVERLAY_DELAY_S },
              }}
              exit={{ opacity: 0, transition: { duration: reduceMotion ? 0 : 0.15 } }}
            >
              {pipKind === 'card' && (
                <div className="absolute inset-0 overflow-hidden rounded-[10px] bg-background">
                  {pipCard}
                </div>
              )}
              <button
                type="button"
                data-testid="whiteboard-pip"
                onClick={handleReturn}
                aria-label={t('stage.pip.returnLabel', { n: pageNumber })}
                title={t('stage.pip.return')}
                className="absolute inset-0 cursor-pointer rounded-[10px] shadow-[0_0_0_1px_var(--line-strong),0_8px_20px_-10px_rgba(0,0,0,0.3)] outline-none focus-visible:ring-2 focus-visible:ring-accent-line focus-visible:ring-offset-2 focus-visible:ring-offset-page"
              />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute bottom-1.5 left-1.5 rounded-full bg-fg/75 px-2 py-0.5 text-[11px] font-semibold text-page"
              >
                {t('stage.pip.badge', { n: pageNumber })}
              </span>
              <span
                aria-hidden="true"
                className="pointer-events-none absolute top-1.5 right-1.5 flex size-6 items-center justify-center rounded-full bg-background/95 text-fg-secondary shadow-[0_1px_3px_rgba(0,0,0,0.2)]"
              >
                <Maximize2 className="size-3" strokeWidth={2.25} />
              </span>
            </motion.div>
          )}
        </AnimatePresence>
      </div>
    </MotionConfig>
  );
}
