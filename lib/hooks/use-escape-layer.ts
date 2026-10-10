import { useEffect, useRef } from 'react';

/**
 * Escape for stacked transient layers (a popover over an element picker, …).
 *
 * Each active layer registers here instead of adding its own window listener,
 * and one capture-phase listener hands Escape to the most recently activated
 * layer only: the topmost one closes, the one under it stays. Two independent
 * listeners would both see the same key press and close everything at once.
 * The handled event is default-prevented and stops propagating, so the
 * classroom shortcuts (Escape leaves fullscreen) do not also act on it.
 */
interface EscapeLayer {
  onEscape: () => void;
}

const layers: EscapeLayer[] = [];

function handleKeyDown(event: KeyboardEvent) {
  if (event.key !== 'Escape') return;
  const top = layers[layers.length - 1];
  if (!top) return;
  event.preventDefault();
  event.stopPropagation();
  top.onEscape();
}

/** While `active`, Escape calls `onEscape` if this is the topmost active layer. */
export function useEscapeLayer(active: boolean, onEscape: () => void): void {
  const onEscapeRef = useRef(onEscape);
  useEffect(() => {
    onEscapeRef.current = onEscape;
  }, [onEscape]);

  useEffect(() => {
    if (!active) return;
    const layer: EscapeLayer = { onEscape: () => onEscapeRef.current() };
    layers.push(layer);
    if (layers.length === 1) window.addEventListener('keydown', handleKeyDown, true);
    return () => {
      const index = layers.indexOf(layer);
      if (index !== -1) layers.splice(index, 1);
      if (layers.length === 0) window.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [active]);
}
