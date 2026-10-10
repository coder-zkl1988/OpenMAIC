/**
 * The home composer's pill look is opt-in (`variant="pill"`): without it the
 * trigger keeps its original look, with no chevron, so other ModelPicker
 * consumers are not restyled.
 */
import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ModelPicker } from '@/components/settings/model-picker';

const GROUPS = [{ id: 'acme', name: 'Acme', models: [{ id: 'acme-large', name: 'Acme Large' }] }];

function render(props: Partial<ComponentProps<typeof ModelPicker>> = {}) {
  return renderToStaticMarkup(
    createElement(ModelPicker, {
      groups: GROUPS,
      value: null,
      onSelect: () => undefined,
      placeholder: 'Pick a model',
      ariaLabel: 'Pick a model',
      t: (key: string) => key,
      ...props,
    }),
  );
}

describe('ModelPicker trigger variants', () => {
  it('renders no chevron and the original trigger classes by default', () => {
    const html = render();

    expect(html).not.toContain('lucide-chevron-down');
    expect(html).toContain('h-7 w-full rounded-md border border-border/60 bg-background px-2.5');
    expect(html).toContain('text-muted-foreground');
  });

  it('renders the 32px pill with a decorative chevron when opted in', () => {
    const html = render({ variant: 'pill' });

    expect(html).toContain('h-8 w-auto max-w-[260px]');
    expect(html).toContain('rounded-full border border-line bg-background');
    expect(html).toContain('text-fg-secondary');
    const chevron = html.match(/<svg[^>]*lucide-chevron-down[^>]*>/)?.[0];
    expect(chevron).toContain('aria-hidden="true"');
  });

  it('keeps the selected model name as the only text in the pill', () => {
    const html = render({
      variant: 'pill',
      value: { providerId: 'acme', modelId: 'acme-large' },
    });
    const text = html.replace(/<[^>]+>/g, '');

    expect(text).toBe('Acme Large');
    expect(html).toContain('lucide-chevron-down');
  });
});
