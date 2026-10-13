import { describe, expect, it } from 'vitest';
import {
  applyAgentEditOperation,
  undoAgentEditOperation,
  redoAgentEditOperation,
  createAgentConfig,
  priorityForRole,
  teacherCount,
  countAgentScriptReferences,
  rewriteAgentMoments,
  type AgentRoster,
  type AgentRosterHistory,
} from '@/lib/edit/agent-ops';
import { AGENT_COLOR_PALETTE } from '@/lib/constants/agent-defaults';
import type { GeneratedAgentConfig } from '@/lib/types/stage';

const T = (id: string, role = 'teacher'): GeneratedAgentConfig => ({
  id,
  name: id,
  role,
  persona: '',
  avatar: '/avatars/teacher.png',
  color: '#000',
  priority: priorityForRole(role),
});

describe('priorityForRole', () => {
  it('maps roles', () => {
    expect(priorityForRole('teacher')).toBe(10);
    expect(priorityForRole('assistant')).toBe(7);
    expect(priorityForRole('student')).toBe(5);
  });
});

describe('createAgentConfig', () => {
  it('assigns derived defaults by index', () => {
    const a = createAgentConfig('student', 13, 'gen-x');
    expect(a.id).toBe('gen-x');
    expect(a.role).toBe('student');
    expect(a.priority).toBe(5);
    // 13 % 10 === 3 -> AGENT_DEFAULT_AVATARS[3] = '/avatars/thinker.png'
    expect(a.avatar).toBe('/avatars/thinker.png');
  });
});

describe('applyAgentEditOperation (roster)', () => {
  it('adds', () => {
    const r = applyAgentEditOperation([T('a')], { type: 'agent.add', agent: T('b', 'student') });
    expect(r.map((x) => x.id)).toEqual(['a', 'b']);
  });
  it('updates and recomputes priority on role change', () => {
    const r = applyAgentEditOperation([T('a'), T('b', 'student')], {
      type: 'agent.update',
      id: 'b',
      patch: { role: 'assistant', name: 'TA' },
    });
    const b = r.find((x) => x.id === 'b')!;
    expect(b.role).toBe('assistant');
    expect(b.priority).toBe(7);
    expect(b.name).toBe('TA');
  });
  it('reorders', () => {
    const r = applyAgentEditOperation([T('a'), T('b', 'student'), T('c', 'student')], {
      type: 'agent.reorder',
      id: 'c',
      index: 0,
    });
    expect(r.map((x) => x.id)).toEqual(['c', 'a', 'b']);
  });
  it('deletes', () => {
    const r = applyAgentEditOperation([T('a'), T('b', 'student')], {
      type: 'agent.delete',
      id: 'b',
    });
    expect(r.map((x) => x.id)).toEqual(['a']);
  });
  it('blocks deleting the last teacher', () => {
    expect(() =>
      applyAgentEditOperation([T('a'), T('b', 'student')], { type: 'agent.delete', id: 'a' }),
    ).toThrow('LAST_TEACHER');
  });
  it('blocks role-changing the last teacher away', () => {
    expect(() =>
      applyAgentEditOperation([T('a')], {
        type: 'agent.update',
        id: 'a',
        patch: { role: 'student' },
      }),
    ).toThrow('LAST_TEACHER');
  });
});

describe('history overload + undo/redo', () => {
  it('records past and undoes/redoes', () => {
    let h: AgentRosterHistory = { past: [], present: [T('a')], future: [] };
    h = applyAgentEditOperation(h, { type: 'agent.add', agent: T('b', 'student') });
    expect(h.present.map((x) => x.id)).toEqual(['a', 'b']);
    h = undoAgentEditOperation(h);
    expect(h.present.map((x) => x.id)).toEqual(['a']);
    h = redoAgentEditOperation(h);
    expect(h.present.map((x) => x.id)).toEqual(['a', 'b']);
  });

  it('two agent.update ops on same agent+field produce two separate undo steps', () => {
    let h: AgentRosterHistory = { past: [], present: [T('a')], future: [] };
    h = applyAgentEditOperation(h, {
      type: 'agent.update',
      id: 'a',
      patch: { name: 'First Edit' },
    });
    h = applyAgentEditOperation(h, {
      type: 'agent.update',
      id: 'a',
      patch: { name: 'Second Edit' },
    });
    expect(h.present[0].name).toBe('Second Edit');
    h = undoAgentEditOperation(h);
    expect(h.present[0].name).toBe('First Edit');
    h = undoAgentEditOperation(h);
    expect(h.present[0].name).toBe('a');
  });

  it('applies several members’ personas as one undo step (agent.updateMany)', () => {
    let h: AgentRosterHistory = {
      past: [],
      present: [T('a'), T('b', 'student'), T('c', 'student')],
      future: [],
    };
    h = applyAgentEditOperation(h, {
      type: 'agent.updateMany',
      updates: [
        { id: 'b', patch: { persona: 'B is shy.' } },
        { id: 'gone', patch: { persona: 'Nobody.' } },
        { id: 'c', patch: { persona: 'C is loud.' } },
      ],
    });
    expect(h.present.map((x) => x.persona)).toEqual(['', 'B is shy.', 'C is loud.']);
    expect(h.past).toHaveLength(1);
    h = undoAgentEditOperation(h);
    expect(h.present.map((x) => x.persona)).toEqual(['', '', '']);
    // Nothing to change: no history entry
    const same = applyAgentEditOperation(h, { type: 'agent.updateMany', updates: [] });
    expect(same).toBe(h);
  });

  it('caps past history at 50 after 60 adds', () => {
    let h: AgentRosterHistory = { past: [], present: [T('seed')], future: [] };
    for (let i = 0; i < 60; i++) {
      h = applyAgentEditOperation(h, { type: 'agent.add', agent: T(`cap-${i}`, 'student') });
    }
    expect(h.past.length).toBe(50);
  });
});

describe('createAgentConfig', () => {
  it('assigns color from AGENT_COLOR_PALETTE by index', () => {
    // index 13: 13 % 12 === 1 → AGENT_COLOR_PALETTE[1]
    const a = createAgentConfig('student', 13, 'color-test');
    expect(a.color).toBe(AGENT_COLOR_PALETTE[13 % 12]);
  });
});

describe('teacherCount', () => {
  it('returns 0 for empty roster', () => {
    expect(teacherCount([])).toBe(0);
  });

  it('counts only teachers in a mixed roster', () => {
    const roster: AgentRoster = [T('t1', 'teacher'), T('t2', 'teacher'), T('s1', 'student')];
    expect(teacherCount(roster)).toBe(2);
  });
});

describe('script references to a roster member', () => {
  const scenes = [
    {
      id: 's1',
      actions: [
        { id: 'a1', type: 'speech' as const, text: '今天我们和小明一起看看浮力。' },
        { id: 'a2', type: 'discussion' as const, topic: '等等，为什么会浮起来？', agentId: 'mia' },
        { id: 'a3', type: 'spotlight' as const, elementId: 'e1' },
      ],
    },
    {
      id: 's2',
      actions: [
        // The teacher calling on Mia: opened by the teacher, names her
        { id: 'b1', type: 'discussion' as const, topic: 'Mia, what do you predict?', agentId: 't' },
        { id: 'b2', type: 'speech' as const, text: 'MIA was right about the density.' },
        { id: 'b3', type: 'discussion' as const, topic: 'Is it the shape?', agentId: 'mia' },
      ],
    },
    { id: 's3', actions: undefined },
  ];

  it('counts the moments a member opens and the lines that say their name (any case)', () => {
    expect(countAgentScriptReferences(scenes, { id: 'mia', name: 'Mia' })).toEqual({
      moments: 2,
      mentions: 2,
    });
    expect(countAgentScriptReferences(scenes, { id: 'xm', name: ' 小明 ' })).toEqual({
      moments: 0,
      mentions: 1,
    });
    expect(countAgentScriptReferences(scenes, { id: 't', name: 'Ms. Lin' })).toEqual({
      moments: 1,
      mentions: 0,
    });
  });

  it('does not search a one-character name (it would match almost any line)', () => {
    expect(countAgentScriptReferences(scenes, { id: 'mia', name: 'M' })).toEqual({
      moments: 2,
      mentions: 0,
    });
  });

  it("hands a member's moments to the teacher, only in the scenes that have them", () => {
    const changed = rewriteAgentMoments(scenes, 'mia', 't');
    expect(changed.map((c) => c.sceneId)).toEqual(['s1', 's2']);
    expect(changed[0].actions[1]).toEqual({
      id: 'a2',
      type: 'discussion',
      topic: '等等，为什么会浮起来？',
      agentId: 't',
    });
    expect(changed[1].actions.map((a) => (a.type === 'discussion' ? a.agentId : a.type))).toEqual([
      't',
      'speech',
      't',
    ]);
    // The input is not mutated
    expect(scenes[0].actions?.[1]).toMatchObject({ agentId: 'mia' });
  });

  it("drops a member's moments when no teacher takes them", () => {
    const changed = rewriteAgentMoments(scenes, 'mia');
    expect(changed[0].actions.map((a) => a.id)).toEqual(['a1', 'a3']);
    expect(changed[1].actions.map((a) => a.id)).toEqual(['b1', 'b2']);
    expect(rewriteAgentMoments(scenes, 'nobody')).toEqual([]);
  });
});
