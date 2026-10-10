// @vitest-environment jsdom

/**
 * The shadcn Tabs wrapper styles the selected trigger through Radix's
 * data-state="active". Its earlier `data-active:` variants compile to
 * `[data-active]`, an attribute Radix never sets, so no tab ever looked
 * selected (tts-voice-managers, BackgroundControl).
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

function render(listClassName?: string) {
  act(() =>
    root.render(
      createElement(
        Tabs,
        { defaultValue: 'a' },
        createElement(
          TabsList,
          { className: listClassName },
          createElement(TabsTrigger, { value: 'a' }, 'A'),
          createElement(TabsTrigger, { value: 'b' }, 'B'),
        ),
      ),
    ),
  );
  const [a, b] = [...container.querySelectorAll('[data-slot="tabs-trigger"]')] as HTMLElement[];
  return { list: container.querySelector('[data-slot="tabs-list"]') as HTMLElement, a, b };
}

const tokens = (el: HTMLElement) => el.className.split(/\s+/);

describe('TabsTrigger active state', () => {
  it('keys the selected look off data-state="active", the attribute Radix sets', () => {
    const { a, b } = render();
    expect(a.getAttribute('data-state')).toBe('active');
    expect(b.getAttribute('data-state')).toBe('inactive');
    expect(a.hasAttribute('data-active')).toBe(false);

    expect(tokens(a)).toContain('data-[state=active]:bg-background');
    expect(tokens(a)).toContain('data-[state=active]:text-foreground');
    expect(tokens(a)).toContain(
      'group-data-[variant=default]/tabs-list:data-[state=active]:shadow-sm',
    );
    expect(tokens(a).some((c) => c.includes('data-active:'))).toBe(false);
  });

  it('gives a horizontal list its 36px height, still overridable by the caller', () => {
    expect(tokens(render().list)).toContain('h-9');
    expect(tokens(render().list).some((c) => c.includes('group-data-horizontal'))).toBe(false);
    // The interaction panel's tab row fills its header
    const { list } = render('h-full');
    expect(tokens(list)).toContain('h-full');
    expect(tokens(list)).not.toContain('h-9');
  });

  it("keeps the stacked panel's segmented control borderless in dark mode", () => {
    // The base trigger outlines the active tab with border-input in dark mode;
    // the 互动/笔记/场景 segment (TabletPortrait / ClassroomPhone) has no border
    const source = readFileSync(join(process.cwd(), 'components/chat/chat-area.tsx'), 'utf-8');
    const segment = /const SEGMENT_TRIGGER =\s*'([^']+)'/.exec(source)?.[1];
    expect(segment).toBeTruthy();
    act(() =>
      root.render(
        createElement(
          Tabs,
          { defaultValue: 'a' },
          createElement(
            TabsList,
            null,
            createElement(TabsTrigger, { value: 'a', className: segment }, 'A'),
          ),
        ),
      ),
    );
    const trigger = container.querySelector('[data-slot="tabs-trigger"]') as HTMLElement;
    expect(tokens(trigger)).toContain('dark:data-[state=active]:border-transparent');
    expect(tokens(trigger)).not.toContain('dark:data-[state=active]:border-input');
  });
});
