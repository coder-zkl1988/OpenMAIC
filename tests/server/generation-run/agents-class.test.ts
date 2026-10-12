/**
 * The class a learner asked for, as the agent profiles write it, and why a
 * run's generated agents gave way to the presets (the `agents_fallback`
 * event, a monitoring signal).
 */
import { describe, expect, it } from 'vitest';

import { StepTimeoutError } from '@/lib/server/generation/run/deadline';
import { agentsFallbackReason, requestedClass } from '@/lib/server/generation/run/engine';
import {
  GENERATION_RUN_EVENT_TYPES,
  type GenerationRunInput,
} from '@/lib/server/generation/run/types';
import { StepRefusal } from '@/lib/server/generation/steps/context';

const input = (agents: GenerationRunInput['agents']) =>
  ({ requirement: 'Teach photosynthesis', agents }) as GenerationRunInput;

describe('the class the agent profiles are written for', () => {
  it('is the size and kind the learner chose', () => {
    expect(requestedClass(input({ mode: 'auto', count: 5, atmosphere: 'focused' }))).toEqual({
      agentCount: 5,
      classAtmosphere: 'focused',
    });
  });

  it('is left to the model when the learner chose nothing', () => {
    expect(requestedClass(input({ mode: 'auto' }))).toEqual({});
    expect(requestedClass(input({ mode: 'auto', presetAgentIds: ['default-1'] }))).toEqual({});
  });

  it('is nothing for a preset class', () => {
    expect(requestedClass(input({ mode: 'preset', agentIds: ['default-1'] }))).toEqual({});
  });
});

describe('why generated agents gave way to the presets', () => {
  it('is the refusal of an unusable roster', () => {
    expect(agentsFallbackReason(new StepRefusal('persona-too-short', 'short'))).toBe(
      'persona-too-short',
    );
    expect(agentsFallbackReason(new StepRefusal('unparseable', 'not json'))).toBe('unparseable');
  });

  it('is a timeout, or an error for anything else', () => {
    expect(agentsFallbackReason(new StepTimeoutError('agents', 120_000))).toBe('timeout');
    expect(agentsFallbackReason(new Error('provider down'))).toBe('error');
    expect(agentsFallbackReason('???')).toBe('error');
  });

  it('is a run event subscribers can follow', () => {
    expect(GENERATION_RUN_EVENT_TYPES).toContain('agents_fallback');
    expect(GENERATION_RUN_EVENT_TYPES.indexOf('agents_fallback')).toBeLessThan(
      GENERATION_RUN_EVENT_TYPES.indexOf('agents'),
    );
  });
});
