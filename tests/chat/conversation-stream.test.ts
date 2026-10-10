import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  ConversationStream,
  buildConversationStream,
  type ConversationStreamItem,
} from '@/components/chat/conversation-stream';
import type { ChatSession } from '@/lib/types/chat';
import type { Scene } from '@/lib/types/stage';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'n' in options ? `${key}:${options.n}` : key,
  }),
}));

const scenes = [
  { id: 'scene-b', title: 'Second idea', order: 2 },
  { id: 'scene-a', title: 'First idea', order: 1 },
  { id: 'scene-c', title: 'Third idea', order: 3 },
] as unknown as Scene[];

function session(
  id: string,
  overrides: Partial<ChatSession> & Pick<ChatSession, 'createdAt'>,
): ChatSession {
  return {
    id,
    type: 'qa',
    title: id,
    status: 'completed',
    messages: [],
    config: { agentIds: ['default-1'] },
    toolCalls: [],
    pendingToolCalls: [],
    updatedAt: overrides.createdAt,
    ...overrides,
  };
}

function shape(items: ConversationStreamItem[]) {
  return items.map((item) =>
    item.kind === 'divider' ? `divider:${item.pageNumber}:${item.title}` : item.session.id,
  );
}

describe('buildConversationStream', () => {
  it('merges Q&A and discussion sessions chronologically and leaves lecture sessions out', () => {
    const items = buildConversationStream(
      [
        session('late-qa', { createdAt: 30, sceneId: 'scene-a' }),
        session('lecture', { createdAt: 5, type: 'lecture', sceneId: 'scene-a' }),
        session('early-discussion', { createdAt: 10, type: 'discussion', sceneId: 'scene-a' }),
        session('mid-qa', { createdAt: 20, sceneId: 'scene-a' }),
      ],
      scenes,
    );

    expect(shape(items)).toEqual(['divider:1:First idea', 'early-discussion', 'mid-qa', 'late-qa']);
  });

  it('inserts a page divider whenever the scene changes, numbered in scene order', () => {
    const items = buildConversationStream(
      [
        session('a1', { createdAt: 1, sceneId: 'scene-a' }),
        session('b1', { createdAt: 2, sceneId: 'scene-b', type: 'discussion' }),
        session('b2', { createdAt: 3, sceneId: 'scene-b' }),
        // Back on the first page: a divider again
        session('a2', { createdAt: 4, sceneId: 'scene-a' }),
      ],
      scenes,
    );

    expect(shape(items)).toEqual([
      'divider:1:First idea',
      'a1',
      'divider:2:Second idea',
      'b1',
      'b2',
      'divider:1:First idea',
      'a2',
    ]);
  });

  it('keeps creation order for equal timestamps and skips dividers for unknown scenes', () => {
    const items = buildConversationStream(
      [
        session('first', { createdAt: 7, sceneId: 'gone' }),
        session('second', { createdAt: 7 }),
        session('third', { createdAt: 7, sceneId: 'scene-c' }),
      ],
      scenes,
    );

    expect(shape(items)).toEqual(['first', 'second', 'divider:3:Third idea', 'third']);
  });
});

describe('ConversationStream', () => {
  const render = (sessions: ChatSession[], isStreaming = false) =>
    renderToStaticMarkup(
      createElement(ConversationStream, {
        sessions,
        scenes,
        isStreaming,
        onEndSession: vi.fn(),
        onContinueSession: vi.fn(),
      }),
    );

  it('reproduces the drawn sequence: divider, Q&A, 问答已结束, divider, 讨论, 讨论已结束', () => {
    const html = render([
      session('qa', { createdAt: 1, sceneId: 'scene-a' }),
      session('discussion', { createdAt: 2, sceneId: 'scene-b', type: 'discussion' }),
    ]);

    const order = [
      'chat.lectureNotes.pageLabel:1 · First idea',
      'chat.badge.qa',
      'roundtable.qaEnded',
      'chat.lectureNotes.pageLabel:2 · Second idea',
      'chat.badge.discussion',
      'roundtable.discussionEnded',
    ].map((text) => html.indexOf(text));

    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html).toContain('data-testid="conversation-stream"');
    expect(html).toContain('bg-page');
  });

  it('shows the empty state without sessions', () => {
    const html = render([session('lecture', { createdAt: 1, type: 'lecture' })]);
    expect(html).toContain('chat.noConversations');
    expect(html).not.toContain('data-testid="conversation-stream"');
  });

  it('marks the log busy while an answer streams and keeps it keyboard-scrollable', () => {
    const qa = [session('qa', { createdAt: 1, sceneId: 'scene-a', status: 'active' })];
    const idle = render(qa);
    expect(idle).toContain('role="log"');
    expect(idle).toContain('tabindex="0"');
    expect(idle).not.toContain('aria-busy');
    expect(render(qa, true)).toContain('aria-busy="true"');
  });

  it('renders a trailing row (the inline discussion card) after the latest session', () => {
    const trailing = createElement('div', { 'data-testid': 'trailing-card' }, 'offer');
    const html = renderToStaticMarkup(
      createElement(ConversationStream, {
        sessions: [session('qa', { createdAt: 1, sceneId: 'scene-a' })],
        scenes,
        isStreaming: false,
        onEndSession: vi.fn(),
        onContinueSession: vi.fn(),
        trailing,
      }),
    );
    expect(html.indexOf('data-testid="trailing-card"')).toBeGreaterThan(
      html.indexOf('roundtable.qaEnded'),
    );

    // Without sessions the card still shows, in the log instead of the empty state
    const alone = renderToStaticMarkup(
      createElement(ConversationStream, {
        sessions: [],
        scenes,
        isStreaming: false,
        onEndSession: vi.fn(),
        onContinueSession: vi.fn(),
        trailing,
      }),
    );
    expect(alone).toContain('data-testid="trailing-card"');
    expect(alone).toContain('data-testid="conversation-stream"');
    expect(alone).not.toContain('chat.noConversations');
  });

  it('renders no per-session collapse toggle', () => {
    const html = render([session('qa', { createdAt: 1, sceneId: 'scene-a', status: 'active' })]);
    expect(html).not.toContain('aria-expanded');
    expect(html).not.toContain('<button');
  });
});
