import { describe, expect, it } from 'vitest';
import { buildCallAgentTool } from '@/lib/chat/pi/tools/call-agent';
import { buildCloseSessionTool } from '@/lib/chat/pi/tools/close-session';
import { buildCueUserTool, normalizeCuePrompt } from '@/lib/chat/pi/tools/cue-user';
import { PI_REQUEST_BOUNDS } from '@/lib/types/chat';

describe('Pi chat cue_user tool', () => {
  it('emits the existing cue_user payload once', async () => {
    const events: unknown[] = [];
    let userCued = false;
    const tool = buildCueUserTool({
      getLastAgentId: () => 'default-1',
      cueUser: async (data) => {
        if (userCued) return false;
        userCued = true;
        events.push({ type: 'cue_user', data });
        return true;
      },
    });

    const first = await tool.execute('cue-1', { prompt: 'Any follow-up?' });
    const second = await tool.execute('cue-2', { prompt: 'Again?' });

    expect(events).toEqual([
      {
        type: 'cue_user',
        data: { fromAgentId: 'default-1', prompt: 'Any follow-up?' },
      },
    ]);
    expect(first.details).toEqual({ emitted: true });
    expect(second.details).toEqual({ emitted: false });
  });

  it('does not emit cue_user before any classroom agent turn when guarded', async () => {
    const events: unknown[] = [];
    const tool = buildCueUserTool({
      getLastAgentId: () => undefined,
      canCueUser: () => false,
      cueUser: async (data) => {
        events.push({ type: 'cue_user', data });
        return true;
      },
    });

    const result = await tool.execute('cue-1', { prompt: 'Any follow-up?' });

    expect(events).toEqual([]);
    expect(result.details).toEqual({
      emitted: false,
      skipped: true,
      reason: 'no_agent_turns',
    });
  });

  it('soft-skips cue_user with a teacher substantive reason when configured', async () => {
    const events: unknown[] = [];
    const tool = buildCueUserTool({
      getLastAgentId: () => 'student-1',
      canCueUser: () => false,
      cueUserSkipReason: 'no_substantive_teacher_turn',
      cueUser: async (data) => {
        events.push({ type: 'cue_user', data });
        return true;
      },
    });

    const result = await tool.execute('cue-1', { prompt: 'Any follow-up?' });

    expect(events).toEqual([]);
    expect(result.details).toEqual({
      emitted: false,
      skipped: true,
      reason: 'no_substantive_teacher_turn',
    });
  });

  it('soft-skips cue_user with a teacher-or-assistant substantive reason when configured', async () => {
    const events: unknown[] = [];
    const tool = buildCueUserTool({
      getLastAgentId: () => 'student-1',
      canCueUser: () => false,
      cueUserSkipReason: 'no_substantive_teaching_turn',
      cueUser: async (data) => {
        events.push({ type: 'cue_user', data });
        return true;
      },
    });

    const result = await tool.execute('cue-1', { prompt: 'Any follow-up?' });

    expect(events).toEqual([]);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: "Call the teacher or teaching assistant for a visible answer before cueing the user. If a student's last line asked the learner a direct question, cue the user with that question as the prompt.",
      },
    ]);
    expect(result.details).toEqual({
      emitted: false,
      skipped: true,
      reason: 'no_substantive_teaching_turn',
    });
  });

  it('allows cue_user after a teaching assistant substantive turn when guarded', async () => {
    const events: unknown[] = [];
    const tool = buildCueUserTool({
      getLastAgentId: () => 'assistant-1',
      canCueUser: () => true,
      cueUserSkipReason: 'no_substantive_teaching_turn',
      cueUser: async (data) => {
        events.push({ type: 'cue_user', data });
        return true;
      },
    });

    const result = await tool.execute('cue-1', { prompt: 'Any follow-up?' });

    expect(events).toEqual([
      {
        type: 'cue_user',
        data: { fromAgentId: 'assistant-1', prompt: 'Any follow-up?' },
      },
    ]);
    expect(result.details).toEqual({ emitted: true });
  });

  it('allows cue_user after a teacher substantive turn when guarded', async () => {
    const events: unknown[] = [];
    const tool = buildCueUserTool({
      getLastAgentId: () => 'teacher-1',
      canCueUser: () => true,
      cueUserSkipReason: 'no_substantive_teacher_turn',
      cueUser: async (data) => {
        events.push({ type: 'cue_user', data });
        return true;
      },
    });

    const result = await tool.execute('cue-1', { prompt: 'Any follow-up?' });

    expect(events).toEqual([
      {
        type: 'cue_user',
        data: { fromAgentId: 'teacher-1', prompt: 'Any follow-up?' },
      },
    ]);
    expect(result.details).toEqual({ emitted: true });
  });

  it('refuses cue_user after the session is closed', async () => {
    const events: unknown[] = [];
    const tool = buildCueUserTool({
      getLastAgentId: () => 'default-1',
      isSessionClosed: () => true,
      cueUser: async (data) => {
        events.push({ type: 'cue_user', data });
        return true;
      },
    });

    const result = await tool.execute('cue-1', { prompt: 'Any follow-up?' });

    expect(events).toEqual([]);
    expect(result.details).toEqual({
      emitted: false,
      skipped: true,
      reason: 'session_closed',
    });
  });

  it('skips call_agent after the user has already been cued', async () => {
    const tool = buildCallAgentTool({
      body: {
        messages: [],
        storeState: {
          stage: { id: 'stage-1', name: 'Stage' },
          scenes: [],
          currentSceneId: null,
          whiteboardOpen: false,
        },
        config: { agentIds: ['default-1'] },
        apiKey: '',
      } as never,
      agentConfigs: [],
      send: async () => {},
      languageModel: {} as never,
      onAgentDone: () => {},
      onActionDone: () => {},
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 1,
      enableWhiteboardTools: false,
      isUserCued: () => true,
    });

    const result = await tool.execute('call-1', {
      agentId: 'default-1',
      instruction: 'Please answer.',
    });

    expect(result.details).toEqual({ skipped: true, reason: 'user_already_cued' });
  });

  it('skips call_agent after the session is closed', async () => {
    const tool = buildCallAgentTool({
      body: {
        messages: [],
        storeState: {
          stage: { id: 'stage-1', name: 'Stage' },
          scenes: [],
          currentSceneId: null,
          whiteboardOpen: false,
        },
        config: { agentIds: ['default-1'] },
        apiKey: '',
      } as never,
      agentConfigs: [],
      send: async () => {},
      languageModel: {} as never,
      onAgentDone: () => {},
      onActionDone: () => {},
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 6,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 1,
      enableWhiteboardTools: false,
      isSessionClosed: () => true,
    });

    const result = await tool.execute('call-1', {
      agentId: 'default-1',
      instruction: 'Please answer.',
    });

    expect(result.details).toEqual({ skipped: true, reason: 'session_closed' });
  });

  it('counts rejected call_agent requests toward the hard attempt cap', async () => {
    const tool = buildCallAgentTool({
      body: {
        messages: [],
        storeState: {
          stage: { id: 'stage-1', name: 'Stage' },
          scenes: [],
          currentSceneId: null,
          whiteboardOpen: false,
        },
        config: { agentIds: ['default-1'] },
        apiKey: '',
      } as never,
      agentConfigs: [],
      send: async () => {},
      languageModel: {} as never,
      onAgentDone: () => {},
      onActionDone: () => {},
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 1,
      getAgentTurnCount: () => 0,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 1,
      enableWhiteboardTools: false,
    });

    for (let i = 0; i < 4; i += 1) {
      await expect(
        tool.execute(`invalid-${i}`, {
          agentId: 'missing-agent',
          instruction: 'Please answer.',
        }),
      ).resolves.toMatchObject({
        details: { skipped: true, reason: 'invalid_agent_id' },
      });
    }

    await expect(
      tool.execute('over-cap', {
        agentId: 'missing-agent',
        instruction: 'Please answer.',
      }),
    ).resolves.toMatchObject({
      details: { skipped: true, reason: 'agent_attempt_cap', totalAgentAttempts: 4 },
    });
  });

  it('does not allow any call_agent after the agent turn budget is reached', async () => {
    const tool = buildCallAgentTool({
      body: {
        messages: [],
        storeState: {
          stage: { id: 'stage-1', name: 'Stage' },
          scenes: [],
          currentSceneId: null,
          whiteboardOpen: false,
        },
        config: { agentIds: ['teacher-1'] },
        apiKey: '',
      } as never,
      agentConfigs: [
        {
          id: 'teacher-1',
          name: 'Teacher',
          role: 'teacher',
          persona: 'Summarize clearly.',
          avatar: '',
          color: '#3366ff',
          allowedActions: [],
          priority: 10,
          createdAt: new Date('2026-01-01T00:00:00Z'),
          updatedAt: new Date('2026-01-01T00:00:00Z'),
          isDefault: true,
        },
      ],
      send: async () => {},
      languageModel: {} as never,
      onAgentDone: () => {},
      onActionDone: () => {},
      thinkingConfig: { mode: 'disabled', enabled: false },
      abortSignal: new AbortController().signal,
      maxAgentTurns: 1,
      getAgentTurnCount: () => 1,
      getAgentResponses: () => [],
      getWhiteboardLedger: () => [],
      maxActionsPerAgent: 1,
      enableWhiteboardTools: false,
    });

    expect(
      (tool.parameters as { properties?: Record<string, unknown> }).properties,
    ).not.toHaveProperty('turnKind');

    const result = await tool.execute('call-1', {
      agentId: 'teacher-1',
      instruction: 'Give a final summary.',
    });

    expect(result.details).toEqual({
      skipped: true,
      reason: 'agent_turn_limit',
      maxAgentTurns: 1,
    });
  });
});

describe('Pi chat student last word', () => {
  function makeNudge() {
    let nudged = false;
    const calls: Array<string | undefined> = [];
    return {
      calls,
      take: (prompt?: string) => {
        calls.push(prompt);
        if (nudged) return undefined;
        nudged = true;
        return 'The last line of this turn came from 小思, a student.';
      },
    };
  }

  it('forwards only a trimmed, bounded question as the cue prompt', async () => {
    expect(normalizeCuePrompt(undefined)).toBeUndefined();
    expect(normalizeCuePrompt('   ')).toBeUndefined();
    expect(normalizeCuePrompt('  你觉得呢？ ')).toBe('你觉得呢？');
    expect(
      Array.from(normalizeCuePrompt('问'.repeat(PI_REQUEST_BOUNDS.cuePromptMaxChars + 20))!),
    ).toHaveLength(PI_REQUEST_BOUNDS.cuePromptMaxChars);

    const events: unknown[] = [];
    const tool = buildCueUserTool({
      getLastAgentId: () => 'default-1',
      cueUser: async (data) => {
        events.push(data);
        return true;
      },
    });
    await tool.execute('cue-1', { prompt: '   ' });
    expect(events).toEqual([{ fromAgentId: 'default-1' }]);
    expect(Object.keys(events[0] as object)).not.toContain('prompt');
  });

  it('reminds the director once before cueing after a student, then lets it through', async () => {
    const events: unknown[] = [];
    const nudge = makeNudge();
    const tool = buildCueUserTool({
      getLastAgentId: () => 'student-1',
      canCueUser: () => true,
      takeLastWordNudge: nudge.take,
      cueUser: async (data) => {
        events.push(data);
        return true;
      },
    });

    const first = await tool.execute('cue-1', { prompt: ' 你会怎么想？ ' });
    expect(events).toEqual([]);
    expect(first.details).toEqual({ emitted: false, skipped: true, reason: 'student_last_word' });
    expect(first.content).toEqual([
      { type: 'text', text: 'The last line of this turn came from 小思, a student.' },
    ]);
    expect(nudge.calls).toEqual(['你会怎么想？']);

    const second = await tool.execute('cue-2', { prompt: '你会怎么想？' });
    expect(second.details).toEqual({ emitted: true });
    expect(events).toEqual([{ fromAgentId: 'student-1', prompt: '你会怎么想？' }]);
  });

  it('checks the teaching gate before the reminder', async () => {
    const nudge = makeNudge();
    const tool = buildCueUserTool({
      getLastAgentId: () => 'student-1',
      canCueUser: () => false,
      cueUserSkipReason: 'no_substantive_teaching_turn',
      takeLastWordNudge: nudge.take,
      cueUser: async () => true,
    });

    const result = await tool.execute('cue-1', {});
    expect(result.details).toMatchObject({ reason: 'no_substantive_teaching_turn' });
    expect(nudge.calls).toEqual([]);
  });

  it('reminds the director once before closing after a student', async () => {
    const closed: unknown[] = [];
    const nudge = makeNudge();
    const tool = buildCloseSessionTool({
      canCloseSession: () => true,
      takeLastWordNudge: () => nudge.take(),
      closeSession: async (data) => {
        closed.push(data);
        return true;
      },
    });

    const first = await tool.execute('close-1', { endReason: 'user_done' });
    expect(first.details).toEqual({ emitted: false, skipped: true, reason: 'student_last_word' });
    expect(closed).toEqual([]);

    const second = await tool.execute('close-2', { endReason: 'user_done' });
    expect(second.details).toEqual({ emitted: true });
    expect(closed).toEqual([{ endReason: 'user_done' }]);
  });

  it('opens the turn limit only to the teacher or assistant, right after a student', async () => {
    const studentAgent = {
      id: 'student-1',
      name: '小思',
      role: 'student',
      persona: 'Curious.',
      avatar: '',
      color: '#ff9933',
      allowedActions: [],
      priority: 1,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      isDefault: false,
    };
    const makeTool = (turnCount: number, studentLastWord: boolean) =>
      buildCallAgentTool({
        body: {
          messages: [],
          storeState: {
            stage: { id: 'stage-1', name: 'Stage' },
            scenes: [],
            currentSceneId: null,
            whiteboardOpen: false,
          },
          config: { agentIds: ['student-1'] },
          apiKey: '',
        } as never,
        agentConfigs: [studentAgent],
        send: async () => {},
        languageModel: {} as never,
        onAgentDone: () => {},
        onActionDone: () => {},
        thinkingConfig: { mode: 'disabled', enabled: false },
        abortSignal: new AbortController().signal,
        maxAgentTurns: 2,
        getAgentTurnCount: () => turnCount,
        getAgentResponses: () => [],
        getWhiteboardLedger: () => [],
        maxActionsPerAgent: 1,
        enableWhiteboardTools: false,
        getStudentLastWord: () =>
          studentLastWord ? { agentId: 'student-1', agentName: '小思' } : undefined,
      });

    const atLimit = await makeTool(2, true).execute('call-1', {
      agentId: 'student-1',
      instruction: 'Add one more thought.',
    });
    expect(atLimit.details).toEqual({
      skipped: true,
      reason: 'agent_turn_limit',
      maxAgentTurns: 2,
      closingTurnOpenTo: ['teacher', 'assistant'],
    });
    expect(atLimit.content[0]).toMatchObject({
      text: expect.stringContaining(
        'only the teacher or teaching assistant may take one more turn',
      ),
    });

    // Past the one closing turn, or without a student's last word, the limit is plain
    for (const tool of [makeTool(3, true), makeTool(2, false)]) {
      const result = await tool.execute('call-2', {
        agentId: 'student-1',
        instruction: 'Add one more thought.',
      });
      expect(result.details).toEqual({
        skipped: true,
        reason: 'agent_turn_limit',
        maxAgentTurns: 2,
      });
    }
  });
});
