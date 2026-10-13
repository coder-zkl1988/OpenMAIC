import { describe, expect, it } from 'vitest';
import {
  GENUI_LOGICAL_HEIGHT,
  GENUI_LOGICAL_WIDTH,
  fitGenUiViewport,
} from '@/lib/interactive/logical-viewport';

describe('GenUI logical viewport', () => {
  it('fills a matching 16:9 slot at the minimum viewport', () => {
    expect(fitGenUiViewport({ left: 20, top: 30, width: 1280, height: 720 })).toEqual({
      scale: 1,
      width: 1280,
      height: 720,
      box: { left: 20, top: 30, width: 1280, height: 720 },
    });
    expect([GENUI_LOGICAL_WIDTH, GENUI_LOGICAL_HEIGHT]).toEqual([1280, 720]);
  });

  it('stretches the viewport taller to fill a narrow editor pane', () => {
    expect(fitGenUiViewport({ left: 10, top: 20, width: 640, height: 500 })).toEqual({
      scale: 0.5,
      width: 1280,
      height: 1000,
      box: { left: 10, top: 20, width: 640, height: 500 },
    });
  });

  it('fills a tall slot, scaling up while keeping the 1280 layout width', () => {
    expect(fitGenUiViewport({ left: 0, top: 0, width: 1600, height: 1200 })).toEqual({
      scale: 1.25,
      width: 1280,
      height: 960,
      box: { left: 0, top: 0, width: 1600, height: 1200 },
    });
  });

  it('stretches the viewport wider to fill a wide slot', () => {
    expect(fitGenUiViewport({ left: 5, top: 6, width: 1920, height: 720 })).toEqual({
      scale: 1,
      width: 1920,
      height: 720,
      box: { left: 5, top: 6, width: 1920, height: 720 },
    });
  });

  it('never lays the page out below 1280×720 and rounds the stretched side', () => {
    const fitted = fitGenUiViewport({ left: 0, top: 0, width: 700.4, height: 600.3 });
    expect(fitted.width).toBe(1280);
    expect(fitted.height).toBe(1097);
    expect(fitted.scale).toBeCloseTo(700.4 / 1280);
    expect(fitted.box.width).toBeCloseTo(700.4);
    expect(fitted.box.height).toBeCloseTo(600.3, 0);
  });

  it('collapses safely before the slot has a measurable size', () => {
    expect(fitGenUiViewport({ left: 7, top: 9, width: 0, height: 400 })).toEqual({
      scale: 0,
      width: 1280,
      height: 720,
      box: { left: 7, top: 209, width: 0, height: 0 },
    });
  });
});
