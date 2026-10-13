import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import {
  AssistantAsideStreamStatus,
  ConversationStream,
  HandRaiseStreamStatus,
  buildConversationStream,
  type ConversationStreamItem,
  resolveCueSpeaker,
} from '@/components/chat/conversation-stream';
import type { ChatSession } from '@/lib/types/chat';
import type { Scene } from '@/lib/types/stage';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'n' in options
        ? `${key}:${options.n}`
        : options && 'name' in options
          ? `${key}:${options.name}`
          : key,
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

  it('tightens its spacing on the stacked layouts (TabletPortrait / ClassroomPhone)', () => {
    const html = (density?: 'panel' | 'stacked' | 'phone') =>
      renderToStaticMarkup(
        createElement(ConversationStream, {
          sessions: [session('qa', { createdAt: 1, sceneId: 'scene-a' })],
          scenes,
          isStreaming: false,
          onEndSession: vi.fn(),
          onContinueSession: vi.fn(),
          density,
        }),
      );
    expect(html()).toContain('justify-end gap-3 p-4');
    expect(html('stacked')).toContain('justify-end gap-2.5 px-4 py-3');
    expect(html('phone')).toContain('justify-end gap-2 px-3 py-2.5');
  });

  it('renders no per-session collapse toggle', () => {
    const html = render([session('qa', { createdAt: 1, sceneId: 'scene-a', status: 'active' })]);
    expect(html).not.toContain('aria-expanded');
    expect(html).not.toContain('<button');
  });
});

describe('HandRaiseStreamStatus', () => {
  const render = (props: Parameters<typeof HandRaiseStreamStatus>[0]) =>
    renderToStaticMarkup(createElement(HandRaiseStreamStatus, props));

  it('renders nothing without a hand, a queued question or a call', () => {
    expect(render({ handState: null, pendingQuestion: null, cueSpeaker: null })).toBe('');
  });

  it('marks a raised hand, and names the discussion a called hand jumped ahead of', () => {
    expect(render({ handState: 'raised' })).toContain('stage.handRaise.raised');
    // Only once called: the discussion is then queued behind the learner
    expect(render({ handState: 'raised', deferredDiscussionAgentName: 'Kai' })).not.toContain(
      'aheadOfDiscussion',
    );
    expect(render({ handState: 'called', deferredDiscussionAgentName: 'Kai' })).toContain(
      'stage.handRaise.aheadOfDiscussion:Kai',
    );
  });

  it('shows a queued question as a dashed pending bubble with its wait', () => {
    const html = render({ pendingQuestion: { text: 'Why green?' } });
    expect(html).toContain('data-testid="stream-pending-question"');
    expect(html).toContain('border-dashed');
    expect(html).toContain('Why green?');
    expect(html).toContain('stage.handRaise.pendingQuestion');
    expect(render({ pendingQuestion: { text: 'Why?', waitsFor: 'step' } })).toContain(
      'stage.handRaise.pendingQuestionStep',
    );
  });

  it('says who asks the learner to speak', () => {
    const html = render({ cueSpeaker: { name: 'Ms. Li', avatar: '/avatars/teacher.png' } });
    expect(html).toContain('data-testid="stream-cue"');
    expect(html).toContain('stage.handRaise.calledBy:Ms. Li');
  });

  it("shows the director's question to the learner with light replies (I10.4)", () => {
    const onQuickReply = vi.fn();
    const html = render({
      cueSpeaker: { name: 'Mia', avatar: '/avatars/mia.png' },
      directorCue: { prompt: ' What would you predict? ' },
      quickReplies: ['Let me think…', "I'm not sure"],
      onQuickReply,
    });
    expect(html).toContain('data-cue="asked"');
    expect(html).toContain('stage.handRaise.askedBy:Mia');
    expect(html.match(/data-testid="stream-cue-reply"/g)).toHaveLength(2);
    expect(html).toContain('Let me think…');
    // Without a name, just the question
    expect(
      render({
        cueSpeaker: { name: '', avatar: '/a.png' },
        directorCue: { prompt: 'Why?' },
      }),
    ).toContain('>Why?<');
  });

  it('offers "let me think" first, apart from the replies that are sent', () => {
    const html = render({
      cueSpeaker: { name: 'Mia', avatar: '/avatars/mia.png' },
      directorCue: { prompt: 'Why?' },
      quickReplies: ["I'm not sure"],
      onQuickReply: vi.fn(),
      thinkReply: 'Let me think…',
      onThink: vi.fn(),
    });
    expect(html.indexOf('stream-cue-think')).toBeLessThan(html.indexOf('stream-cue-reply'));
    expect(html.match(/data-testid="stream-cue-reply"/g)).toHaveLength(1);
    // Not without a question
    expect(
      render({
        cueSpeaker: { name: 'Mia', avatar: '/a.png' },
        directorCue: {},
        thinkReply: 'Let me think…',
        onThink: vi.fn(),
      }),
    ).not.toContain('stream-cue-think');
  });

  it("hands the floor back neutrally when the director's cue asks nothing", () => {
    const html = render({
      cueSpeaker: { name: 'Ms. Li', avatar: '/avatars/teacher.png' },
      directorCue: {},
      quickReplies: ['Let me think…'],
      onQuickReply: vi.fn(),
    });
    expect(html).toContain('data-cue="hand-back"');
    expect(html).toContain('stage.handRaise.handBack:Ms. Li');
    expect(html).not.toContain('calledBy');
    expect(html).not.toContain('stream-cue-reply');
  });
});

describe('the teaching assistant aside in the stream', () => {
  const aside = (overrides: Partial<ChatSession> = {}) =>
    session('aside', {
      createdAt: 1,
      sceneId: 'scene-a',
      status: 'active',
      config: { agentIds: ['default-2'], aside: true },
      messages: [
        {
          id: 'ta-1',
          role: 'assistant',
          parts: [{ type: 'text', text: 'Chlorophyll reflects green.' }],
          metadata: { originalRole: 'agent', agentId: 'default-2', senderName: 'AI助教' },
        },
      ],
      ...overrides,
    });

  it('labels the aside 助教答疑 and streams it on its own flag', () => {
    const render = (props: { isStreaming: boolean; isAsideStreaming: boolean }) =>
      renderToStaticMarkup(
        createElement(ConversationStream, {
          sessions: [aside()],
          scenes,
          asideSessionId: 'aside',
          onEndSession: vi.fn(),
          onContinueSession: vi.fn(),
          ...props,
        }),
      );
    const streaming = render({ isStreaming: false, isAsideStreaming: true });
    expect(streaming).toContain('data-aside="true"');
    expect(streaming).toContain('chat.badge.aside');
    expect(streaming).not.toContain('chat.badge.qa');
    expect(streaming).toContain('bg-success-soft');
    expect(streaming).toContain('aria-busy="true"');
    // The live dot on its last bubble follows the aside, not the Q&A flag
    expect(streaming).toContain('animate-pulse');
    expect(render({ isStreaming: true, isAsideStreaming: false })).not.toContain(
      'animate-pulse ml-1',
    );
  });

  it('keeps a plain Q&A badge for a session without the flag', () => {
    const html = renderToStaticMarkup(
      createElement(ConversationStream, {
        sessions: [aside({ config: { agentIds: ['default-1'] } })],
        scenes,
        isStreaming: false,
        onEndSession: vi.fn(),
        onContinueSession: vi.fn(),
      }),
    );
    expect(html).toContain('chat.badge.qa');
    expect(html).not.toContain('data-aside');
  });

  it("shows the assistant's local invitation and its answering row", () => {
    const assistant = { name: 'AI助教', avatar: '/avatars/assist.png' };
    const prompt = renderToStaticMarkup(
      createElement(AssistantAsideStreamStatus, { assistant, status: 'prompt' }),
    );
    expect(prompt).toContain('data-testid="stream-assistant-prompt"');
    expect(prompt).toContain('AI助教');
    expect(prompt).toContain('settings.agentRoles.assistant');
    expect(prompt).toContain('stage.handRaise.assistantPrompt');

    const answering = renderToStaticMarkup(
      createElement(AssistantAsideStreamStatus, { assistant, status: 'answering' }),
    );
    expect(answering).toContain('data-testid="stream-assistant-answering"');
    expect(answering).toContain('stage.handRaise.assistantAnswering');
  });
});

describe('resolveCueSpeaker', () => {
  const participants = [
    { id: 't', name: 'Ms. Li', avatar: '/t.png', role: 'teacher' },
    { id: 'mia', name: 'Mia', avatar: '/m.png', role: 'student' },
  ];
  const fallback = { name: 'roundtable.teacher', avatar: '/default-teacher.png' };

  it('names the classmate whose question handed the floor to the learner (I31)', () => {
    expect(
      resolveCueSpeaker({
        cued: true,
        handCalled: false,
        cueAgentId: 'mia',
        participants,
        fallback,
      }),
    ).toEqual({ name: 'Mia', avatar: '/m.png' });
    // Not in the participants block: the registry still knows them
    expect(
      resolveCueSpeaker({
        cued: true,
        handCalled: false,
        cueAgentId: 'leo',
        participants,
        getAgent: (id) => (id === 'leo' ? { name: 'Leo' } : undefined),
        fallback,
      }),
    ).toEqual({ name: 'Leo', avatar: '/default-teacher.png' });
  });

  it('gives a called hand, or an unknown speaker, to the teacher; nothing without a cue', () => {
    expect(
      resolveCueSpeaker({
        cued: true,
        handCalled: true,
        cueAgentId: 'mia',
        participants,
        fallback,
      }),
    ).toEqual({ name: 'Ms. Li', avatar: '/t.png' });
    expect(
      resolveCueSpeaker({
        cued: true,
        handCalled: false,
        cueAgentId: 'gone',
        participants,
        fallback,
      }),
    ).toEqual({ name: 'Ms. Li', avatar: '/t.png' });
    expect(
      resolveCueSpeaker({ cued: true, handCalled: false, participants: [], fallback }),
    ).toEqual(fallback);
    expect(
      resolveCueSpeaker({
        cued: false,
        handCalled: false,
        cueAgentId: 'mia',
        participants,
        fallback,
      }),
    ).toBeNull();
  });
});
