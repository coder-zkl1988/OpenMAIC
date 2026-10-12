// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/use-i18n', () => ({ useI18n: () => ({ t: (key: string) => key }) }));

import { LectureNotesView } from '@/components/chat/lecture-notes-view';
import { buildLectureNotes, type LectureNoteMoment } from '@/lib/chat/lecture-notes';
import type { Action } from '@/lib/types/action';
import type { Scene } from '@/lib/types/stage';

const scene = {
  id: 'scene-1',
  stageId: 'stage-1',
  type: 'slide',
  title: 'Forces',
  order: 1,
  content: { type: 'slide', canvas: {} },
  actions: [
    { id: 's1', type: 'speech', text: 'Two forces push the box.' },
    { id: 'm1', type: 'discussion', topic: 'Why do they cancel?', agentId: 'mia' },
    { id: 'm2', type: 'discussion', topic: 'What about friction?' },
    { id: 'm3', type: 'discussion', topic: 'And on ice?', agentId: 'leo' },
    { id: 'm4', type: 'discussion', topic: 'Not reached yet', agentId: 'mia' },
  ] as Action[],
} as unknown as Scene;

const agents: Record<string, { name: string; avatar?: string }> = {
  mia: { name: 'Mia', avatar: '/avatars/mia.png' },
  teacher: { name: 'Ms. Lin', avatar: '/avatars/lin.png' },
  leo: { name: 'Leo' },
};

describe('LectureNotesView: the class moments, who opened them and how they ended (I07)', () => {
  let container: HTMLDivElement;
  let root: Root;
  const onDiscussMoment = vi.fn<(moment: LectureNoteMoment) => void>();

  const moments = new Map<string, LectureNoteMoment>([
    [
      'm1',
      {
        sceneId: 'scene-1',
        actionId: 'm1',
        topic: 'Why do they cancel?',
        agentId: 'mia',
        outcome: 'auto_skipped',
      },
    ],
    // A legacy moment: the teacher opened it
    [
      'm2',
      { sceneId: 'scene-1', actionId: 'm2', topic: 'What about friction?', outcome: 'joined' },
    ],
    [
      'm3',
      {
        sceneId: 'scene-1',
        actionId: 'm3',
        topic: 'And on ice?',
        agentId: 'leo',
        outcome: 'not_shown',
      },
    ],
    ['m4', { sceneId: 'scene-1', actionId: 'm4', topic: 'Not reached yet', agentId: 'mia' }],
  ]);

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    Element.prototype.scrollIntoView = vi.fn();
    onDiscussMoment.mockReset();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  function render(canDiscussMoment = true) {
    act(() =>
      root.render(
        createElement(LectureNotesView, {
          notes: buildLectureNotes([scene]),
          moments,
          describeAgent: (agentId?: string) => agents[agentId ?? 'teacher'],
          onDiscussMoment,
          canDiscussMoment,
        }),
      ),
    );
  }
  const blocks = () =>
    [...container.querySelectorAll('[data-testid="lecture-note-moment"]')] as HTMLElement[];

  it('names the opener (the teacher for a legacy moment) and the outcome', () => {
    render();
    expect(blocks().map((block) => block.dataset.outcome)).toEqual([
      'auto_skipped',
      'joined',
      'not_shown',
      'pending',
    ]);
    const [missed, joined, notShown, pending] = blocks();
    expect(missed.textContent).toContain('Mia');
    expect(missed.textContent).toContain('chat.lectureNotes.momentOutcome.autoSkipped');
    expect(missed.querySelector('img')?.getAttribute('src')).toBe('/avatars/mia.png');
    expect(joined.textContent).toContain('Ms. Lin');
    expect(joined.textContent).toContain('chat.lectureNotes.momentOutcome.joined');
    expect(notShown.textContent).toContain('chat.lectureNotes.momentOutcome.notShown');
    expect(pending.textContent).not.toContain('chat.lectureNotes.momentOutcome');
    expect(pending.textContent).toContain('Not reached yet');
  });

  it('offers 现在聊聊 only on a moment the learner let pass', () => {
    render();
    const buttons = blocks().map((block) => block.querySelector('button'));
    expect(buttons.map((button) => !!button)).toEqual([true, false, false, false]);

    act(() => buttons[0]!.click());
    expect(onDiscussMoment).toHaveBeenCalledExactlyOnceWith(moments.get('m1'));
    // Told apart by the moment it opens
    const describedBy = buttons[0]!.getAttribute('aria-describedby')!;
    expect(document.getElementById(describedBy)?.textContent).toBe('Why do they cancel?');
  });

  it('keeps it disabled while something else is live', () => {
    render(false);
    const button = blocks()[0].querySelector('button')!;
    expect(button.disabled).toBe(true);
    act(() => button.click());
    expect(onDiscussMoment).not.toHaveBeenCalled();
    // ...and says why
    expect(button.title).toBe('chat.lectureNotes.discussNowBusy');
    const reasons = button
      .getAttribute('aria-describedby')!
      .split(' ')
      .map((id) => document.getElementById(id)?.textContent);
    expect(reasons).toEqual(['Why do they cancel?', 'chat.lectureNotes.discussNowBusy']);
  });
});
