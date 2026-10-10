'use client';

import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import { CircleCheck, Eraser, History, Maximize, Minus, PencilLine, Plus } from 'lucide-react';
import type { PPTElement } from '@openmaic/dsl';
import type { WhiteboardElementReference } from '@/lib/types/chat';
import { ElementPickOverlay } from '@/components/canvas/slide-element-pick-overlay';
import { AvatarDisplay } from '@/components/ui/avatar-display';
import {
  getDisplayedWhiteboard,
  isWhiteboardReferenceAvailable,
} from '@/lib/whiteboard/element-reference';
import { WHITEBOARD_MAX_ZOOM, WHITEBOARD_MIN_ZOOM, WhiteboardCanvas } from './whiteboard-canvas';
import type { WhiteboardCanvasHandle, WhiteboardViewState } from './whiteboard-canvas';
import { WhiteboardHistory } from './whiteboard-history';
import { useStageStore } from '@/lib/store';
import { useCanvasStore, type WhiteboardDrawing } from '@/lib/store/canvas';
import { useSettingsStore } from '@/lib/store/settings';
import { useWhiteboardHistoryStore } from '@/lib/store/whiteboard-history';
import { agentsToParticipants, useAgentRegistry } from '@/lib/orchestration/registry/store';
import { createStageAPI } from '@/lib/api/stage-api';
import { restoreWhiteboardElements } from '@/lib/whiteboard/restore';
import { cn } from '@/lib/utils';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { refreshWhiteboardRuntimeProjection } from '@/lib/whiteboard/runtime/browser-projection';

/** −/+ step: 1.25 up, 0.8 down, so one step each way lands back on 100%. */
const ZOOM_STEP = 1.25;
/** How long the in-card "cleared · Undo" status stays up. */
const UNDO_TOAST_MS = 8000;
/** The card's open / close (ClassroomWhiteboard.dc.html), well within WB_OPEN_MS / WB_CLOSE_MS. */
const CARD_EASE = [0.32, 0.72, 0, 1] as const;
const CARD_OPEN_DELAY_S = 0.08;

interface WhiteboardProps {
  readonly isOpen: boolean;
  readonly elementPickActive?: boolean;
  readonly whiteboardElementReference?: WhiteboardElementReference;
  readonly onPickElement?: (element: PPTElement) => void;
  readonly onCancelElementPick?: () => void;
}

/** A user clear that can still be undone from the in-card status. */
interface ClearedBoard {
  readonly elements: PPTElement[];
  readonly viewportSize?: number;
  readonly viewportRatio?: number;
  /** Board shown right after the clear; the undo is only offered while it still is. */
  readonly displayedIdAfterClear: string | null;
}

/** Display name and avatar for the "… is drawing" chip (teacher when unnamed). */
function useDrawingAgent(drawing: WhiteboardDrawing | null) {
  const { t } = useI18n();
  const selectedAgentIds = useSettingsStore((s) => s.selectedAgentIds);
  const agents = useAgentRegistry((s) => s.agents);

  return useMemo(() => {
    if (!drawing) return null;
    const participants = agentsToParticipants(selectedAgentIds, t);
    if (drawing.agentId) {
      const participant = participants.find((p) => p.id === drawing.agentId);
      if (participant) return { name: participant.name, avatar: participant.avatar };
      const agent = agents[drawing.agentId];
      if (agent) return { name: agent.name, avatar: agent.avatar };
    }
    const teacher = participants.find((p) => p.role === 'teacher');
    return teacher ? { name: teacher.name, avatar: teacher.avatar } : null;
  }, [drawing, selectedAgentIds, agents, t]);
}

/** Three bars that pulse while the agent draws (static under reduced motion). */
function DrawingWave() {
  const reduceMotion = useReducedMotion();
  return (
    <span aria-hidden="true" className="inline-flex h-2.5 items-center gap-0.5 text-accent-text">
      {[0, 1, 2].map((i) => (
        <motion.span
          key={i}
          className="block h-2.5 w-[2.5px] rounded-[2px] bg-current"
          initial={{ scaleY: 0.35 }}
          animate={reduceMotion ? { scaleY: 0.7 } : { scaleY: [0.35, 1, 0.35] }}
          transition={
            reduceMotion
              ? { duration: 0 }
              : { duration: 1, ease: 'easeInOut', repeat: Infinity, delay: i * 0.15 }
          }
        />
      ))}
    </span>
  );
}

const headerIconButton =
  'flex size-8 shrink-0 items-center justify-center rounded-[10px] text-icon transition-colors hover:bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line disabled:pointer-events-none disabled:opacity-40';
// Empty board: the whole group dims, so `disabled` adds no opacity of its own.
// At a zoom limit the button stays focusable (aria-disabled) and dims itself.
const zoomButton =
  'flex size-7 items-center justify-center rounded-lg text-icon transition-colors hover:bg-subtle hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line disabled:pointer-events-none aria-disabled:cursor-default aria-disabled:opacity-40 aria-disabled:hover:bg-transparent aria-disabled:hover:text-icon';

/**
 * The whiteboard card. The stage column gives it the slide's slot; returning
 * to the slide is the PiP or the control bar's 白板 toggle, so the card has no
 * close button of its own. It unmounts after its exit, so a closed board is
 * gone from the page (and the runtime refresh keys on each open).
 */
export function Whiteboard({
  isOpen,
  elementPickActive,
  whiteboardElementReference,
  onPickElement,
  onCancelElementPick,
}: WhiteboardProps) {
  const { t } = useI18n();
  const reduceMotion = useReducedMotion();
  const stage = useStageStore.use.stage();
  const isClearing = useCanvasStore.use.whiteboardClearing();
  const drawing = useCanvasStore.use.whiteboardDrawing();
  const drawingAgent = useDrawingAgent(drawing);
  const clearingRef = useRef(false);
  const previousStageIdRef = useRef<string | undefined>(undefined);
  const wasOpenRef = useRef(isOpen);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [view, setView] = useState<WhiteboardViewState>({ zoom: 1, modified: false });
  const [clearedBoard, setClearedBoard] = useState<ClearedBoard | null>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<WhiteboardCanvasHandle>(null);
  const historyTriggerRef = useRef<HTMLButtonElement>(null);
  const historyPanelId = useId();
  const snapshotCount = useWhiteboardHistoryStore((s) => s.snapshots.length);
  const runtimeProjection = useCanvasStore.use.runtimeWhiteboardProjection();

  // Get element count for indicator
  const { source, whiteboard } = getDisplayedWhiteboard(stage, runtimeProjection);
  const runtimeAuthoritative = source === 'runtime_store';
  const selectedElementId =
    whiteboardElementReference &&
    isWhiteboardReferenceAvailable(whiteboardElementReference, stage, runtimeProjection)
      ? whiteboardElementReference.elementId
      : undefined;
  const elementCount = whiteboard?.elements?.length || 0;
  const boardEmpty = elementCount === 0;
  const zoomPercent = Math.round(view.zoom * 100);
  const atMinZoom = view.zoom <= WHITEBOARD_MIN_ZOOM;
  const atMaxZoom = view.zoom >= WHITEBOARD_MAX_ZOOM;

  // The undo is offered only while the cleared state is still what is shown:
  // new content (the AI drawing again, a history restore) retires it.
  const undoVisible =
    clearedBoard !== null &&
    !runtimeAuthoritative &&
    boardEmpty &&
    (whiteboard?.id ?? null) === clearedBoard.displayedIdAfterClear;

  useEffect(() => {
    const stageId = stage?.id;
    const stageChanged = previousStageIdRef.current !== stageId;
    const opened = !wasOpenRef.current && isOpen;
    previousStageIdRef.current = stageId;
    wasOpenRef.current = isOpen;

    if (!stageId) {
      useCanvasStore.getState().clearRuntimeWhiteboardProjection();
      return;
    }
    if (stageChanged || opened) {
      void refreshWhiteboardRuntimeProjection(stageId);
    }
  }, [isOpen, stage?.id]);

  useEffect(() => {
    if (runtimeAuthoritative) setHistoryOpen(false);
  }, [runtimeAuthoritative]);

  // The card unmounts on close but this component does not: a close that skips
  // the popover's outside press (AI wb_close, scene change) must not leave it
  // open, or the next open would remount it and pull focus out of the composer.
  useEffect(() => {
    if (!isOpen) setHistoryOpen(false);
  }, [isOpen]);

  useEffect(() => {
    if (!clearedBoard) return;
    const timer = window.setTimeout(() => setClearedBoard(null), UNDO_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [clearedBoard]);

  const closeHistory = useCallback(() => setHistoryOpen(false), []);

  const stageAPI = createStageAPI(useStageStore);

  const handleClear = async () => {
    if (!whiteboard || elementCount === 0 || clearingRef.current) return;
    clearingRef.current = true;
    setClearedBoard(null);

    // Keep the cleared board locally for the undo. Not "the latest snapshot":
    // pushSnapshot drops a fingerprint already stored anywhere in the stack, so
    // the newest snapshot is not necessarily this board.
    const cleared = {
      elements: JSON.parse(JSON.stringify(whiteboard.elements)) as PPTElement[],
      viewportSize: whiteboard.viewportSize,
      viewportRatio: whiteboard.viewportRatio,
    };

    // Save snapshot before clearing
    useWhiteboardHistoryStore.getState().pushSnapshot(whiteboard.elements, {
      viewportSize: whiteboard.viewportSize,
      viewportRatio: whiteboard.viewportRatio,
    });

    // Trigger cascade exit animation
    useCanvasStore.getState().setWhiteboardClearing(true);

    // Wait for cascade: base 380ms + 55ms per element, capped at 1400ms
    const animMs = Math.min(380 + elementCount * 55, 1400);
    await new Promise((resolve) => setTimeout(resolve, animMs));

    // Actually remove elements
    const result = stageAPI.whiteboard.delete(whiteboard.id);
    useCanvasStore.getState().setWhiteboardClearing(false);
    clearingRef.current = false;

    if (result.success) {
      const after = getDisplayedWhiteboard(
        useStageStore.getState().stage,
        useCanvasStore.getState().runtimeWhiteboardProjection,
      );
      setClearedBoard({ ...cleared, displayedIdAfterClear: after.whiteboard?.id ?? null });
    } else {
      toast.error(t('whiteboard.clearError') + result.error);
    }
  };

  const handleUndoClear = () => {
    if (!clearedBoard) return;
    const result = restoreWhiteboardElements(clearedBoard.elements, {
      viewport: {
        viewportSize: clearedBoard.viewportSize,
        viewportRatio: clearedBoard.viewportRatio,
      },
    });
    if (result.status === 'busy') {
      toast.error(t('whiteboard.restoreError'));
      return;
    }
    if (result.status === 'error') {
      toast.error(t('whiteboard.restoreError') + result.error);
      return;
    }
    setClearedBoard(null);
  };

  const historyLabel =
    snapshotCount > 0
      ? t('whiteboard.historyWithCount', { count: snapshotCount })
      : t('whiteboard.history');

  return (
    <>
      {/* Main Whiteboard Overlay */}
      <AnimatePresence>
        {isOpen && (
          <motion.section
            aria-label={t('whiteboard.title')}
            initial={{ opacity: 0, scale: 0.97 }}
            animate={{
              opacity: 1,
              scale: 1,
              transition: reduceMotion
                ? { duration: 0 }
                : {
                    opacity: { duration: 0.3, ease: 'easeOut', delay: CARD_OPEN_DELAY_S },
                    scale: { duration: 0.45, ease: CARD_EASE, delay: CARD_OPEN_DELAY_S },
                  },
            }}
            exit={{
              opacity: 0,
              scale: 0.97,
              transition: reduceMotion
                ? { duration: 0 }
                : {
                    opacity: { duration: 0.3, ease: 'easeOut' },
                    scale: { duration: 0.45, ease: CARD_EASE },
                  },
            }}
            className="absolute inset-0 pointer-events-auto bg-background rounded-[18px] border border-accent-line ring-4 ring-accent-soft shadow-[0_24px_60px_-24px_rgba(0,0,0,0.2)] flex flex-col overflow-hidden"
          >
            {/* Header */}
            <div className="h-11 shrink-0 pl-3 pr-2 border-b border-line flex items-center gap-2.5">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-accent-soft text-accent-text">
                <PencilLine className="size-4" aria-hidden="true" />
              </span>
              <h2 className="m-0 truncate text-[15px] font-semibold text-fg">
                {t('whiteboard.title')}
              </h2>

              <AnimatePresence>
                {drawing && (
                  <motion.span
                    key="drawing"
                    role="status"
                    data-testid="whiteboard-drawing-chip"
                    initial={{ opacity: 0, scale: 0.9 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.9 }}
                    transition={{ duration: 0.15 }}
                    className={cn(
                      'inline-flex h-[26px] min-w-0 shrink items-center gap-1.5 rounded-full bg-accent-soft pr-2.5 text-xs font-semibold text-accent-hover dark:text-accent-text',
                      drawingAgent?.avatar ? 'pl-[3px]' : 'pl-2.5',
                    )}
                  >
                    {drawingAgent?.avatar && (
                      <span className="size-5 shrink-0 overflow-hidden rounded-full text-[13px] leading-none">
                        <AvatarDisplay src={drawingAgent.avatar} />
                      </span>
                    )}
                    <span className="truncate">
                      {drawingAgent
                        ? t('whiteboard.drawing', { name: drawingAgent.name })
                        : t('whiteboard.drawingAnonymous')}
                    </span>
                    <DrawingWave />
                  </motion.span>
                )}
              </AnimatePresence>

              <div className="ml-auto flex shrink-0 items-center gap-1">
                <div
                  role="group"
                  aria-label={t('whiteboard.zoom')}
                  className={cn(
                    'flex h-8 items-center rounded-[10px] border border-line px-0.5',
                    boardEmpty && 'opacity-40',
                  )}
                >
                  <button
                    type="button"
                    onClick={() => {
                      if (!atMinZoom) canvasRef.current?.zoomBy(1 / ZOOM_STEP);
                    }}
                    disabled={boardEmpty}
                    aria-disabled={!boardEmpty && atMinZoom ? true : undefined}
                    className={zoomButton}
                    aria-label={t('whiteboard.zoomOut')}
                    title={t('whiteboard.zoomOut')}
                  >
                    <Minus className="size-3.5" aria-hidden="true" />
                  </button>
                  <span
                    data-testid="whiteboard-zoom-level"
                    aria-live="polite"
                    className="min-w-11 text-center text-xs font-semibold tabular-nums text-fg-secondary"
                  >
                    {`${zoomPercent}%`}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      if (!atMaxZoom) canvasRef.current?.zoomBy(ZOOM_STEP);
                    }}
                    disabled={boardEmpty}
                    aria-disabled={!boardEmpty && atMaxZoom ? true : undefined}
                    className={zoomButton}
                    aria-label={t('whiteboard.zoomIn')}
                    title={t('whiteboard.zoomIn')}
                  >
                    <Plus className="size-3.5" aria-hidden="true" />
                  </button>
                  <span aria-hidden="true" className="mx-0.5 h-4 w-px bg-line" />
                  <button
                    type="button"
                    onClick={() => canvasRef.current?.fit()}
                    disabled={boardEmpty}
                    className={zoomButton}
                    aria-label={t('whiteboard.fit')}
                    title={t('whiteboard.fit')}
                  >
                    <Maximize className="size-3.5" aria-hidden="true" />
                  </button>
                </div>

                {!runtimeAuthoritative && (
                  <>
                    <div className="relative">
                      <button
                        ref={historyTriggerRef}
                        type="button"
                        onClick={() => setHistoryOpen((open) => !open)}
                        className={cn(
                          headerIconButton,
                          'relative',
                          historyOpen &&
                            'bg-accent-soft text-accent-text hover:bg-accent-soft hover:text-accent-text',
                        )}
                        aria-label={historyLabel}
                        aria-haspopup="dialog"
                        aria-expanded={historyOpen}
                        aria-controls={historyOpen ? historyPanelId : undefined}
                        title={t('whiteboard.history')}
                      >
                        <History className="size-4" aria-hidden="true" />
                        {snapshotCount > 0 && (
                          <span
                            aria-hidden="true"
                            className="absolute top-px right-0 min-w-4 h-4 box-border px-1 rounded-full border-2 border-background bg-primary text-[9px] leading-3 font-bold text-primary-foreground text-center"
                          >
                            {snapshotCount}
                          </span>
                        )}
                      </button>
                      <WhiteboardHistory
                        id={historyPanelId}
                        isOpen={historyOpen}
                        onClose={closeHistory}
                        triggerRef={historyTriggerRef}
                      />
                    </div>
                    <button
                      type="button"
                      onClick={handleClear}
                      disabled={isClearing || boardEmpty}
                      className={cn(headerIconButton, 'hover:bg-danger-soft hover:text-danger')}
                      aria-label={t('whiteboard.clear')}
                      title={t('whiteboard.clear')}
                    >
                      <motion.span
                        className="flex"
                        animate={isClearing ? { rotate: [0, -15, 15, -10, 10, 0] } : { rotate: 0 }}
                        transition={
                          isClearing ? { duration: 0.5, ease: 'easeInOut' } : { duration: 0.2 }
                        }
                      >
                        <Eraser className="size-4" aria-hidden="true" />
                      </motion.span>
                    </button>
                  </>
                )}
              </div>
            </div>

            {/* Whiteboard Content Area */}
            <div
              ref={contentRef}
              className="flex-1 relative p-3 bg-page bg-[radial-gradient(var(--line)_1px,transparent_1px)] [background-size:24px_24px] overflow-hidden"
            >
              <WhiteboardCanvas ref={canvasRef} whiteboard={whiteboard} onViewChange={setView} />
              {(elementPickActive || selectedElementId) &&
                !runtimeAuthoritative &&
                !isClearing &&
                whiteboard &&
                onPickElement &&
                onCancelElementPick && (
                  <ElementPickOverlay
                    key={elementPickActive ? 'picking' : 'selected'}
                    elements={whiteboard.elements}
                    picking={Boolean(elementPickActive)}
                    selectedElementId={selectedElementId}
                    scopeRef={contentRef}
                    onPick={onPickElement}
                    onCancel={onCancelElementPick}
                    testId="whiteboard-element-pick-overlay"
                  />
                )}
            </div>

            {/* Cleared · Undo — in-card status, user clears only */}
            <AnimatePresence>
              {undoVisible && (
                <motion.div
                  key="cleared"
                  role="status"
                  data-testid="whiteboard-cleared-status"
                  initial={{ opacity: 0, y: -6 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -6 }}
                  transition={{ duration: 0.15 }}
                  className="absolute top-14 left-1/2 z-[115] -translate-x-1/2 flex h-10 items-center gap-2.5 whitespace-nowrap rounded-xl border border-line bg-background pl-3 pr-1.5 shadow-[0_10px_30px_-10px_rgba(0,0,0,0.2)]"
                >
                  <CircleCheck className="size-4 text-success" aria-hidden="true" />
                  <span className="text-[13px] font-medium text-fg">
                    {t('whiteboard.clearSuccess')}
                  </span>
                  <button
                    type="button"
                    onClick={handleUndoClear}
                    className="h-7 rounded-lg bg-accent-soft px-2.5 text-[13px] font-semibold text-accent-text transition-colors hover:text-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"
                  >
                    {t('whiteboard.undo')}
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.section>
        )}
      </AnimatePresence>
    </>
  );
}
