'use client';

import {
  useRef,
  useState,
  useEffect,
  useCallback,
  useMemo,
  memo,
  forwardRef,
  useImperativeHandle,
} from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useCanvasStore } from '@/lib/store/canvas';
import { ScreenElement } from '@/components/slide-renderer/Editor/ScreenElement';
import { normalizeWhiteboardViewportRatio } from '@/lib/whiteboard/viewport';
import type { PPTElement, Whiteboard } from '@openmaic/dsl';
import { PencilLine } from 'lucide-react';
import { useI18n } from '@/lib/hooks/use-i18n';

/** Zoom bounds shared by the wheel and the header buttons (1 = fit to the card). */
export const WHITEBOARD_MIN_ZOOM = 0.2;
export const WHITEBOARD_MAX_ZOOM = 5;

export type WhiteboardCanvasHandle = {
  /** Fit the sheet back into the card (zoom 1, no pan), animated. */
  resetView: () => void;
  /** Zoom around the centre of the card by `factor`, clamped to 0.2–5. No-op on an empty board. */
  zoomBy: (factor: number) => void;
  /** Same as resetView: 100% is the fitted sheet. */
  fit: () => void;
};

/** Current view, reported to the header (zoom is relative to the fitted sheet). */
export type WhiteboardViewState = {
  zoom: number;
  modified: boolean;
};

function clampZoom(zoom: number): number {
  const clamped = Math.min(WHITEBOARD_MAX_ZOOM, Math.max(WHITEBOARD_MIN_ZOOM, zoom));
  // Snap float drift (1.25 * 0.8 …) back to exactly fit, so the view reads unmodified.
  return Math.abs(clamped - 1) < 1e-6 ? 1 : clamped;
}

type InteractiveWhiteboardCanvasProps = {
  canvasHeight: number;
  canvasWidth: number;
  containerWidth: number;
  containerHeight: number;
  containerScale: number;
  elements: PPTElement[];
  isClearing: boolean;
  onViewChange?: (view: WhiteboardViewState) => void;
  readyHintText: string;
  readyText: string;
};

function AnimatedElementBase({
  element,
  index,
  isClearing,
  totalElements,
}: {
  element: PPTElement;
  index: number;
  isClearing: boolean;
  totalElements: number;
}) {
  const clearDelay = isClearing ? (totalElements - 1 - index) * 0.055 : 0;
  const clearRotate = isClearing ? (index % 2 === 0 ? 1 : -1) * (2 + index * 0.4) : 0;

  return (
    <motion.div
      layout={false}
      initial={{ opacity: 0, scale: 0.92, y: 8, filter: 'blur(4px)' }}
      animate={
        isClearing
          ? {
              opacity: 0,
              scale: 0.35,
              y: -35,
              rotate: clearRotate,
              filter: 'blur(8px)',
              transition: {
                duration: 0.38,
                delay: clearDelay,
                ease: [0.5, 0, 1, 0.6],
              },
            }
          : {
              opacity: 1,
              scale: 1,
              y: 0,
              rotate: 0,
              filter: 'blur(0px)',
              transition: {
                duration: 0.45,
                ease: [0.16, 1, 0.3, 1],
                delay: index * 0.05,
              },
            }
      }
      exit={{
        opacity: 0,
        scale: 0.85,
        transition: { duration: 0.2 },
      }}
      className="absolute inset-0"
      style={{ pointerEvents: isClearing ? 'none' : undefined }}
    >
      <div style={{ pointerEvents: 'auto' }}>
        <ScreenElement elementInfo={element} elementIndex={index} animate />
      </div>
    </motion.div>
  );
}

// Memoized so whiteboard pan/zoom state changes (which rerender the parent
// on every pointer/wheel event) do not cascade into ScreenElement rerenders.
// Without this, motion's projection system inside CodeLineRow remeasures
// against the panning parent transform and animates the diff, making code
// content visibly lag behind the surrounding element box during a pan.
const AnimatedElement = memo(AnimatedElementBase);

const InteractiveWhiteboardCanvas = forwardRef<
  WhiteboardCanvasHandle,
  InteractiveWhiteboardCanvasProps
>(function InteractiveWhiteboardCanvas(
  {
    canvasHeight,
    canvasWidth,
    containerWidth,
    containerHeight,
    containerScale,
    elements,
    isClearing,
    onViewChange,
    readyHintText,
    readyText,
  },
  ref,
) {
  const [viewZoom, setViewZoom] = useState(1);
  const [panX, setPanX] = useState(0);
  const [panY, setPanY] = useState(0);
  const [isPanning, setIsPanning] = useState(false);
  const [isResetting, setIsResetting] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0, panX: 0, panY: 0 });
  const prevElementsLengthRef = useRef(elements.length);
  const resetTimerRef = useRef<number | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);

  const isViewModified = viewZoom !== 1 || panX !== 0 || panY !== 0;

  // Zoom-aware pan boundary: ensure at least an edge of the canvas stays visible
  const clampPan = useCallback(
    (x: number, y: number, zoom: number) => {
      const totalScale = containerScale * zoom;
      const maxPanX = canvasWidth / 2 + containerWidth / (2 * totalScale);
      const maxPanY = canvasHeight / 2 + containerHeight / (2 * totalScale);
      return {
        x: Math.max(-maxPanX, Math.min(maxPanX, x)),
        y: Math.max(-maxPanY, Math.min(maxPanY, y)),
      };
    },
    [canvasWidth, canvasHeight, containerWidth, containerHeight, containerScale],
  );

  // Ease the next transform change (button zoom / reset), not wheel or drag.
  const animateNextView = useCallback((animate: boolean) => {
    setIsResetting(animate);

    if (resetTimerRef.current) {
      window.clearTimeout(resetTimerRef.current);
      resetTimerRef.current = null;
    }

    if (!animate) {
      return;
    }

    resetTimerRef.current = window.setTimeout(() => {
      setIsResetting(false);
      resetTimerRef.current = null;
    }, 250);
  }, []);

  const resetView = useCallback(
    (animate: boolean) => {
      setIsPanning(false);
      animateNextView(animate);
      setViewZoom(1);
      setPanX(0);
      setPanY(0);
    },
    [animateNextView],
  );

  // Zoom around the card centre: with the focal point at the centre the wheel
  // math leaves pan unchanged, so only the pan bound needs re-clamping.
  const zoomBy = useCallback(
    (factor: number) => {
      if (elements.length === 0 || !Number.isFinite(factor) || factor <= 0) {
        return;
      }
      const nextZoom = clampZoom(viewZoom * factor);
      if (nextZoom === viewZoom) {
        return;
      }
      const clamped = clampPan(panX, panY, nextZoom);
      animateNextView(true);
      setViewZoom(nextZoom);
      setPanX(clamped.x);
      setPanY(clamped.y);
    },
    [animateNextView, clampPan, elements.length, panX, panY, viewZoom],
  );

  useImperativeHandle(
    ref,
    () => ({
      resetView: () => resetView(true),
      zoomBy,
      fit: () => resetView(true),
    }),
    [resetView, zoomBy],
  );

  // Notify parent when the zoom level or modified state changes
  useEffect(() => {
    onViewChange?.({ zoom: viewZoom, modified: isViewModified });
  }, [viewZoom, isViewModified, onViewChange]);

  // Always-on drag/pan — no toggle needed
  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (e.button !== 0) {
        return;
      }

      e.preventDefault();
      setIsPanning(true);
      panStartRef.current = { x: e.clientX, y: e.clientY, panX, panY };
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    },
    [panX, panY],
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!isPanning) {
        return;
      }

      const dx = e.clientX - panStartRef.current.x;
      const dy = e.clientY - panStartRef.current.y;
      // Convert screen-space drag to canvas-space (accounts for both container scale and zoom)
      const effectiveScale = Math.max(containerScale * viewZoom, 0.001);

      const newPanX = panStartRef.current.panX + dx / effectiveScale;
      const newPanY = panStartRef.current.panY + dy / effectiveScale;
      const clamped = clampPan(newPanX, newPanY, viewZoom);
      setPanX(clamped.x);
      setPanY(clamped.y);
    },
    [containerScale, viewZoom, isPanning, clampPan],
  );

  const handlePointerUp = useCallback((e: React.PointerEvent) => {
    if ((e.currentTarget as HTMLElement).hasPointerCapture(e.pointerId)) {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    }

    setIsPanning(false);
  }, []);

  // Zoom toward cursor
  useEffect(() => {
    const el = viewportRef.current;
    if (!el) {
      return;
    }

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      if (elements.length === 0) {
        return;
      }

      const zoomFactor = e.deltaY > 0 ? 0.9 : 1.1;

      setViewZoom((prevZoom) => {
        const newZoom = clampZoom(prevZoom * zoomFactor);

        // Adjust pan to keep the point under the cursor stationary
        const rect = el.getBoundingClientRect();
        const cursorX = e.clientX - rect.left;
        const cursorY = e.clientY - rect.top;

        const oldScale = containerScale * prevZoom;
        const newScale = containerScale * newZoom;
        const scaleDiff = 1 / newScale - 1 / oldScale;

        setPanX((prevPanX) => {
          const newPanX = prevPanX + (cursorX - containerWidth / 2) * scaleDiff;
          const maxPX = canvasWidth / 2 + containerWidth / (2 * newScale);
          return Math.max(-maxPX, Math.min(maxPX, newPanX));
        });

        setPanY((prevPanY) => {
          const newPanY = prevPanY + (cursorY - containerHeight / 2) * scaleDiff;
          const maxPY = canvasHeight / 2 + containerHeight / (2 * newScale);
          return Math.max(-maxPY, Math.min(maxPY, newPanY));
        });

        return newZoom;
      });
    };

    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [elements.length, containerScale, containerWidth, containerHeight, canvasWidth, canvasHeight]);

  useEffect(() => {
    return () => {
      if (resetTimerRef.current) {
        window.clearTimeout(resetTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    const prevLength = prevElementsLengthRef.current;
    const nextLength = elements.length;
    prevElementsLengthRef.current = nextLength;

    const clearedBoard = prevLength > 0 && nextLength === 0;
    const firstContentLoaded = prevLength === 0 && nextLength > 0;
    if (!clearedBoard && !firstContentLoaded) {
      return;
    }

    let cancelled = false;
    queueMicrotask(() => {
      if (!cancelled) {
        resetView(false);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [elements.length, resetView]);

  const handleDoubleClick = useCallback(
    (e?: React.MouseEvent) => {
      e?.preventDefault();
      resetView(true);
    },
    [resetView],
  );

  // Canvas position: centered in workspace, offset by pan, scaled by containerScale * viewZoom
  const totalScale = containerScale * viewZoom;
  const canvasScreenX = (containerWidth - canvasWidth * totalScale) / 2 + panX * totalScale;
  const canvasScreenY = (containerHeight - canvasHeight * totalScale) / 2 + panY * totalScale;
  const canvasTransform = `translate(${canvasScreenX}px, ${canvasScreenY}px) scale(${totalScale})`;
  const showReady = elements.length === 0 && !isClearing;

  return (
    /* Viewport — fills workspace, handles pointer events, no clipping */
    <div
      ref={viewportRef}
      className="w-full h-full relative select-none"
      style={{
        cursor: isPanning ? 'grabbing' : 'grab',
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={handlePointerUp}
      onPointerCancel={handlePointerUp}
      onDoubleClick={handleDoubleClick}
    >
      {/* Bounded canvas — white background, positioned and scaled. No overflow-hidden so elements can spill into transparent space. */}
      <div
        className="absolute rounded-[10px] border border-line bg-white shadow-[0_10px_30px_-12px_rgba(0,0,0,0.15)]"
        style={{
          width: canvasWidth,
          height: canvasHeight,
          left: 0,
          top: 0,
          transform: canvasTransform,
          transformOrigin: '0 0',
          transition: isResetting ? 'transform 0.25s ease-out' : undefined,
        }}
      >
        {/* Content layer — elements rendered at their raw coordinates */}
        <div className="absolute inset-0">
          <AnimatePresence mode="popLayout">
            {elements.map((element, index) => (
              <AnimatedElement
                key={element.id}
                element={element}
                index={index}
                isClearing={isClearing}
                totalElements={elements.length}
              />
            ))}
          </AnimatePresence>
        </div>
      </div>

      {/* Empty state — screen-size chrome laid over the sheet, so its type does
          not scale with the fitted sheet or the zoom level. The sheet is white
          in both themes, so dark mode keeps light-sheet text colours. */}
      <AnimatePresence>
        {showReady && (
          <motion.div
            key="placeholder"
            data-testid="whiteboard-ready"
            initial={{ opacity: 0 }}
            animate={{
              opacity: 1,
              transition: { delay: 0.25, duration: 0.4 },
            }}
            exit={{ opacity: 0, transition: { duration: 0.15 } }}
            className="absolute flex flex-col items-center justify-center gap-2 px-4 text-center pointer-events-none"
            style={{
              left: canvasScreenX,
              top: canvasScreenY,
              width: canvasWidth * totalScale,
              height: canvasHeight * totalScale,
            }}
          >
            <span className="mb-1 flex size-11 items-center justify-center rounded-[14px] bg-accent-soft text-primary-5">
              <PencilLine className="size-[22px]" aria-hidden="true" />
            </span>
            <p className="m-0 text-[15px] font-semibold text-fg-secondary dark:text-neutral-700">
              {readyText}
            </p>
            <p className="m-0 text-[13px] text-fg-tertiary dark:text-neutral-500">
              {readyHintText}
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
});

/**
 * Whiteboard canvas with pan, zoom, auto-fit, and bounded viewport.
 */
export type WhiteboardCanvasProps = {
  whiteboard?: Whiteboard | null;
  onViewChange?: (view: WhiteboardViewState) => void;
};

export const WhiteboardCanvas = forwardRef<WhiteboardCanvasHandle, WhiteboardCanvasProps>(
  function WhiteboardCanvas({ whiteboard, onViewChange }, ref) {
    const { t } = useI18n();
    const isClearing = useCanvasStore.use.whiteboardClearing();
    const containerRef = useRef<HTMLDivElement>(null);
    const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });

    const rawElements = whiteboard?.elements;
    const elements = useMemo(() => rawElements ?? [], [rawElements]);

    const canvasWidth = whiteboard?.viewportSize ?? 1000;
    // viewportRatio is height/width; normalize into the plausible band so an
    // inverted persisted ratio (16:9 written as width/height) can never render
    // a sheet taller than it is wide, even if it bypassed the runtime repair.
    const canvasHeight =
      canvasWidth * normalizeWhiteboardViewportRatio(whiteboard?.viewportRatio ?? 0.5625);

    const containerScale = useMemo(() => {
      if (containerSize.width === 0 || containerSize.height === 0) return 1;
      return Math.min(containerSize.width / canvasWidth, containerSize.height / canvasHeight);
    }, [containerSize.width, containerSize.height, canvasWidth, canvasHeight]);

    useEffect(() => {
      const container = containerRef.current;
      if (!container) {
        return;
      }

      const observer = new ResizeObserver((entries) => {
        const entry = entries[0];
        if (entry) {
          setContainerSize({
            width: entry.contentRect.width,
            height: entry.contentRect.height,
          });
        }
      });
      observer.observe(container);

      // Initial measurement
      setContainerSize({ width: container.clientWidth, height: container.clientHeight });

      return () => observer.disconnect();
    }, []);

    return (
      <div ref={containerRef} className="w-full h-full overflow-hidden">
        <InteractiveWhiteboardCanvas
          ref={ref}
          canvasHeight={canvasHeight}
          canvasWidth={canvasWidth}
          containerWidth={containerSize.width}
          containerHeight={containerSize.height}
          containerScale={containerScale}
          elements={elements}
          isClearing={isClearing}
          onViewChange={onViewChange}
          readyHintText={t('whiteboard.readyHint')}
          readyText={t('whiteboard.ready')}
        />
      </div>
    );
  },
);
