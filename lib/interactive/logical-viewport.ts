import type { ClientBox } from '@/lib/edit/visible-client-rect';

/**
 * The smallest CSS viewport a generated interactive page gets: whatever the
 * slot, the page lays out at least this wide and tall (so it never drops to a
 * phone breakpoint in a small pane) and is scaled to fit.
 */
export const GENUI_LOGICAL_WIDTH = 1280;
export const GENUI_LOGICAL_HEIGHT = 720;

export interface FittedGenUiViewport {
  /** Where the scaled viewport sits on screen */
  readonly box: ClientBox;
  readonly scale: number;
  /** The iframe's CSS viewport, before scaling */
  readonly width: number;
  readonly height: number;
}

/**
 * Fill a screen slot with a GenUI viewport. The scale fits the 1280×720
 * minimum into the slot; the viewport's other side then stretches to the
 * slot's shape, so a page that fills its viewport (generated pages are
 * responsive) uses all the room the slot has instead of a centered 16:9 box
 * with bands around it.
 */
export function fitGenUiViewport(slot: ClientBox): FittedGenUiViewport {
  const scale = Math.max(
    0,
    Math.min(slot.width / GENUI_LOGICAL_WIDTH, slot.height / GENUI_LOGICAL_HEIGHT),
  );
  if (scale === 0) {
    return {
      scale,
      width: GENUI_LOGICAL_WIDTH,
      height: GENUI_LOGICAL_HEIGHT,
      box: {
        left: slot.left + slot.width / 2,
        top: slot.top + slot.height / 2,
        width: 0,
        height: 0,
      },
    };
  }
  // The limiting side stays exact; the other is rounded to whole CSS pixels so
  // a slot that moves by a fraction of a pixel does not resize the page
  const widthLimited = slot.width / GENUI_LOGICAL_WIDTH <= slot.height / GENUI_LOGICAL_HEIGHT;
  const width = widthLimited ? GENUI_LOGICAL_WIDTH : Math.round(slot.width / scale);
  const height = widthLimited ? Math.round(slot.height / scale) : GENUI_LOGICAL_HEIGHT;
  return {
    scale,
    width,
    height,
    box: { left: slot.left, top: slot.top, width: width * scale, height: height * scale },
  };
}
