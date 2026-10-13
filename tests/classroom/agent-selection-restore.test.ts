/**
 * restoreAgentSelection: classroom load must honor the user's explicit
 * agent mode/selection (set in the AgentBar) when still valid for the loaded
 * stage, and fall back to stage-derived defaults otherwise. Stage-derived
 * defaults written by previous classroom loads are NOT user choices and must
 * never carry across stages — otherwise visiting a preset classroom would
 * permanently downgrade every auto classroom to preset agents.
 *
 * A course generated with its own classmates is taught by them: a user-set
 * preset choice is parked there (not dropped) and comes back for the next
 * course without generated classmates, unless the user asked to always use
 * their preset classmates.
 */
import { describe, it, expect } from 'vitest';
import {
  pickClassroomTeacher,
  restoreAgentSelection,
  type AgentSelection,
} from '@/lib/orchestration/registry/agent-selection';

const PRESETS = new Set(['default-1', 'default-2', 'default-3', 'default-4']);
const isPresetAgent = (id: string) => PRESETS.has(id);

describe('restoreAgentSelection', () => {
  it('opens a course with its own classmates with them, parking a user-set preset selection', () => {
    const persisted: AgentSelection = {
      mode: 'preset',
      selectedAgentIds: ['default-2', 'default-3'],
    };
    expect(
      restoreAgentSelection({
        persisted,
        persistedIsUserSet: true,
        generatedAgentIds: ['gen-a', 'gen-b'],
        isPresetAgent,
      }),
    ).toEqual({
      selection: { mode: 'auto', selectedAgentIds: ['gen-a', 'gen-b'] },
      isUserSet: false,
      parkedPresetAgentIds: ['default-2', 'default-3'],
    });
  });

  it('keeps a user-set preset selection in such a course when asked to always use it', () => {
    const persisted: AgentSelection = {
      mode: 'preset',
      selectedAgentIds: ['default-2', 'default-3'],
    };
    expect(
      restoreAgentSelection({
        persisted,
        persistedIsUserSet: true,
        generatedAgentIds: ['gen-a', 'gen-b'],
        isPresetAgent,
        presetInGeneratedCourses: true,
      }),
    ).toEqual({ selection: persisted, isUserSet: true });
    // A parked choice comes back the same way
    expect(
      restoreAgentSelection({
        persisted: { mode: 'auto', selectedAgentIds: ['gen-old'] },
        persistedIsUserSet: false,
        generatedAgentIds: ['gen-a'],
        isPresetAgent,
        parkedPresetAgentIds: ['default-4'],
        presetInGeneratedCourses: true,
      }),
    ).toEqual({ selection: { mode: 'preset', selectedAgentIds: ['default-4'] }, isUserSet: true });
  });

  it('keeps a parked preset parked across courses with their own classmates', () => {
    expect(
      restoreAgentSelection({
        persisted: { mode: 'auto', selectedAgentIds: ['gen-old'] },
        persistedIsUserSet: false,
        generatedAgentIds: ['gen-a'],
        isPresetAgent,
        parkedPresetAgentIds: ['default-2'],
      }),
    ).toEqual({
      selection: { mode: 'auto', selectedAgentIds: ['gen-a'] },
      isUserSet: false,
      parkedPresetAgentIds: ['default-2'],
    });
  });

  it('brings a parked preset back, as the user choice, for a course without generated classmates', () => {
    expect(
      restoreAgentSelection({
        persisted: { mode: 'auto', selectedAgentIds: ['gen-old'] },
        persistedIsUserSet: false,
        generatedAgentIds: [],
        stageAgentIds: ['default-1'],
        isPresetAgent,
        parkedPresetAgentIds: ['default-2', 'default-4'],
      }),
    ).toEqual({
      selection: { mode: 'preset', selectedAgentIds: ['default-2', 'default-4'] },
      isUserSet: true,
    });
  });

  it('drops a parked preset that is no longer valid, and ignores one behind a user-set auto choice', () => {
    expect(
      restoreAgentSelection({
        persisted: { mode: 'auto', selectedAgentIds: [] },
        persistedIsUserSet: false,
        generatedAgentIds: [],
        stageAgentIds: ['default-1'],
        isPresetAgent,
        parkedPresetAgentIds: ['gen-stale'],
      }),
    ).toEqual({ selection: { mode: 'preset', selectedAgentIds: ['default-1'] }, isUserSet: false });
    expect(
      restoreAgentSelection({
        persisted: { mode: 'auto', selectedAgentIds: ['gen-b'] },
        persistedIsUserSet: true,
        generatedAgentIds: ['gen-a', 'gen-b'],
        isPresetAgent,
        parkedPresetAgentIds: ['default-2'],
      }),
    ).toEqual({ selection: { mode: 'auto', selectedAgentIds: ['gen-b'] }, isUserSet: true });
  });

  it("keeps a user-set auto selection that is a subset of this stage's generated agents", () => {
    const persisted: AgentSelection = { mode: 'auto', selectedAgentIds: ['gen-b'] };
    expect(
      restoreAgentSelection({
        persisted,
        persistedIsUserSet: true,
        generatedAgentIds: ['gen-a', 'gen-b'],
        isPresetAgent,
      }),
    ).toEqual({ selection: persisted, isUserSet: true });
  });

  it('ignores a stage-derived persisted selection and applies this stage defaults', () => {
    // A previous classroom load wrote {preset, trio} as its fallback; that is
    // not a user choice, so an auto stage must still get its generated agents.
    expect(
      restoreAgentSelection({
        persisted: { mode: 'preset', selectedAgentIds: ['default-1', 'default-2', 'default-3'] },
        persistedIsUserSet: false,
        generatedAgentIds: ['gen-a', 'gen-b'],
        isPresetAgent,
      }),
    ).toEqual({
      selection: { mode: 'auto', selectedAgentIds: ['gen-a', 'gen-b'] },
      isUserSet: false,
    });
  });

  it("resets a stale user-set auto selection (ids from another stage) to this stage's defaults", () => {
    expect(
      restoreAgentSelection({
        persisted: { mode: 'auto', selectedAgentIds: ['other-stage-gen'] },
        persistedIsUserSet: true,
        generatedAgentIds: ['gen-a', 'gen-b'],
        isPresetAgent,
      }),
    ).toEqual({
      selection: { mode: 'auto', selectedAgentIds: ['gen-a', 'gen-b'] },
      isUserSet: false,
    });
  });

  it('falls back to auto defaults when a user-set preset selection contains unknown ids', () => {
    expect(
      restoreAgentSelection({
        persisted: { mode: 'preset', selectedAgentIds: ['gen-stale', 'default-2'] },
        persistedIsUserSet: true,
        generatedAgentIds: ['gen-a'],
        isPresetAgent,
      }),
    ).toEqual({ selection: { mode: 'auto', selectedAgentIds: ['gen-a'] }, isUserSet: false });
  });

  it('falls back to stage preset agents when nothing is generated and nothing was user-set', () => {
    expect(
      restoreAgentSelection({
        persisted: { mode: 'auto', selectedAgentIds: ['other-stage-gen'] },
        persistedIsUserSet: false,
        generatedAgentIds: [],
        stageAgentIds: ['default-4', 'gen-stale'],
        isPresetAgent,
      }),
    ).toEqual({
      selection: { mode: 'preset', selectedAgentIds: ['default-4'] },
      isUserSet: false,
    });
  });

  it('falls back to the default preset trio when nothing else is valid', () => {
    expect(
      restoreAgentSelection({
        persisted: { mode: 'preset', selectedAgentIds: [] },
        persistedIsUserSet: true,
        generatedAgentIds: [],
        isPresetAgent,
      }),
    ).toEqual({
      selection: { mode: 'preset', selectedAgentIds: ['default-1', 'default-2', 'default-3'] },
      isUserSet: false,
    });
  });

  it('round-trips A(auto) → B(preset) → A without degrading A to preset agents', () => {
    // Simulates sequential classroom loads with no user interaction: each
    // load persists its result and feeds it into the next load.
    const loadA = () => ({ generatedAgentIds: ['gen-a1', 'gen-a2'], stageAgentIds: undefined });
    const loadB = () => ({ generatedAgentIds: [], stageAgentIds: ['default-1', 'default-2'] });

    let state = {
      selection: { mode: 'auto', selectedAgentIds: [] } as AgentSelection,
      isUserSet: false,
    };
    state = restoreAgentSelection({
      persisted: state.selection,
      persistedIsUserSet: state.isUserSet,
      ...loadA(),
      isPresetAgent,
    });
    expect(state.selection).toEqual({ mode: 'auto', selectedAgentIds: ['gen-a1', 'gen-a2'] });

    state = restoreAgentSelection({
      persisted: state.selection,
      persistedIsUserSet: state.isUserSet,
      ...loadB(),
      isPresetAgent,
    });
    expect(state.selection).toEqual({
      mode: 'preset',
      selectedAgentIds: ['default-1', 'default-2'],
    });

    state = restoreAgentSelection({
      persisted: state.selection,
      persistedIsUserSet: state.isUserSet,
      ...loadA(),
      isPresetAgent,
    });
    expect(state.selection).toEqual({ mode: 'auto', selectedAgentIds: ['gen-a1', 'gen-a2'] });
  });

  it('carries a user-set preset choice through the same A → B → A round-trip', () => {
    // A has its own classmates (the preset is parked there), B has none (the
    // preset comes back as the user's choice)
    const persisted: AgentSelection = { mode: 'preset', selectedAgentIds: ['default-2'] };
    let state: ReturnType<typeof restoreAgentSelection> = { selection: persisted, isUserSet: true };
    const expected = [
      {
        selection: { mode: 'auto', selectedAgentIds: ['gen-a1'] },
        isUserSet: false,
        parkedPresetAgentIds: ['default-2'],
      },
      { selection: persisted, isUserSet: true },
      {
        selection: { mode: 'auto', selectedAgentIds: ['gen-a1'] },
        isUserSet: false,
        parkedPresetAgentIds: ['default-2'],
      },
    ];
    [
      { generatedAgentIds: ['gen-a1'], stageAgentIds: undefined },
      { generatedAgentIds: [], stageAgentIds: ['default-1'] },
      { generatedAgentIds: ['gen-a1'], stageAgentIds: undefined },
    ].forEach((stage, i) => {
      state = restoreAgentSelection({
        persisted: state.selection,
        persistedIsUserSet: state.isUserSet,
        parkedPresetAgentIds: state.parkedPresetAgentIds,
        ...stage,
        isPresetAgent,
      });
      expect(state).toEqual(expected[i]);
    });
  });
});

describe('pickClassroomTeacher', () => {
  const agents: Record<string, { id: string; role: string; priority?: number }> = {
    s1: { id: 's1', role: 'student', priority: 5 },
    ta: { id: 'ta', role: 'assistant', priority: 7 },
    t1: { id: 't1', role: 'teacher', priority: 9 },
    t2: { id: 't2', role: 'teacher', priority: 10 },
  };
  const getAgent = (id: string) => agents[id];

  it('picks the teacher, the highest-priority one when there are several', () => {
    expect(pickClassroomTeacher(['s1', 'ta', 't1'], getAgent)?.id).toBe('t1');
    expect(pickClassroomTeacher(['t1', 's1', 't2'], getAgent)?.id).toBe('t2');
  });

  it('falls back to the highest-priority agent (the participants block lead), else nothing', () => {
    expect(pickClassroomTeacher(['s1', 'ta'], getAgent)?.id).toBe('ta');
    expect(pickClassroomTeacher(['unknown', 's1'], getAgent)?.id).toBe('s1');
    expect(pickClassroomTeacher(['unknown'], getAgent)).toBeUndefined();
    expect(pickClassroomTeacher([], getAgent)).toBeUndefined();
  });
});
