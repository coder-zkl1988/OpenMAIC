/**
 * One run of the REAL Pi director loop on an eval request, as the route runs
 * it (the same agent resolution, turn and action limits, and thinking
 * default), with the events kept for scoring. Shared by the casting eval
 * (scripted children through the eval-only childTurnStub) and the persona
 * fidelity eval (real children). No route, so nothing here can reach a
 * stub from a request body.
 */
import type { LanguageModel } from 'ai';
import {
  getPiMaxActionsPerAgent,
  getPiMaxAgentTurns,
  resolveAgentConfigs,
} from '@/lib/chat/pi/config';
import { runPiDirectorLoop } from '@/lib/chat/pi/director-loop';
import type {
  PiCastingMode,
  PiChildTurnStub,
  StatelessChatRequest,
  StatelessEvent,
} from '@/lib/types/chat';

/** The tested model, as an eval resolves it (resolveEvalModel) */
export interface EvalLanguageModel {
  model: LanguageModel;
  modelInfo?: { outputWindow?: number; contextWindow?: number } | null;
}

export interface DirectorSample {
  events: StatelessEvent[];
  /** Set when the run failed or timed out; the events so far are kept */
  error?: string;
}

export async function runDirectorSample(opts: {
  body: StatelessChatRequest;
  mode: PiCastingMode;
  evalModel: EvalLanguageModel;
  timeoutMs: number;
  /** Scripted children; absent: the real child agents speak */
  childTurnStub?: PiChildTurnStub;
}): Promise<DirectorSample> {
  // As the route resolves them (an aside strips stage actions)
  const agentConfigs = resolveAgentConfigs(opts.body);
  const events: StatelessEvent[] = [];
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error('eval sample timed out')),
    opts.timeoutMs,
  );
  try {
    await runPiDirectorLoop({
      body: opts.body,
      agentConfigs,
      send: async (event) => {
        events.push(event);
      },
      languageModel: opts.evalModel.model,
      // The route's default when the request names no thinking config
      thinkingConfig: { mode: 'disabled', enabled: false },
      maxOutputTokens: opts.evalModel.modelInfo?.outputWindow,
      contextWindow: opts.evalModel.modelInfo?.contextWindow,
      abortSignal: controller.signal,
      signal: controller.signal,
      maxAgentTurns: getPiMaxAgentTurns(opts.body),
      maxActionsPerAgent: getPiMaxActionsPerAgent(opts.body),
      // Speech is what these evals read; the board would only add cost
      enableWhiteboardTools: false,
      childRuntimeMode: 'legacy',
      castingMode: opts.mode,
      ...(opts.childTurnStub ? { childTurnStub: opts.childTurnStub } : {}),
    });
    return controller.signal.aborted ? { events, error: 'timed out' } : { events };
  } catch (error) {
    return { events, error: error instanceof Error ? error.message : String(error) };
  } finally {
    clearTimeout(timer);
  }
}

/** Run `count` jobs with at most `concurrency` in flight, results in order */
export async function runBatched<T>(
  count: number,
  concurrency: number,
  run: (index: number) => Promise<T>,
): Promise<T[]> {
  const results: T[] = [];
  const limit = Math.max(1, concurrency);
  for (let start = 0; start < count; start += limit) {
    const batch = Array.from({ length: Math.min(limit, count - start) }, (_, offset) =>
      run(start + offset),
    );
    results.push(...(await Promise.all(batch)));
  }
  return results;
}

/** A comma-separated env list, trimmed, empty items dropped */
export function parseList(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}
