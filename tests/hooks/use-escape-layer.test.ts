// @vitest-environment jsdom

/**
 * Escape with stacked layers: the whiteboard history popover open over an
 * armed element picker. One key press closes only the topmost layer (the one
 * activated last); the next closes the one under it.
 */
import { act, createElement, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useEscapeLayer } from '@/lib/hooks/use-escape-layer';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Layer({ active, onEscape }: { active: boolean; onEscape: () => void }) {
  useEscapeLayer(active, onEscape);
  return null;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function pressEscape(): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
  act(() => {
    window.dispatchEvent(event);
  });
  return event;
}

describe('useEscapeLayer', () => {
  it('hands Escape to the topmost layer only, then to the one under it', () => {
    const closed: string[] = [];
    function Stack() {
      const [picker, setPicker] = useState(true);
      const [popover, setPopover] = useState(false);
      return createElement(
        'div',
        null,
        createElement(Layer, {
          active: picker,
          onEscape: () => {
            closed.push('picker');
            setPicker(false);
          },
        }),
        createElement(Layer, {
          active: popover,
          onEscape: () => {
            closed.push('popover');
            setPopover(false);
          },
        }),
        createElement('button', { id: 'open-popover', onClick: () => setPopover(true) }),
      );
    }
    act(() => root.render(createElement(Stack)));
    // The picker is armed first, then the popover opens above it
    act(() => (container.querySelector('#open-popover') as HTMLButtonElement).click());

    expect(pressEscape().defaultPrevented).toBe(true);
    expect(closed).toEqual(['popover']);

    pressEscape();
    expect(closed).toEqual(['popover', 'picker']);

    // No layer left: Escape is left alone for the classroom shortcuts
    expect(pressEscape().defaultPrevented).toBe(false);
    expect(closed).toEqual(['popover', 'picker']);
  });

  it('keeps the event from reaching later listeners while a layer handles it', () => {
    const later = vi.fn();
    window.addEventListener('keydown', later);
    act(() => root.render(createElement(Layer, { active: true, onEscape: () => {} })));
    pressEscape();
    expect(later).not.toHaveBeenCalled();
    window.removeEventListener('keydown', later);
  });

  it('calls the latest handler without re-registering the layer', () => {
    const first = vi.fn();
    const second = vi.fn();
    act(() => root.render(createElement(Layer, { active: true, onEscape: first })));
    act(() => root.render(createElement(Layer, { active: true, onEscape: second })));
    pressEscape();
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });
});
