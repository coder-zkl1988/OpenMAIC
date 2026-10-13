/**
 * The learner addressing someone by name (I23): the @ menu's query, filter
 * and insertion, and the addressed agents a message's text names.
 */
import { describe, expect, it } from 'vitest';
import {
  addMention,
  filterMentionCandidates,
  findMentionQuery,
  insertMention,
  mentionRoster,
  resolveAddressedAgentIds,
  type MentionRosterMember,
} from '@/lib/chat/agent-mention';
import { PI_REQUEST_BOUNDS } from '@/lib/types/chat';

const roster: MentionRosterMember[] = [
  { id: 'teacher', role: 'teacher', names: ['Ms. Lin', '林老师'] },
  { id: 'mia', role: 'student', names: ['Mia', '小米'] },
  { id: 'ming', role: 'student', names: ['小明'] },
  { id: 'mingming', role: 'student', names: ['小明明'] },
];

describe('findMentionQuery', () => {
  it('reads the @query typed right before the caret', () => {
    expect(findMentionQuery('ask @Mi', 7)).toEqual({ start: 4, end: 7, query: 'Mi' });
    expect(findMentionQuery('@', 1)).toEqual({ start: 0, end: 1, query: '' });
    // Chinese runs on without a space before the @
    expect(findMentionQuery('请问@小', 4)).toEqual({ start: 2, end: 4, query: '小' });
  });

  it('is no mention inside an e-mail address, after a line break or a space', () => {
    expect(findMentionQuery('mail a@b', 8)).toBeNull();
    expect(findMentionQuery('@Mia\nhi', 7)).toBeNull();
    expect(findMentionQuery('@Mia what', 9)).toBeNull();
    expect(findMentionQuery('no mention', 5)).toBeNull();
  });

  it('keeps a space when a name goes on with it', () => {
    expect(findMentionQuery('@Ms. L', 6, ['Ms. Lin'])).toEqual({
      start: 0,
      end: 6,
      query: 'Ms. L',
    });
    expect(findMentionQuery('@Ms. X', 6, ['Ms. Lin'])).toBeNull();
  });
});

describe('filterMentionCandidates', () => {
  const people = [{ name: 'Ms. Lin' }, { name: 'Mia' }, { name: 'Jamie' }];

  it('offers everyone for an empty query, then names that start with it before those that contain it', () => {
    expect(filterMentionCandidates(people, '')).toEqual(people);
    expect(filterMentionCandidates(people, 'mi').map((p) => p.name)).toEqual(['Mia', 'Jamie']);
    expect(filterMentionCandidates(people, 'zz')).toEqual([]);
  });
});

describe('insertMention / addMention', () => {
  it('replaces the typed query with "@Name " and puts the caret after it', () => {
    expect(insertMention('ask @Mi please', { start: 4, end: 7 }, 'Mia')).toEqual({
      text: 'ask @Mia please',
      caret: 9,
    });
    expect(insertMention('@', { start: 0, end: 1 }, '小明')).toEqual({ text: '@小明 ', caret: 4 });
  });

  it('addresses the draft to someone once', () => {
    expect(addMention('', 'Mia')).toBe('@Mia ');
    expect(addMention('  why?', 'Mia')).toBe('@Mia why?');
    expect(addMention('@mia why?', 'Mia')).toBe('@mia why?');
  });
});

describe('resolveAddressedAgentIds', () => {
  it('names each roster member mentioned, in order, once, under any of their names', () => {
    expect(resolveAddressedAgentIds('@小米 and @Ms. Lin, and @Mia again', roster)).toEqual([
      'mia',
      'teacher',
    ]);
    expect(resolveAddressedAgentIds('林老师 without @', roster)).toEqual([]);
  });

  it('takes the longest name, and never a Latin name running into another word', () => {
    expect(resolveAddressedAgentIds('@小明明你觉得呢', roster)).toEqual(['mingming']);
    expect(resolveAddressedAgentIds('@小明你觉得呢', roster)).toEqual(['ming']);
    expect(resolveAddressedAgentIds('@Miami is warm', roster)).toEqual([]);
    expect(resolveAddressedAgentIds('mail a@Mia.com', roster)).toEqual([]);
  });

  it('stops at the route bound', () => {
    const many: MentionRosterMember[] = Array.from({ length: 12 }, (_, i) => ({
      id: `s${i}`,
      names: [`Name${String.fromCharCode(65 + i)}`],
    }));
    const text = many.map((m) => `@${m.names[0]}`).join(' ');
    expect(resolveAddressedAgentIds(text, many)).toHaveLength(
      PI_REQUEST_BOUNDS.addressedAgentIdsMax,
    );
  });
});

describe('mentionRoster', () => {
  it('lists the localized name of a built-in agent next to its registry name', () => {
    const agents: Record<string, { name: string; role: string }> = {
      'default-1': { name: 'AI teacher', role: 'teacher' },
      'gen-1': { name: 'Mia', role: 'student' },
    };
    const t = (key: string) => (key === 'settings.agentNames.default-1' ? '林老师' : key);
    expect(mentionRoster(['default-1', 'gen-1', 'gone'], (id) => agents[id], t)).toEqual([
      { id: 'default-1', role: 'teacher', names: ['林老师', 'AI teacher'] },
      { id: 'gen-1', role: 'student', names: [undefined, 'Mia'] },
    ]);
  });
});
