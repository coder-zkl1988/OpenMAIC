'use client';

import { useEffect, useRef } from 'react';

export interface UseClassroomShortcutsOptions {
  /** Off: no listener (e.g. a host that is not the active composer) */
  enabled?: boolean;
  /** The composer's text or voice input is open: Escape closes it */
  isComposerOpen: boolean;
  /** Close the inputs and drop any recording (Escape) */
  onDismiss: () => void;
  /** A live Q&A / discussion is running: Space pauses or resumes it */
  isInLiveFlow: boolean;
  onToggleLivePause: () => void;
  /** T */
  focusComposer: () => void;
  /** V, when speech input is available */
  toggleVoice: () => void;
  canUseVoice: boolean;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  const tag = element?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || !!element?.isContentEditable;
}

/**
 * Classroom interaction keys on window (#255): T = the text composer, V = voice,
 * Escape = close the composer, Space = pause/resume the live answer (only
 * during a Q&A / discussion — the stage owns Space for lecture play/pause).
 */
export function useClassroomShortcuts(options: UseClassroomShortcutsOptions) {
  const { enabled = true } = options;
  // Read at key time, so the listener never acts on a stale render
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  useEffect(() => {
    if (!enabled) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      const current = optionsRef.current;
      // Escape should always work, even when typing in an input
      if (e.key === 'Escape') {
        if (current.isComposerOpen) {
          e.preventDefault();
          e.stopPropagation(); // Prevent fullscreen exit when panels are open
          current.onDismiss();
        }
        return;
      }

      // Skip other shortcuts when user is typing in an input, textarea, or contentEditable
      if (isTypingTarget(e.target)) return;

      switch (e.key) {
        case ' ':
        case 'Spacebar':
          // Only handle during live flow (QA/Discussion)
          if (!current.isInLiveFlow) return;
          e.preventDefault(); // Prevent page scroll
          current.onToggleLivePause();
          break;

        case 't':
        case 'T':
          e.preventDefault();
          current.focusComposer();
          break;

        case 'v':
        case 'V':
          e.preventDefault();
          if (current.canUseVoice) current.toggleVoice();
          break;

        default:
          break;
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [enabled]);
}
