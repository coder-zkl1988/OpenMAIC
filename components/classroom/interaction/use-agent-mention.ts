'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import {
  filterMentionCandidates,
  findMentionQuery,
  insertMention,
  type MentionCandidate,
  type MentionQuery,
} from '@/lib/chat/agent-mention';

/**
 * The composer's @ menu (I23): typing "@" offers the people in class, and
 * picking one writes "@Name " into the draft — the request then names them
 * as addressed. The keyboard contract is the workbench course picker's (↑/↓
 * move, Enter or Tab picks, Escape closes); the menu owns those keys only
 * while it is open, so Enter still sends otherwise.
 */
export function useAgentMention({
  candidates,
  draft,
  setDraft,
  textareaRef,
}: {
  readonly candidates: readonly MentionCandidate[];
  readonly draft: string;
  readonly setDraft: (text: string) => void;
  readonly textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [highlight, setHighlight] = useState(0);
  // Escape closes the menu for the mention being typed; a new "@" opens it again
  const [dismissedAt, setDismissedAt] = useState<number | null>(null);
  const pendingCaretRef = useRef<number | null>(null);

  const matches = query ? filterMentionCandidates(candidates, query.query) : [];
  const isOpen = !!query && matches.length > 0 && query.start !== dismissedAt;
  // Filtering shortens the list under the highlight: read it clamped
  const activeIndex = highlight < matches.length ? highlight : 0;

  const queryRef = useRef(query);
  useLayoutEffect(() => {
    queryRef.current = query;
  });

  /** Follow the caret: the draft changed, or the caret moved */
  const sync = useCallback(
    (text: string, caret: number | null) => {
      const next =
        candidates.length > 0 && caret !== null
          ? findMentionQuery(
              text,
              caret,
              candidates.map((c) => c.name),
            )
          : null;
      const prev = queryRef.current;
      // A new query (another "@", or more typed) starts at the top of the list
      if (prev?.start !== next?.start || prev?.query !== next?.query) setHighlight(0);
      queryRef.current = next;
      setQuery(next);
      if (!next) setDismissedAt(null);
    },
    [candidates],
  );

  const close = useCallback(() => {
    queryRef.current = null;
    setQuery(null);
  }, []);

  const pick = useCallback(
    (candidate: MentionCandidate) => {
      if (!query) return;
      const inserted = insertMention(draft, query, candidate.name);
      pendingCaretRef.current = inserted.caret;
      setDraft(inserted.text);
      queryRef.current = null;
      setQuery(null);
    },
    [draft, query, setDraft],
  );

  // Put the caret after the inserted mention once the draft re-renders
  useLayoutEffect(() => {
    const caret = pendingCaretRef.current;
    const textarea = textareaRef.current;
    if (caret === null || !textarea) return;
    pendingCaretRef.current = null;
    textarea.setSelectionRange(caret, caret);
  });

  /** The menu's keys while it is open; true when the key was the menu's */
  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!isOpen || event.nativeEvent.isComposing) return false;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setHighlight((activeIndex + step + matches.length) % matches.length);
        return true;
      }
      case 'Enter':
      case 'Tab':
        if (event.shiftKey) return false;
        event.preventDefault();
        pick(matches[activeIndex]!);
        return true;
      case 'Escape':
        // Closes the menu only: the composer (and the classroom's Escape)
        // stay as they are
        event.preventDefault();
        event.stopPropagation();
        setDismissedAt(query!.start);
        return true;
      default:
        return false;
    }
  };

  return {
    isOpen,
    matches,
    activeIndex,
    setHighlight,
    sync,
    close,
    pick,
    onKeyDown,
  };
}

export type AgentMentionController = ReturnType<typeof useAgentMention>;
