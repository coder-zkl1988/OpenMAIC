import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InteractiveModeButton } from '@/components/generation/interactive-mode-button';

function renderButton(
  pressed: boolean,
  extraProps: Partial<ComponentProps<typeof InteractiveModeButton>> = {},
) {
  return renderToStaticMarkup(
    createElement(InteractiveModeButton, {
      pressed,
      label: 'Interactive Mode',
      onPressedChange: () => undefined,
      ...extraProps,
    }),
  );
}

describe('InteractiveModeButton markup contract', () => {
  it('emits the pressed state on the interactive semantic tokens', () => {
    const html = renderButton(true);

    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain('border-interactive/40 bg-interactive-soft text-interactive');
    expect(html).toContain('lucide-check');
    expect(html).not.toContain('lucide-atom');
  });

  it('emits a neutral unpressed state with only the Atom icon tinted', () => {
    const html = renderButton(false);

    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain('border-line bg-background text-fg-secondary');
    expect(html).toContain('lucide-atom');
    expect(html).toMatch(/lucide-atom[^"]*text-interactive/);
    expect(html).not.toContain('bg-interactive-soft');
    expect(html).not.toContain('lucide-check');
  });

  it('uses no raw cyan classes in either state', () => {
    expect(renderButton(true)).not.toMatch(/cyan-/);
    expect(renderButton(false)).not.toMatch(/cyan-/);
  });

  it('forwards wrapper-injected attributes and classes to the DOM button', () => {
    const html = renderButton(false, {
      'aria-describedby': 'interactive-mode-hint',
      'data-state': 'closed',
      className: 'tooltip-trigger-class',
      title: 'Interactive mode hint',
    });

    expect(html).toContain('aria-describedby="interactive-mode-hint"');
    expect(html).toContain('data-state="closed"');
    expect(html).toContain('tooltip-trigger-class');
    expect(html).toContain('title="Interactive mode hint"');
  });

  it('keeps the press feedback motion-safe and has no breathing ring', () => {
    const selectedHtml = renderButton(true);
    const unselectedHtml = renderButton(false);

    expect(selectedHtml).not.toContain('interactive-mode-breathe');
    expect(unselectedHtml).toContain('active:scale-95');
    expect(unselectedHtml).toContain('motion-reduce:active:scale-100');
    expect(unselectedHtml).toContain('motion-reduce:transition-none');
    expect(unselectedHtml).not.toContain('spin_3s_linear_infinite');
  });
});
