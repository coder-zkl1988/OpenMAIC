import type { PPTElement } from '@openmaic/dsl';
import { getSlideElementTypeLabel } from '@/components/canvas/slide-element-pick-overlay';
import type { ElementReference } from '@/lib/types/chat';
import type { ComposerReferenceChip } from './composer';

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** The draft reference as the shell keeps it (what the chip needs of it) */
export interface ElementReferenceChipSource {
  readonly reference: ElementReference;
  /** 0-based page of a slide / interactive reference */
  readonly sceneOrder?: number;
  readonly elementType: PPTElement['type'] | 'interactive';
  readonly displaySummary: string;
}

/**
 * The composer's reference chip label (WhiteboardStates.dc.html): where the
 * element lives, what it is and its summary — '互动白板 · 公式 · …' for a
 * whiteboard element, '第 2 页 · 文本 · …' on a slide, '… · 互动 · #selector'
 * for an interactive component.
 */
export function describeElementReferenceChip(
  draft: ElementReferenceChipSource,
  t: Translate,
): ComposerReferenceChip {
  return {
    sceneLabel:
      draft.reference.kind === 'whiteboard_element'
        ? t('whiteboard.title')
        : t('chat.lectureNotes.pageLabel', { n: (draft.sceneOrder ?? 0) + 1 }),
    elementType:
      draft.elementType === 'interactive'
        ? t('edit.sceneType.interactive')
        : getSlideElementTypeLabel(draft.elementType, t),
    displaySummary: draft.displaySummary,
  };
}
