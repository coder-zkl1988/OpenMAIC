'use client';

import { useRef, useEffect, useMemo, useState, type RefObject } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { RotateCcw } from 'lucide-react';
import type { Slide } from '@openmaic/dsl';
import { SlideThumbnail } from '@/components/slide-renderer/SlideThumbnail';
import { useWhiteboardHistoryStore, type WhiteboardSnapshot } from '@/lib/store/whiteboard-history';
import { useCanvasStore } from '@/lib/store/canvas';
import { restoreWhiteboardElements } from '@/lib/whiteboard/restore';
import { normalizeWhiteboardViewportRatio } from '@/lib/whiteboard/viewport';
import { toast } from 'sonner';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useEscapeLayer } from '@/lib/hooks/use-escape-layer';

interface WhiteboardHistoryProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  /** id for the trigger's aria-controls */
  readonly id?: string;
  /** The toggle button: excluded from outside-click and refocused on Escape. */
  readonly triggerRef?: RefObject<HTMLElement | null>;
}

const THUMBNAIL_THEME: Slide['theme'] = {
  backgroundColor: '#ffffff',
  themeColors: ['#5b9bd5', '#ed7d31', '#a5a5a5', '#ffc000', '#4472c4'],
  fontColor: '#333333',
  fontName: 'Microsoft YaHei',
};

/** A read-only slide built from a snapshot so SlideThumbnail can draw it. */
function snapshotSlide(snapshot: WhiteboardSnapshot, index: number): Slide {
  return {
    id: `whiteboard-history-${index}-${snapshot.timestamp}`,
    viewportSize: snapshot.viewportSize ?? 1000,
    viewportRatio: normalizeWhiteboardViewportRatio(snapshot.viewportRatio ?? 9 / 16),
    theme: THUMBNAIL_THEME,
    elements: snapshot.elements,
    background: { type: 'solid', color: '#ffffff' },
  };
}

/**
 * 64×36 snapshot preview. Thumbnails are full SlideCanvas trees (ResizeObserver,
 * charts, KaTeX), so a row only renders its canvas once it scrolls into view of
 * the open popover; the popover itself unmounts them all when it closes.
 */
function SnapshotThumbnail({
  snapshot,
  index,
  scrollRootRef,
}: {
  snapshot: WhiteboardSnapshot;
  index: number;
  scrollRootRef: RefObject<HTMLDivElement | null>;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === 'undefined');
  const slide = useMemo(() => snapshotSlide(snapshot, index), [snapshot, index]);

  useEffect(() => {
    if (visible) return;
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { root: scrollRootRef.current, rootMargin: '48px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible, scrollRootRef]);

  return (
    <span
      ref={ref}
      aria-hidden="true"
      data-testid="whiteboard-history-thumbnail"
      className="relative block h-9 w-16 shrink-0 overflow-hidden rounded-md bg-white ring-1 ring-line"
    >
      {visible && <SlideThumbnail slide={slide} viewportRatio={slide.viewportRatio} />}
    </span>
  );
}

function formatTime(ts: number) {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}:${d.getSeconds().toString().padStart(2, '0')}`;
}

/**
 * Whiteboard history popover.
 * Lists saved whiteboard snapshots (newest first) with a thumbnail, time and
 * element count. "Restore" is always visible so it works with touch and the
 * keyboard; Escape closes the popover and returns focus to the trigger.
 */
export function WhiteboardHistory({ isOpen, onClose, id, triggerRef }: WhiteboardHistoryProps) {
  const { t } = useI18n();
  const snapshots = useWhiteboardHistoryStore((s) => s.snapshots);
  const isClearing = useCanvasStore.use.whiteboardClearing();
  const panelRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Close on outside press (mouse or touch); the trigger toggles on its own.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: PointerEvent) => {
      const target = e.target as Node;
      if (panelRef.current?.contains(target)) return;
      if (triggerRef?.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', handler);
    return () => document.removeEventListener('pointerdown', handler);
  }, [isOpen, onClose, triggerRef]);

  // Escape closes and hands focus back to the trigger. An escape layer: with
  // the element picker armed under the popover, only the popover closes.
  useEscapeLayer(isOpen, () => {
    onClose();
    triggerRef?.current?.focus();
  });

  // Move focus into the popover when it opens: the newest restore, or the panel.
  useEffect(() => {
    if (!isOpen) return;
    const panel = panelRef.current;
    if (!panel) return;
    const first = panel.querySelector<HTMLButtonElement>('button:not([disabled])');
    (first ?? panel).focus();
  }, [isOpen]);

  const handleRestore = (index: number) => {
    const snapshot = useWhiteboardHistoryStore.getState().getSnapshot(index);
    if (!snapshot) return;

    const result = restoreWhiteboardElements(snapshot.elements, { viewport: snapshot });
    switch (result.status) {
      case 'busy':
        // A clear animation is in flight — its pending delete would overwrite
        // the restored content moments later.
        toast.error(t('whiteboard.restoreError'));
        return;
      case 'error':
        console.error('Failed to restore whiteboard snapshot:', result.error);
        toast.error(t('whiteboard.restoreError') + result.error);
        return;
      case 'restored':
      case 'unchanged':
        toast.success(t('whiteboard.restored'));
        onClose();
        // The focused Restore unmounts with the popover; hand focus back.
        triggerRef?.current?.focus();
        return;
    }
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <motion.div
          ref={panelRef}
          id={id}
          role="dialog"
          aria-label={t('whiteboard.history')}
          tabIndex={-1}
          initial={{ opacity: 0, y: -8, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8, scale: 0.95 }}
          transition={{ duration: 0.15 }}
          className="absolute right-0 top-full mt-2 z-[130] w-72 max-h-80 overflow-hidden rounded-[14px] border border-line bg-background shadow-[0_24px_48px_-16px_rgba(0,0,0,0.25)] flex flex-col outline-none"
        >
          {/* Header */}
          <div className="flex items-center justify-between border-b border-line px-3.5 py-3">
            <span className="text-sm font-semibold text-fg">{t('whiteboard.history')}</span>
            {snapshots.length > 0 && (
              <span className="text-xs text-fg-tertiary">{snapshots.length}</span>
            )}
          </div>

          {/* Snapshot list */}
          <div ref={listRef} className="flex-1 overflow-y-auto">
            {snapshots.length === 0 ? (
              <div className="px-4 py-8 text-center text-sm text-fg-tertiary">
                {t('whiteboard.noHistory')}
              </div>
            ) : (
              <ul className="m-0 list-none p-0">
                {[...snapshots].reverse().map((snap, reverseIdx) => {
                  const realIdx = snapshots.length - 1 - reverseIdx;
                  return (
                    <li
                      key={`${snap.timestamp}-${realIdx}`}
                      className="flex items-center gap-2.5 border-t border-subtle px-3.5 py-2.5 first:border-t-0"
                    >
                      <SnapshotThumbnail snapshot={snap} index={realIdx} scrollRootRef={listRef} />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-[13px] font-semibold text-fg">
                          {`#${realIdx + 1}`}
                        </div>
                        <div className="mt-0.5 text-xs text-fg-tertiary">
                          {formatTime(snap.timestamp)} ·{' '}
                          {t('whiteboard.elementCount', { count: snap.elements.length })}
                        </div>
                      </div>
                      <button
                        type="button"
                        onClick={() => handleRestore(realIdx)}
                        disabled={isClearing}
                        aria-label={t('whiteboard.restoreSnapshot', { index: realIdx + 1 })}
                        className="flex h-7 shrink-0 items-center gap-1 rounded-lg border border-accent-line bg-background px-2.5 text-xs font-semibold text-accent-text transition-colors hover:bg-accent-soft hover:text-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-line disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        <RotateCcw className="size-3" aria-hidden="true" />
                        {t('whiteboard.restore')}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
