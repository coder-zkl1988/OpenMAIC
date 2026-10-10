import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ChatSessionComponent } from '@/components/chat/chat-session';
import type { ChatSession } from '@/lib/types/chat';

vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
}));

describe('ChatSessionComponent markup contract', () => {
  it('preserves newlines in the shared message text wrapper', () => {
    const session: ChatSession = {
      id: 'session-1',
      type: 'qa',
      title: 'Q&A',
      status: 'active',
      messages: [
        {
          id: 'message-1',
          role: 'user',
          parts: [{ type: 'text', text: 'first line\nsecond line' }],
          metadata: { originalRole: 'user', senderName: 'You' },
        },
      ],
      config: { agentIds: ['default-1'] },
      toolCalls: [],
      pendingToolCalls: [],
      createdAt: 1,
      updatedAt: 1,
    };

    const html = renderToStaticMarkup(
      createElement(ChatSessionComponent, { session, isActive: false }),
    );

    expect(html).toContain('class="whitespace-pre-wrap break-words"');
    expect(html).toContain('first line\nsecond line');
  });

  it('renders separate stop and continue controls during soft-closing', () => {
    const session: ChatSession = {
      id: 'session-1',
      type: 'qa',
      title: 'Q&A',
      status: 'soft-closing',
      messages: [],
      config: { agentIds: ['default-1'] },
      toolCalls: [],
      pendingToolCalls: [],
      createdAt: 1,
      updatedAt: 1,
      softCloseDeadline: Date.now() + 15_000,
    };

    const html = renderToStaticMarkup(
      createElement(ChatSessionComponent, {
        session,
        isActive: true,
        onEndSession: vi.fn(),
        onContinueSession: vi.fn(),
      }),
    );

    // Same label as the control bar's stop pill
    expect(html).toContain('roundtable.stopQA');
    expect(html).toContain('chat.softClosing');
    // The soft-close row tells how long until the Q&A ends by itself, but the
    // ticking copy stays out of the accessibility tree (no per-second re-read):
    // only the always-mounted status region announces it, once
    expect(html).toContain(
      '<span aria-hidden="true" class="text-center text-xs text-fg-secondary">chat.softCloseCountdown.qa',
    );
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toContain('<span role="status" class="sr-only">');
    expect(html).not.toContain('animate-ping');
  });

  it('labels a discussion soft-close with the discussion copy', () => {
    const html = renderToStaticMarkup(
      createElement(ChatSessionComponent, {
        session: session({
          type: 'discussion',
          status: 'soft-closing',
          softCloseDeadline: Date.now() + 5_000,
        }),
        isActive: true,
        onEndSession: vi.fn(),
        onContinueSession: vi.fn(),
      }),
    );
    expect(html).toContain('roundtable.stopDiscussion');
    expect(html).toContain('chat.softCloseCountdown.discussion');
  });

  it('shows no end button while the session is live (the control bar owns stop)', () => {
    const html = renderToStaticMarkup(
      createElement(ChatSessionComponent, {
        session: session({ status: 'active' }),
        isActive: true,
        onEndSession: vi.fn(),
        onContinueSession: vi.fn(),
      }),
    );
    expect(html).not.toContain('roundtable.stopQA');
    expect(html).not.toContain('chat.softClosing');
  });

  it('styles the badge, user bubble and agent row as drawn', () => {
    const html = renderToStaticMarkup(
      createElement(ChatSessionComponent, {
        session: session({
          messages: [
            {
              id: 'u1',
              role: 'user',
              parts: [{ type: 'text', text: 'Why?' }],
              metadata: { originalRole: 'user', senderName: 'You' },
            },
            {
              id: 'a1',
              role: 'assistant',
              parts: [{ type: 'text', text: 'Because.' }],
              metadata: { originalRole: 'teacher', senderName: 'Ms. T', agentId: 'custom-t' },
            },
          ],
        }),
        isActive: false,
      }),
    );

    // Q&A badge on the accent
    expect(html).toContain('bg-accent-soft text-accent-text');
    expect(html).toContain('chat.badge.qa');
    // User bubble: primary fill, white text, 14/4/14/14 radius, 14px
    expect(html).toMatch(/rounded-\[14px_4px_14px_14px\] bg-primary text-white/);
    expect(html).toContain('text-[14px]');
    // Agent row: 28px avatar, name, the 教师 role chip and a bordered white bubble
    expect(html).toContain('size-7');
    expect(html).toContain('Ms. T');
    expect(html).toContain('settings.agentRoles.teacher');
    expect(html).toContain('bg-blue-50 text-blue-700');
    expect(html).toMatch(/rounded-\[4px_14px_14px_14px\] border border-line bg-background/);
  });

  it('keeps the active bubble highlight', () => {
    const html = renderToStaticMarkup(
      createElement(ChatSessionComponent, {
        session: session({
          status: 'active',
          messages: [
            {
              id: 'a1',
              role: 'assistant',
              parts: [{ type: 'text', text: 'Speaking' }],
              metadata: { originalRole: 'teacher', senderName: 'Teacher' },
            },
          ],
        }),
        isActive: true,
        activeBubbleId: 'a1',
      }),
    );
    expect(html).toContain('data-active="true"');
    expect(html).toContain('ring-2 ring-accent-soft');
  });

  it('keeps the live caret, the interrupted dot and the loading dots', () => {
    const live = renderToStaticMarkup(
      createElement(ChatSessionComponent, {
        session: session({
          status: 'active',
          messages: [
            {
              id: 'a1',
              role: 'assistant',
              parts: [{ type: 'text', text: 'Stream' }],
              metadata: { originalRole: 'teacher' },
            },
          ],
        }),
        isActive: true,
        isStreaming: true,
      }),
    );
    expect(live).toContain('bg-current opacity-50 animate-pulse');

    const interrupted = renderToStaticMarkup(
      createElement(ChatSessionComponent, {
        session: session({
          messages: [
            {
              id: 'a1',
              role: 'assistant',
              parts: [{ type: 'text', text: 'Cut' }],
              metadata: { originalRole: 'teacher', interrupted: true },
            },
          ],
        }),
        isActive: false,
      }),
    );
    expect(interrupted).toContain('rounded-full bg-danger');

    const loading = renderToStaticMarkup(
      createElement(ChatSessionComponent, {
        session: session({
          status: 'active',
          messages: [
            { id: 'a1', role: 'assistant', parts: [], metadata: { originalRole: 'teacher' } },
          ],
        }),
        isActive: true,
      }),
    );
    expect(loading).toContain('bg-accent-text/70 animate-pulse');
  });

  it.each([
    ['qa', 'roundtable.qaEnded'],
    ['discussion', 'roundtable.discussionEnded'],
  ] as const)('marks an ended %s session with its own persistent marker', (type, key) => {
    const html = renderToStaticMarkup(
      createElement(ChatSessionComponent, {
        session: session({ type, status: 'completed' }),
        isActive: false,
      }),
    );
    expect(html).toContain(key);
    expect(html).not.toContain('chat.ended');
  });

  it('collects whiteboard chips into a row under the bubble and keeps other actions inline', () => {
    const html = renderToStaticMarkup(
      createElement(ChatSessionComponent, {
        session: session({
          messages: [
            {
              id: 'a1',
              role: 'assistant',
              parts: [
                { type: 'text', text: 'Look here' },
                { type: 'action-spotlight', actionName: 'spotlight', state: 'result' },
                { type: 'action-wb_draw_latex', actionName: 'wb_draw_latex', state: 'result' },
                { type: 'text', text: ' and here' },
                { type: 'action-wb_draw_code', actionName: 'wb_draw_code', state: 'running' },
              ] as never,
              metadata: { originalRole: 'teacher' },
            },
          ],
        }),
        isActive: false,
      }),
    );

    const bubbleEnd = html.indexOf(' and here');
    // A named group: a role-less div's aria-label is dropped by assistive tech
    const row = html.indexOf('role="group" aria-label="chat.actionTag.group"');
    expect(row).toBeGreaterThan(bubbleEnd);
    // The spotlight chip stays inside the bubble text, before the row
    expect(html.indexOf('data-action="spotlight"')).toBeLessThan(bubbleEnd);
    expect(html.indexOf('data-action="wb_draw_latex"')).toBeGreaterThan(row);
    expect(html.indexOf('data-action="wb_draw_code"')).toBeGreaterThan(row);
    expect(html).toContain('data-state="running"');
  });
});

function session(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: 'session-1',
    type: 'qa',
    title: 'Q&A',
    status: 'completed',
    messages: [],
    config: { agentIds: ['default-1'] },
    toolCalls: [],
    pendingToolCalls: [],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}
