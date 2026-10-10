'use client';

import { useEffect, useLayoutEffect, useRef, useState } from 'react';

/**
 * The node the shell renders its one Composer into (createPortal). It is
 * created on mount, so neither the server render nor hydration sees a portal.
 *
 * One composer, two places: the interaction panel's footer and the fullscreen
 * dock. Rather than mounting a composer in each — two drafts, and two
 * listeners for every raised-hand transition — the active ComposerSlot adopts
 * this node. Moving a DOM node does not remount its React tree, so the draft,
 * a recording and the send cooldown carry over.
 */
export function useComposerHost(): HTMLDivElement | null {
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = document.createElement('div');
    node.dataset.composerHost = '';
    // Lay the composer out as if it were the slot's own child
    node.style.display = 'contents';
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the host exists only in the browser
    setHost(node);
  }, []);
  return host;
}

/** Where the composer shows: while active, the slot holds the composer host. */
export function ComposerSlot({
  host,
  active,
  className,
}: {
  readonly host: HTMLElement | null;
  readonly active: boolean;
  readonly className?: string;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  // Layout effects: every cleanup in a commit runs before any setup, so the
  // slot taking over adopts the host after the one giving it up let it go
  useLayoutEffect(() => {
    const slot = slotRef.current;
    if (!active || !host || !slot) return;
    slot.appendChild(host);
    return () => {
      if (host.parentNode === slot) slot.removeChild(host);
    };
  }, [active, host]);
  return <div ref={slotRef} data-testid="composer-slot" className={className} />;
}
