/**
 * Test stand-in for `motion/react`: motion.* render their plain DOM tag with
 * the animation props dropped, AnimatePresence renders its children as-is,
 * and reduced motion is off.
 */
import { createElement, forwardRef, Fragment, type ReactNode } from 'react';

const MOTION_PROPS = new Set([
  'initial',
  'animate',
  'exit',
  'transition',
  'layout',
  'whileTap',
  'whileHover',
  'variants',
]);

const cache = new Map<string, unknown>();

function motionTag(tag: string) {
  if (!cache.has(tag)) {
    cache.set(
      tag,
      forwardRef<HTMLElement, Record<string, unknown>>(function MotionStub(props, ref) {
        const domProps: Record<string, unknown> = { ref };
        for (const [key, value] of Object.entries(props)) {
          if (!MOTION_PROPS.has(key)) domProps[key] = value;
        }
        return createElement(tag, domProps);
      }),
    );
  }
  return cache.get(tag);
}

export const motionStub = {
  AnimatePresence: ({ children }: { children?: ReactNode }) =>
    createElement(Fragment, null, children),
  motion: new Proxy({}, { get: (_target, tag: string) => motionTag(tag) }),
  useReducedMotion: () => false,
};
