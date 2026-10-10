// @vitest-environment jsdom
import { act, createElement, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ComposerSlot, useComposerHost } from '@/components/classroom/interaction/composer-slot';

const lifecycle = { mounts: 0, unmounts: 0 };

/** Stands in for the composer: a draft in state, and its mounts counted */
function Draft() {
  const [draft, setDraft] = useState('');
  useEffect(() => {
    lifecycle.mounts += 1;
    return () => {
      lifecycle.unmounts += 1;
    };
  }, []);
  return createElement('textarea', {
    value: draft,
    onChange: (event: { target: { value: string } }) => setDraft(event.target.value),
  });
}

/** The panel's slot and, while presenting, the dock's: one composer between them */
function Shell({ presenting }: { presenting: boolean }) {
  const host = useComposerHost();
  return createElement(
    'div',
    null,
    createElement(
      'div',
      { 'data-testid': 'panel' },
      createElement(ComposerSlot, { host, active: !presenting }),
    ),
    presenting
      ? createElement(
          'div',
          { 'data-testid': 'dock' },
          createElement(ComposerSlot, { host, active: true }),
        )
      : null,
    host ? createPortal(createElement(Draft), host) : null,
  );
}

describe('ComposerSlot: one composer, two places', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    lifecycle.mounts = 0;
    lifecycle.unmounts = 0;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  const textareaIn = (testId: string) =>
    container.querySelector(`[data-testid="${testId}"] textarea`) as HTMLTextAreaElement | null;

  function type(textarea: HTMLTextAreaElement, text: string) {
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(
        textarea,
        text,
      );
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('moves the composer between the slots without remounting it, so the draft carries over', () => {
    act(() => root.render(createElement(Shell, { presenting: false })));
    expect(textareaIn('panel')).not.toBeNull();
    type(textareaIn('panel')!, 'Why is it green?');

    act(() => root.render(createElement(Shell, { presenting: true })));
    expect(textareaIn('panel')).toBeNull();
    expect(textareaIn('dock')?.value).toBe('Why is it green?');
    expect(container.querySelectorAll('textarea')).toHaveLength(1);

    type(textareaIn('dock')!, 'Why is it green? And why not blue?');
    act(() => root.render(createElement(Shell, { presenting: false })));
    expect(textareaIn('dock')).toBeNull();
    expect(textareaIn('panel')?.value).toBe('Why is it green? And why not blue?');
    expect(lifecycle).toEqual({ mounts: 1, unmounts: 0 });
  });
});
