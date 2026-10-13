'use client';

/**
 * The classroom composer's textarea, with every "@Name" in the draft drawn in
 * the accent so the person addressed stands apart from the question.
 *
 * Same two layers as the workbench composer (`components/workbench/composer-input.tsx`,
 * whose notes explain the mirror): the real `<textarea>` keeps its value,
 * events and IME untouched, over a `pointer-events-none` div that lays out the
 * SAME string with one shared metric class, a measured width (a scrollbar that
 * takes space narrows only the textarea) and a trailing newline.
 *
 * The difference: the workbench mirror paints only a ground behind a handle
 * and leaves every glyph to the textarea, so the handle keeps the text colour.
 * Here the name itself changes colour, so while the draft names someone the
 * mirror draws the glyphs and the textarea's ink goes transparent. That gives
 * back the three things the workbench notes warn about, each on purpose:
 * - the caret: `caret-color` is set on its own, so it does not follow the ink;
 * - the selection: a translucent highlight over transparent ink, so the
 *   mirror's glyphs read through it instead of a blank block;
 * - IME composition, which the textarea draws and the mirror may not have yet:
 *   while composing the textarea's own ink comes back and the mirror keeps only
 *   the soft ground behind the names, as in the workbench.
 * A draft that names nobody has no mirror at all, so the plain case (and the
 * placeholder) is the native textarea.
 *
 * The highlight is metric-neutral (no padding, border or weight; the inset is
 * a spread `box-shadow`), or the mirror's text would slide off the textarea's.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type Ref,
} from 'react';
import { cn } from '@/lib/utils';
import { findMentions, splitMentions, type MentionRosterMember } from '@/lib/chat/agent-mention';

/** A soft accent ground under a name, in a text flow (see the workbench's skill pill) */
const MENTION_GROUND = cn(
  '[--mention-ground:color-mix(in_srgb,var(--primary)_9%,transparent)]',
  'dark:[--mention-ground:color-mix(in_srgb,var(--primary)_17%,transparent)]',
  'rounded-[5px] bg-[var(--mention-ground)] shadow-[0_0_0_1.5px_var(--mention-ground)]',
  '[-webkit-box-decoration-break:clone] [box-decoration-break:clone]',
);

/** The name's ink, while the mirror draws the glyphs */
const MENTION_INK = 'text-accent-hover dark:text-accent-text';

/** What the mirror adds to the shared metric class: geometry and invisibility to input */
const MIRROR_CLASS =
  'pointer-events-none absolute inset-0 z-0 select-none overflow-hidden whitespace-pre-wrap break-words';

export type MentionTextareaProps = Omit<
  ComponentPropsWithoutRef<'textarea'>,
  'value' | 'children'
> & {
  readonly value: string;
  /** Whom a "@Name" may name: only roster names are highlighted */
  readonly roster: readonly MentionRosterMember[];
  /** The metric class both layers share (font, size, leading, padding) */
  readonly className?: string;
  readonly ref?: Ref<HTMLTextAreaElement>;
};

export function MentionTextarea({
  value,
  roster,
  className,
  ref,
  style,
  onScroll,
  onCompositionStart,
  onCompositionEnd,
  ...textareaProps
}: MentionTextareaProps) {
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const [mirrorWidth, setMirrorWidth] = useState<number | null>(null);
  const [composing, setComposing] = useState(false);
  const runs = useMemo(() => {
    const spans = findMentions(value, roster);
    return spans.length > 0 ? splitMentions(value, spans) : null;
  }, [value, roster]);
  // The mirror draws the glyphs only while it has every one of them
  const inked = runs !== null && !composing;

  const syncToInput = useCallback(() => {
    const input = inputRef.current;
    const mirror = mirrorRef.current;
    if (!input || !mirror) return;
    mirror.scrollTop = input.scrollTop;
    mirror.scrollLeft = input.scrollLeft;
    setMirrorWidth((current) => (current === input.clientWidth ? current : input.clientWidth));
  }, []);

  // Typing at the bottom of a full box scrolls it, and so does autosize
  // reaching its cap; both arrive with the value even when no scroll event does
  useLayoutEffect(syncToInput, [syncToInput, value, runs]);

  useEffect(() => {
    const input = inputRef.current;
    if (!input || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(syncToInput);
    observer.observe(input);
    return () => observer.disconnect();
  }, [syncToInput]);

  const setRef = useCallback(
    (node: HTMLTextAreaElement | null) => {
      inputRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  return (
    <div className="relative">
      {runs && (
        <div
          ref={mirrorRef}
          aria-hidden="true"
          data-testid="composer-mention-mirror"
          data-inked={inked || undefined}
          className={cn(className, MIRROR_CLASS)}
          style={{
            // Inline, so no colour utility in the shared class can print a
            // second copy of the draft while the textarea draws it
            ...(inked ? {} : { color: 'transparent' }),
            ...(mirrorWidth === null ? {} : { width: `${mirrorWidth}px` }),
          }}
        >
          {runs.map((run, index) =>
            run.mention ? (
              <span
                key={index}
                data-mention={run.mention}
                className={cn(MENTION_GROUND, inked && MENTION_INK)}
              >
                {run.text}
              </span>
            ) : (
              <span key={index}>{run.text}</span>
            ),
          )}
          {/* A `pre-wrap` div drops the line a trailing newline opens, where a
              textarea keeps it: one more newline keeps the two scrolling alike */}
          {'\n'}
        </div>
      )}
      <textarea
        {...textareaProps}
        ref={setRef}
        value={value}
        style={style}
        onScroll={(event) => {
          syncToInput();
          onScroll?.(event);
        }}
        onCompositionStart={(event) => {
          setComposing(true);
          onCompositionStart?.(event);
        }}
        onCompositionEnd={(event) => {
          setComposing(false);
          onCompositionEnd?.(event);
        }}
        className={cn(
          className,
          // Above the mirror, which shows through the transparent ground
          'relative z-[1] bg-transparent',
          inked && 'text-transparent caret-fg selection:bg-primary/25 selection:text-transparent',
        )}
      />
    </div>
  );
}
