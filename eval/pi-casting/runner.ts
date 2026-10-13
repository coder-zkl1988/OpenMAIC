/**
 * Pi Casting Eval (I21)
 *
 * Does persona-driven casting change who speaks, and does it regress? Each
 * scenario runs the REAL Pi director loop (buildDirectorPrompt, read_scene,
 * cue_user, close_session) against a real director model. Child agents are
 * scripted through the eval-only childTurnStub (each agent says its scripted
 * lines in call order), so only the director's casting varies; scenarios
 * marked `e2e` also run with real child agents when EVAL_E2E=1.
 *
 * Both casting modes run side by side ('persona', the default, and 'legacy',
 * the earlier role-order rules; OPENMAIC_PI_PERSONA_CASTING selects one in
 * production), and the report compares them per scenario. Hard checks exist
 * only for uncontroversial cases; everything else is a distribution over N
 * samples. The exit code fails only on a regression against a baseline
 * summary (EVAL_BASELINE), so CI gates on regressions, never on absolutes.
 *
 * Required env:
 *   EVAL_DIRECTOR_MODEL        e.g. anthropic:claude-sonnet-4-5 (or DEFAULT_MODEL)
 *
 * Optional env:
 *   EVAL_SAMPLES               Samples per (scenario, mode). Default 3.
 *   EVAL_SCENARIO              Comma-separated scenario ids to run (cost control).
 *   EVAL_TAGS                  Comma-separated tags (observed-failure, counter-example, ...).
 *   EVAL_CASTING_MODES         Comma-separated modes. Default "persona,legacy".
 *   EVAL_E2E                   "1": also run `e2e` scenarios with real child agents.
 *   EVAL_BASELINE              Path to an earlier summary.json; regressions fail the run.
 *   EVAL_REGRESSION_TOLERANCE  Allowed drop in a hard check's pass rate. Default 0.2.
 *   EVAL_CONCURRENCY           Parallel samples. Default 3.
 *   EVAL_TIMEOUT_MS            Per-sample timeout. Default 120000.
 *
 * Output: eval/pi-casting/results/<model>/<timestamp>/{report.md,summary.json}
 */

import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { resolveAgentConfigs } from '@/lib/chat/pi/config';
import type { PiCastingMode } from '@/lib/types/chat';
import { renderHeader, renderSummaryTable } from '../shared/markdown-report';
import { resolveEvalModel } from '../shared/resolve-model';
import { createRunDir } from '../shared/run-dir';
import { parseList, runBatched, runDirectorSample, type EvalLanguageModel } from './run-sample';
import {
  buildScenarioRequest,
  createScriptedChildStub,
  loadCastingScenarios,
  selectScenarios,
  upcomingSceneIds,
  validateScenarioFile,
  type CastingScenario,
  type CastingScenarioFile,
} from './scenario';
import {
  compareModes,
  findRegressions,
  observeRun,
  summarizeRuns,
  toDelegationRecord,
  type CastingEvalSummary,
  type DelegationRecord,
  type RunObservation,
  type ScenarioModeSummary,
} from './scoring';

const OUTPUT_DIR = 'eval/pi-casting/results';

function getCurrentDir(): string {
  return typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));
}

function parseModes(value: string | undefined): PiCastingMode[] {
  const modes = parseList(value).filter(
    (mode): mode is PiCastingMode => mode === 'persona' || mode === 'legacy',
  );
  return modes.length > 0 ? modes : ['persona', 'legacy'];
}

/** One run of the real director loop on a scenario */
async function runSample(opts: {
  file: CastingScenarioFile;
  scenario: CastingScenario;
  mode: PiCastingMode;
  children: 'stub' | 'e2e';
  evalModel: EvalLanguageModel;
  timeoutMs: number;
}): Promise<RunObservation> {
  const body = buildScenarioRequest(opts.file, opts.scenario);
  const agents = resolveAgentConfigs(body);
  const delegations: DelegationRecord[] = [];
  const childTurnStub =
    opts.children === 'stub'
      ? createScriptedChildStub(opts.scenario, agents, (input) => {
          delegations.push(toDelegationRecord(input));
        })
      : undefined;
  const sample = await runDirectorSample({
    body,
    mode: opts.mode,
    evalModel: opts.evalModel,
    timeoutMs: opts.timeoutMs,
    ...(childTurnStub ? { childTurnStub } : {}),
  });
  return observeRun(sample.events, sample.error, {
    ...(childTurnStub ? { delegations } : {}),
    upcomingSceneIds: upcomingSceneIds(opts.scenario),
    roles: Object.fromEntries(agents.map((agent) => [agent.id, agent.role])),
  });
}

function formatDistribution(counts: Record<string, number>): string {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .map(([key, count]) => `${key} ×${count}`)
    .join('; ');
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

function writeReport(
  runDir: string,
  summary: CastingEvalSummary,
  scenarios: readonly CastingScenario[],
): string {
  const lines: string[] = [];
  lines.push(
    ...renderHeader({
      title: 'Pi Casting Eval',
      timestamp: summary.createdAt,
      model: summary.model,
      extra: { 'Samples per scenario and mode': summary.samples },
    }),
  );
  lines.push(
    ...renderSummaryTable(
      [
        'Scenario',
        'Mode',
        'Children',
        'Hard pass',
        'Mean turns',
        'Non-teacher share',
        'Role coverage',
        'Student last word → learner',
        'Nudge',
        'Fallback cue',
        'Scripted instructions',
        'Errors',
      ],
      summary.results.map((result) => [
        result.scenarioId,
        result.mode,
        result.children,
        result.hard.length > 0 ? percent(result.hardPassRate) : '—',
        String(result.metrics.meanTurns),
        String(result.metrics.nonTeacherShare),
        String(result.metrics.roleCoverage),
        String(result.metrics.studentLastWordHandBack),
        String(result.metrics.nudgeRate),
        String(result.metrics.fallbackCueRate),
        result.children === 'stub' ? String(result.metrics.scriptedInstructionShare) : '—',
        String(result.errors),
      ]),
    ),
  );
  if (summary.comparisons && summary.comparisons.length > 0) {
    lines.push(
      '## Persona vs legacy',
      '',
      'Observed side by side; only hard-check regressions against a baseline fail a run.',
      '',
    );
    lines.push(
      ...renderSummaryTable(
        [
          'Scenario',
          'Children',
          'Hard pass (persona / legacy)',
          'Mean turns',
          'Non-teacher share',
          'Role coverage',
          'Top sequence (persona)',
          'Top sequence (legacy)',
        ],
        summary.comparisons.map((comparison) => [
          comparison.scenarioId,
          comparison.children,
          `${percent(comparison.persona.hardPassRate)} / ${percent(comparison.legacy.hardPassRate)}`,
          `${comparison.persona.meanTurns} / ${comparison.legacy.meanTurns}`,
          `${comparison.persona.nonTeacherShare} / ${comparison.legacy.nonTeacherShare}`,
          `${comparison.persona.roleCoverage} / ${comparison.legacy.roleCoverage}`,
          comparison.persona.topSequence,
          comparison.legacy.topSequence,
        ]),
      ),
    );
  }
  for (const scenario of scenarios) {
    const results = summary.results.filter((result) => result.scenarioId === scenario.id);
    if (results.length === 0) continue;
    lines.push(`## ${scenario.id}`, '', scenario.description, '');
    for (const result of results) {
      lines.push(`### ${result.mode} (${result.children} children)`, '');
      for (const check of result.hard) {
        lines.push(`- Hard: ${check.label}: ${percent(check.passRate)}`);
      }
      lines.push(
        `- First speaker: ${formatDistribution(result.distributions.firstSpeaker)}`,
        `- Sequences: ${formatDistribution(result.distributions.sequence)}`,
        `- Last speaker role: ${formatDistribution(result.distributions.lastSpeakerRole)}`,
        `- Terminal: ${formatDistribution(result.distributions.terminal)}`,
        `- Cast reasons: ${formatDistribution(result.distributions.castReasons)}`,
        '',
      );
    }
  }
  const reportPath = path.join(runDir, 'report.md');
  writeFileSync(reportPath, lines.join('\n'));
  writeFileSync(path.join(runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  return reportPath;
}

async function main() {
  const modelStr = process.env.EVAL_DIRECTOR_MODEL || process.env.DEFAULT_MODEL;
  if (!modelStr) {
    console.error(
      'Error: EVAL_DIRECTOR_MODEL must be set. Example: EVAL_DIRECTOR_MODEL=anthropic:claude-sonnet-4-5',
    );
    process.exit(1);
  }
  const samples = Math.max(1, Number(process.env.EVAL_SAMPLES || '3'));
  const concurrency = Math.max(1, Number(process.env.EVAL_CONCURRENCY || '3'));
  const timeoutMs = Math.max(1000, Number(process.env.EVAL_TIMEOUT_MS || '120000'));
  const tolerance = Number(process.env.EVAL_REGRESSION_TOLERANCE || '0.2');
  const modes = parseModes(process.env.EVAL_CASTING_MODES);
  const runE2e = process.env.EVAL_E2E === '1';

  const file = loadCastingScenarios(path.join(getCurrentDir(), 'scenarios/casting.json'));
  const problems = validateScenarioFile(file);
  if (problems.length > 0) {
    console.error(`scenarios/casting.json is not sound:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  const scenarios = selectScenarios(file.scenarios, {
    ids: parseList(process.env.EVAL_SCENARIO),
    tags: parseList(process.env.EVAL_TAGS),
  });
  console.log('=== Pi Casting Eval ===');
  console.log(
    `Model: ${modelStr} | Samples: ${samples} | Modes: ${modes.join(', ')} | E2E: ${runE2e ? 'on' : 'off'} | Scenarios: ${scenarios.length}`,
  );

  const evalModel = await resolveEvalModel('EVAL_DIRECTOR_MODEL', process.env.DEFAULT_MODEL);
  const runDir = createRunDir(OUTPUT_DIR, modelStr);
  const results: ScenarioModeSummary[] = [];
  for (const scenario of scenarios) {
    const body = buildScenarioRequest(file, scenario);
    const roles = Object.fromEntries(
      resolveAgentConfigs(body).map((agent) => [agent.id, agent.role]),
    );
    const childModes: Array<'stub' | 'e2e'> = scenario.e2e && runE2e ? ['stub', 'e2e'] : ['stub'];
    for (const mode of modes) {
      for (const children of childModes) {
        process.stdout.write(`  - ${scenario.id} [${mode}, ${children}] ... `);
        const runs = await runBatched(samples, concurrency, () =>
          runSample({ file, scenario, mode, children, evalModel, timeoutMs }),
        );
        const summary = summarizeRuns({
          scenarioId: scenario.id,
          mode,
          children,
          runs,
          expectations: scenario.expect ?? [],
          roles,
        });
        results.push(summary);
        console.log(
          `hard ${summary.hard.length > 0 ? percent(summary.hardPassRate) : '—'} | ${formatDistribution(summary.distributions.sequence)}${summary.errors > 0 ? ` | errors ${summary.errors}` : ''}`,
        );
      }
    }
  }

  const summary: CastingEvalSummary = {
    model: modelStr,
    createdAt: new Date().toISOString(),
    samples,
    results,
    comparisons: compareModes(results),
  };
  const reportPath = writeReport(runDir, summary, scenarios);
  console.log(`\nReport: ${reportPath}`);

  const baselinePath = process.env.EVAL_BASELINE;
  if (!baselinePath) {
    console.log('No EVAL_BASELINE: report only.');
    process.exit(0);
  }
  const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8')) as CastingEvalSummary;
  const regressions = findRegressions(summary, baseline, tolerance);
  for (const regression of regressions) {
    console.log(
      `REGRESSION ${regression.scenarioId} [${regression.mode}, ${regression.children}] ${regression.label}: ${regression.baseline} -> ${regression.current}`,
    );
  }
  console.log(`Verdict: ${regressions.length === 0 ? 'PASS' : 'FAIL'} (tolerance ${tolerance})`);
  process.exit(regressions.length === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
