export interface AgentSelection {
  mode: 'preset' | 'auto';
  selectedAgentIds: string[];
}

export interface RestoredAgentSelection {
  selection: AgentSelection;
  /** Whether `selection` is the user's explicit choice (vs stage-derived defaults). */
  isUserSet: boolean;
  /**
   * The user's explicit preset classmates, parked because this course has
   * classmates of its own: kept for the home page (new courses) and for the
   * next course without generated classmates. Absent: nothing is parked.
   */
  parkedPresetAgentIds?: string[];
}

/**
 * Decide the agent mode/selection to apply when a classroom loads.
 *
 * Only an explicit user choice (made in the AgentBar, `persistedIsUserSet`)
 * may carry across classrooms — and only while it is still valid for the
 * loaded stage: a preset selection of known non-generated agents, or an auto
 * selection drawn from this stage's generated agents. Stage-derived defaults
 * written by previous classroom loads are NOT user choices and must never be
 * re-read as one, or visiting a preset classroom would permanently downgrade
 * every auto classroom to preset agents.
 *
 * A course generated with its own classmates is taught by them: the user's
 * preset choice is parked (not dropped) and comes back for the next course
 * without generated classmates, unless the user asked to always use their
 * preset classmates (`presetInGeneratedCourses`).
 *
 * The fallback reproduces the previous unconditional behavior: auto with all
 * generated agents when the stage has them, else the stage's preset agents,
 * else the default trio.
 */
export function restoreAgentSelection(params: {
  persisted: AgentSelection;
  persistedIsUserSet: boolean;
  generatedAgentIds: string[];
  stageAgentIds?: string[];
  isPresetAgent: (id: string) => boolean;
  /** The user's preset classmates parked by an earlier course with its own classmates */
  parkedPresetAgentIds?: string[];
  /** The user asked to always use their preset classmates, even in such a course */
  presetInGeneratedCourses?: boolean;
}): RestoredAgentSelection {
  const {
    persisted,
    persistedIsUserSet,
    generatedAgentIds,
    stageAgentIds,
    isPresetAgent,
    parkedPresetAgentIds,
    presetInGeneratedCourses = false,
  } = params;

  // The user's explicit preset classmates: the user-set preset selection, or
  // (when nothing is user-set) the one an earlier course with its own
  // classmates parked
  const isPresetChoice = (ids: string[] | undefined): ids is string[] =>
    !!ids && ids.length > 0 && ids.every(isPresetAgent);
  const userPreset = persistedIsUserSet
    ? persisted.mode === 'preset' && isPresetChoice(persisted.selectedAgentIds)
      ? persisted.selectedAgentIds
      : undefined
    : isPresetChoice(parkedPresetAgentIds)
      ? parkedPresetAgentIds
      : undefined;

  if (userPreset) {
    if (generatedAgentIds.length > 0 && !presetInGeneratedCourses) {
      return {
        selection: { mode: 'auto', selectedAgentIds: generatedAgentIds },
        isUserSet: false,
        parkedPresetAgentIds: userPreset,
      };
    }
    return {
      selection: persistedIsUserSet ? persisted : { mode: 'preset', selectedAgentIds: userPreset },
      isUserSet: true,
    };
  }

  if (persistedIsUserSet && persisted.mode === 'auto' && persisted.selectedAgentIds.length > 0) {
    const generated = new Set(generatedAgentIds);
    if (persisted.selectedAgentIds.every((id) => generated.has(id))) {
      return { selection: persisted, isUserSet: true };
    }
  }

  if (generatedAgentIds.length > 0) {
    return { selection: { mode: 'auto', selectedAgentIds: generatedAgentIds }, isUserSet: false };
  }
  const cleanIds = stageAgentIds?.filter(isPresetAgent) ?? [];
  return {
    selection: {
      mode: 'preset',
      selectedAgentIds: cleanIds.length > 0 ? cleanIds : ['default-1', 'default-2', 'default-3'],
    },
    isUserSet: false,
  };
}

/** The fields `pickClassroomTeacher` reads from an agent */
export interface ClassroomAgentLike {
  id: string;
  role: string;
  priority?: number;
}

/**
 * The classroom's teacher among the selected agents: the first agent with role
 * 'teacher', else the highest-priority agent — the same pick as the teacher
 * slot of `agentsToParticipants`, so the lecture bubbles, the narrator and the
 * participants block all name the same person. Undefined when no selected id
 * resolves.
 */
export function pickClassroomTeacher<T extends ClassroomAgentLike>(
  agentIds: readonly string[],
  getAgent: (id: string) => T | undefined | null,
): T | undefined {
  const resolved = agentIds.map((id) => getAgent(id)).filter((a): a is T => a != null);
  // Stable sort: teacher first, then by priority (high first), else selection order
  resolved.sort((a, b) => {
    if (a.role === 'teacher' && b.role !== 'teacher') return -1;
    if (a.role !== 'teacher' && b.role === 'teacher') return 1;
    return (b.priority ?? 0) - (a.priority ?? 0);
  });
  return resolved[0];
}
