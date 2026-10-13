/**
 * Persona Fidelity Eval (I26)
 *
 * Do the teacher, the teaching assistant and the AI students come across as
 * the people their personas describe? Three parts, each switchable:
 *
 * 1. generation: the REAL agent-profiles step (generateAgentProfiles) writes
 *    rosters for scenarios/courses.json; deterministic checks (validateRoster,
 *    schedule/quota wording, list markup, the learner's private details,
 *    language) plus a judge's per-persona rubric (the five elements,
 *    real_person, caricature, script_like).
 * 2. speaker: each course's classroom (3+ people) is played by the REAL Pi
 *    director loop with REAL child agents; every line, with all names
 *    removed, goes to the judge, which must say who in the roster said it.
 *    Accuracy is reported against chance, also among students only.
 * 3. boundary: the same transcripts, counted for the four cognitive-boundary
 *    failures (content not taught yet, a student lecturing, the assistant
 *    taking over, a student's wrong line left unanswered), by deterministic
 *    proxies and by the judge.
 *
 * The judge must come from another vendor than the tested model, and it is
 * guarded against preferring exaggerated, stereotyped personas: caricature
 * is scored on its own axis, the rubric says vivid is not more real and
 * length is not quality, orders are shuffled, length bias is reported, and
 * the judge must rank a fixed calibration set right (an ordinary student
 * above a stereotype and a schedule) before its persona scores count.
 *
 * Nothing is an absolute gate: with EVAL_BASELINE the run fails only on a
 * regression beyond the tolerance (or when the judge fails calibration).
 *
 * Required env:
 *   EVAL_PERSONA_MODEL   The tested model: writes the personas and plays the class (or DEFAULT_MODEL)
 *   EVAL_JUDGE_MODEL     The judge, from another vendor
 *
 * Optional env:
 *   EVAL_PARTS                     generation,speaker,boundary (default: all three)
 *   EVAL_SAMPLES                   Samples per course / classroom prompt. Default 2.
 *   EVAL_COURSE                    Comma-separated course ids (cost control)
 *   EVAL_PROMPT                    Comma-separated classroom prompt ids
 *   EVAL_ROSTER_SOURCE             fixed (default) | generated: who plays the classroom
 *   EVAL_CASTING_MODE              persona (default) | legacy
 *   EVAL_ALLOW_SAME_VENDOR         "1": run with a judge of the tested model's vendor anyway
 *   EVAL_ALLOW_UNCALIBRATED_JUDGE  "1": do not fail the run when the judge fails calibration
 *   EVAL_BASELINE                  Path to an earlier summary.json; regressions fail the run
 *   EVAL_REGRESSION_TOLERANCE      Allowed move in the wrong direction. Default 0.15.
 *   EVAL_CONCURRENCY               Parallel model calls. Default 3.
 *   EVAL_TIMEOUT_MS                Per classroom run. Default 180000.
 *
 * Output: eval/persona-fidelity/results/<model>/<timestamp>/{report.md,summary.json,transcripts.json}
 */

import { readFileSync, writeFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createLogger } from '@/lib/logger';
import { AGENT_AVATARS } from '@/lib/server/generation/agent-avatars';
import { generateAgentProfiles } from '@/lib/server/generation/steps/agent-profiles';
import type { PiCastingMode } from '@/lib/types/chat';
import { parseList, runBatched, runDirectorSample } from '../pi-casting/run-sample';
import { buildScenarioRequest } from '../pi-casting/scenario';
import { renderHeader, renderSummaryTable } from '../shared/markdown-report';
import { resolveEvalModel } from '../shared/resolve-model';
import { createRunDir } from '../shared/run-dir';
import {
  BOUNDARY_KINDS,
  checkCalibration,
  checkRoster,
  compareVendors,
  findFidelityRegressions,
  summarizeGeneration,
  type BoundarySummary,
  type CalibrationKey,
  type CalibrationResult,
  type GenerationSample,
  type GenerationSummary,
  type PersonaFidelitySummary,
  type PersonaVerdict,
  type SpeakerSummary,
} from './checks';
import {
  assessBoundary,
  assessSpeakers,
  meanCaricature,
  pickClassroomRoster,
  toClassroomRun,
  type TranscriptRun,
} from './classroom';
import { judgeRoster } from './judge';
import {
  buildClassroomScenario,
  loadFidelityFile,
  validateFidelityFile,
  type FidelityAgent,
  type FidelityCourse,
} from './scenario';

const OUTPUT_DIR = 'eval/persona-fidelity/results';
const PARTS = ['generation', 'speaker', 'boundary'] as const;
type Part = (typeof PARTS)[number];
type ResolvedEvalModel = Awaited<ReturnType<typeof resolveEvalModel>>;

const log = createLogger('PersonaFidelityEval');

function getCurrentDir(): string {
  return typeof __dirname !== 'undefined'
    ? __dirname
    : path.dirname(fileURLToPath(import.meta.url));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function percent(value: number | null | undefined): string {
  return typeof value === 'number' ? `${Math.round(value * 100)}%` : '—';
}

function parseParts(value: string | undefined): Set<Part> {
  const parts = parseList(value).filter((part): part is Part =>
    (PARTS as readonly string[]).includes(part),
  );
  return new Set(parts.length > 0 ? parts : PARTS);
}

// ==================== Part 1: persona generation ====================

interface GeneratedRoster {
  agents?: FidelityAgent[];
  result: GenerationSample;
}

async function generateRoster(
  course: FidelityCourse,
  tested: ResolvedEvalModel,
): Promise<GeneratedRoster> {
  try {
    const profiles = await generateAgentProfiles(
      {
        stageInfo: {
          name: course.name,
          ...(course.description ? { description: course.description } : {}),
        },
        ...(course.learnerLevel ? { learnerLevel: course.learnerLevel } : {}),
        sceneOutlines: course.sceneOutlines,
        ...(course.agentCount ? { agentCount: course.agentCount } : {}),
        ...(course.classAtmosphere ? { classAtmosphere: course.classAtmosphere } : {}),
        languageDirective: course.languageDirective,
        availableAvatars: AGENT_AVATARS.map((avatar) => avatar.path),
        avatarDescriptions: [...AGENT_AVATARS],
        model: tested,
      },
      { log },
    );
    const agents = profiles.map(({ id, name, role, persona }) => ({
      id,
      name,
      role: role as FidelityAgent['role'],
      persona,
    }));
    return { agents, result: { ok: true, check: checkRoster(agents, course) } };
  } catch (error) {
    return { result: { ok: false, error: errorMessage(error) } };
  }
}

// ==================== Part 2/3: the classroom ====================

async function playClassroom(opts: {
  course: FidelityCourse;
  roster: readonly FidelityAgent[];
  promptIds: ReadonlySet<string>;
  samples: number;
  concurrency: number;
  timeoutMs: number;
  mode: PiCastingMode;
  tested: ResolvedEvalModel;
  notes: string[];
}): Promise<TranscriptRun[]> {
  const { course, roster } = opts;
  const runs: TranscriptRun[] = [];
  for (const prompt of course.classroom?.prompts ?? []) {
    if (opts.promptIds.size > 0 && !opts.promptIds.has(prompt.id)) continue;
    const built = buildClassroomScenario(course, prompt, roster);
    if ('skip' in built) {
      opts.notes.push(`${course.id}/${prompt.id} skipped: ${built.skip}`);
      continue;
    }
    const body = buildScenarioRequest(built.file, built.scenario);
    process.stdout.write(`  - ${course.id}/${prompt.id} ... `);
    const played = await runBatched(opts.samples, opts.concurrency, async (sample) => {
      const result = await runDirectorSample({
        body,
        mode: opts.mode,
        evalModel: opts.tested,
        timeoutMs: opts.timeoutMs,
      });
      return toClassroomRun({
        courseId: course.id,
        promptId: prompt.id,
        sample,
        built,
        agentIds: body.config.agentIds,
        roster,
        events: result.events,
        ...(result.error ? { error: result.error } : {}),
      });
    });
    runs.push(...played);
    console.log(
      played
        .map((run) =>
          run.error ? `error` : run.turns.map((turn) => turn.name).join('>') || '(none)',
        )
        .join(' | '),
    );
  }
  return runs;
}

// ==================== Report ====================

interface CourseTranscripts {
  courseId: string;
  rosterFrom: string;
  roster: FidelityAgent[];
  runs: TranscriptRun[];
}

function writeReport(opts: {
  runDir: string;
  summary: PersonaFidelitySummary;
  transcripts: CourseTranscripts[];
  rosterVerdicts: Record<string, PersonaVerdict[]>;
  notes: string[];
}): string {
  const { summary } = opts;
  const lines: string[] = [];
  lines.push(
    ...renderHeader({
      title: 'Persona Fidelity Eval',
      timestamp: summary.createdAt,
      model: `${summary.testedModel} (${summary.testedVendor})`,
      judgeModel: `${summary.judgeModel} (${summary.judgeVendor})${summary.sameVendor ? ' — SAME VENDOR, read with care' : ''}`,
      extra: {
        Samples: summary.samples,
        'Casting mode': summary.castingMode,
        'Classroom roster': summary.rosterSource,
      },
    }),
  );

  if (summary.judgeCalibration) {
    lines.push(
      '## Judge calibration',
      '',
      summary.judgeCalibration.passed
        ? 'Passed: the judge ranks an ordinary student above a stereotype and a schedule.'
        : `FAILED — the judge's persona scores are not trusted (and not gated): ${summary.judgeCalibration.failures.join('; ')}`,
      '',
    );
  }

  if (summary.generation.length > 0) {
    lines.push('## Persona generation', '');
    lines.push(
      ...renderSummaryTable(
        [
          'Course',
          'Samples',
          'Errors',
          'Valid',
          'T / A / S',
          'Schedule wording',
          'List markup',
          'Wrong language',
          'Private detail leak',
          'Max student similarity',
          'Elements',
          'Real person',
          'Caricature',
          'Believable',
          'Script-like',
          'Students distinct',
          'Length bias r',
        ],
        summary.generation.map((course) => [
          course.courseId,
          String(course.samples),
          String(course.errors),
          percent(course.validRate),
          `${course.meanCounts.teacher} / ${course.meanCounts.assistant} / ${course.meanCounts.student}`,
          percent(course.scriptMarkerRate),
          percent(course.listMarkupRate),
          percent(course.scriptMismatchRate),
          percent(course.leakRate),
          String(course.meanMaxStudentSimilarity),
          percent(course.judge?.elementCoverage),
          String(course.judge?.realPersonMean ?? '—'),
          String(course.judge?.caricatureMean ?? '—'),
          percent(course.judge?.believableRate),
          percent(course.judge?.scriptLikeRate),
          percent(course.judge?.studentsDistinctRate),
          String(course.judge?.lengthBias ?? '—'),
        ]),
      ),
    );
  }

  if (summary.speaker.length > 0) {
    lines.push(
      '## Speaker identification',
      '',
      'Names removed; the judge picks the speaker from the roster. Read accuracy next to the roster’s caricature: identification bought with caricature is no win.',
      '',
    );
    lines.push(
      ...renderSummaryTable(
        [
          'Course',
          'Lines',
          'Too short',
          'Judged',
          'Accuracy (chance)',
          'Role accuracy',
          'Right student (chance)',
          'Unsure',
          'Roster caricature',
        ],
        summary.speaker.map((course) => [
          course.courseId,
          String(course.lines),
          String(course.tooShort),
          `${course.judged}${course.errors ? ` (${course.errors} unusable)` : ''}`,
          `${percent(course.accuracy)} (${percent(course.chance)})`,
          percent(course.roleAccuracy),
          `${percent(course.studentWithinRoleAccuracy)} (${percent(course.studentChance)})`,
          percent(course.unsureRate),
          String(course.rosterCaricatureMean ?? '—'),
        ]),
      ),
    );
    for (const course of summary.speaker) {
      const roster = opts.transcripts.find((entry) => entry.courseId === course.courseId)?.roster;
      const name = (id: string) => roster?.find((agent) => agent.id === id)?.name ?? id;
      lines.push(`### ${course.courseId}: who was taken for whom`, '');
      for (const [trueId, picks] of Object.entries(course.confusion)) {
        lines.push(
          `- ${name(trueId)}: ${Object.entries(picks)
            .sort((a, b) => b[1] - a[1])
            .map(([picked, count]) => `${picked === 'unsure' ? 'unsure' : name(picked)} ×${count}`)
            .join('; ')}`,
        );
      }
      lines.push('');
    }
  }

  if (summary.boundary.length > 0) {
    lines.push(
      '## Cognitive boundary',
      '',
      'Runs with at least one case: deterministic proxy / judge. Untaught = a student uses an upcoming page; student lectures; assistant takes over; a student’s wrong line left unanswered (proxy: a student had the last word without asking the learner).',
      '',
    );
    lines.push(
      ...renderSummaryTable(
        ['Course', 'Runs', 'Judged', ...BOUNDARY_KINDS],
        summary.boundary.map((course) => [
          course.courseId,
          String(course.runs),
          `${course.judged}${course.judgeErrors ? ` (${course.judgeErrors} unusable)` : ''}`,
          ...BOUNDARY_KINDS.map(
            (kind) =>
              `${percent(course.counters[kind].detRate)} / ${percent(course.counters[kind].judgeRate)}`,
          ),
        ]),
      ),
    );
  }

  const verdictCourses = Object.entries(opts.rosterVerdicts);
  if (verdictCourses.length > 0) {
    lines.push('## Classroom rosters as the judge read them', '');
    for (const [courseId, verdicts] of verdictCourses) {
      lines.push(
        `- ${courseId}: ${verdicts
          .map(
            (verdict) =>
              `${verdict.name} (${verdict.role}) real ${verdict.realPerson}, caricature ${verdict.caricature}`,
          )
          .join('; ')}`,
      );
    }
    lines.push('');
  }
  if (opts.notes.length > 0)
    lines.push('## Notes', '', ...opts.notes.map((note) => `- ${note}`), '');

  const reportPath = path.join(opts.runDir, 'report.md');
  writeFileSync(reportPath, lines.join('\n'));
  writeFileSync(path.join(opts.runDir, 'summary.json'), JSON.stringify(summary, null, 2));
  writeFileSync(
    path.join(opts.runDir, 'transcripts.json'),
    JSON.stringify(opts.transcripts, null, 2),
  );
  return reportPath;
}

// ==================== Main ====================

async function main() {
  const testedStr = process.env.EVAL_PERSONA_MODEL || process.env.DEFAULT_MODEL;
  const judgeStr = process.env.EVAL_JUDGE_MODEL;
  if (!testedStr || !judgeStr) {
    console.error(
      'Error: EVAL_PERSONA_MODEL (or DEFAULT_MODEL) and EVAL_JUDGE_MODEL must be set, from different vendors. Example: EVAL_PERSONA_MODEL=qwen:qwen-plus EVAL_JUDGE_MODEL=anthropic:claude-sonnet-4-5',
    );
    process.exit(1);
  }
  const vendors = compareVendors(testedStr, judgeStr);
  if (vendors.same && process.env.EVAL_ALLOW_SAME_VENDOR !== '1') {
    console.error(
      `Error: the judge (${judgeStr}) and the tested model (${testedStr}) are both ${vendors.testedVendor}. A judge grades its own vendor's style kindly; pick another vendor, or set EVAL_ALLOW_SAME_VENDOR=1 to run anyway.`,
    );
    process.exit(1);
  }

  const parts = parseParts(process.env.EVAL_PARTS);
  const samples = Math.max(1, Number(process.env.EVAL_SAMPLES || '2'));
  const concurrency = Math.max(1, Number(process.env.EVAL_CONCURRENCY || '3'));
  const timeoutMs = Math.max(1000, Number(process.env.EVAL_TIMEOUT_MS || '180000'));
  const tolerance = Number(process.env.EVAL_REGRESSION_TOLERANCE || '0.15');
  const rosterSource = process.env.EVAL_ROSTER_SOURCE === 'generated' ? 'generated' : 'fixed';
  const castingMode: PiCastingMode =
    process.env.EVAL_CASTING_MODE === 'legacy' ? 'legacy' : 'persona';
  const courseIds = new Set(parseList(process.env.EVAL_COURSE));
  const promptIds = new Set(parseList(process.env.EVAL_PROMPT));

  const file = loadFidelityFile(path.join(getCurrentDir(), 'scenarios/courses.json'));
  const problems = validateFidelityFile(file);
  if (problems.length > 0) {
    console.error(`scenarios/courses.json is not sound:\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  const courses = file.courses.filter((course) => courseIds.size === 0 || courseIds.has(course.id));
  const classroomOn = parts.has('speaker') || parts.has('boundary');

  console.log('=== Persona Fidelity Eval ===');
  console.log(
    `Tested: ${testedStr} (${vendors.testedVendor}) | Judge: ${judgeStr} (${vendors.judgeVendor}) | Parts: ${[...parts].join(', ')} | Samples: ${samples} | Courses: ${courses.length}`,
  );

  const tested = await resolveEvalModel('EVAL_PERSONA_MODEL', process.env.DEFAULT_MODEL);
  const judge = await resolveEvalModel('EVAL_JUDGE_MODEL');
  const runDir = createRunDir(OUTPUT_DIR, testedStr);
  const notes: string[] = [];
  if (vendors.same)
    notes.push(`The judge shares the tested model's vendor (${vendors.testedVendor}).`);

  // The judge's bias guard, before any persona score is used
  let judgeCalibration: CalibrationResult | undefined;
  if (parts.has('generation') || parts.has('speaker')) {
    const calibrationCourse = file.courses.find(
      (course) => course.id === file.calibration.courseId,
    )!;
    const verdict = await judgeRoster(
      judge.model,
      calibrationCourse,
      file.calibration.personas,
      'calibration',
    );
    const byKey: Partial<Record<CalibrationKey, PersonaVerdict>> = {};
    if (!verdict.error) {
      file.calibration.personas.forEach((persona, index) => {
        const rated = verdict.personas[index];
        if (rated) byKey[persona.key] = rated;
      });
    }
    judgeCalibration = verdict.error
      ? { passed: false, failures: [`unusable calibration verdict: ${verdict.error}`] }
      : checkCalibration(byKey);
    console.log(
      `Judge calibration: ${judgeCalibration.passed ? 'passed' : `FAILED (${judgeCalibration.failures.join('; ')})`}`,
    );
  }

  // Part 1: persona generation (also the source of generated classroom rosters)
  const generation: GenerationSummary[] = [];
  const generatedByCourse = new Map<string, GeneratedRoster[]>();
  const needGenerated = rosterSource === 'generated' && classroomOn;
  for (const course of courses) {
    if (!parts.has('generation') && !(needGenerated && course.classroom)) continue;
    process.stdout.write(`  - generating ${course.id} ... `);
    const rosters = await runBatched(samples, concurrency, () => generateRoster(course, tested));
    generatedByCourse.set(course.id, rosters);
    if (parts.has('generation')) {
      await runBatched(rosters.length, concurrency, async (index) => {
        const { agents, result } = rosters[index]!;
        if (agents) {
          result.verdict = await judgeRoster(judge.model, course, agents, `${course.id}#${index}`);
        }
      });
      generation.push(
        summarizeGeneration(
          course.id,
          rosters.map(({ result }) => result),
        ),
      );
    }
    console.log(
      rosters
        .map(({ result }) => (result.ok ? (result.check?.valid ? 'valid' : 'invalid') : 'error'))
        .join(', '),
    );
  }

  // Parts 2 and 3: the classroom
  const speaker: SpeakerSummary[] = [];
  const boundary: BoundarySummary[] = [];
  const transcripts: CourseTranscripts[] = [];
  const rosterVerdicts: Record<string, PersonaVerdict[]> = {};
  if (classroomOn) {
    for (const course of courses) {
      const classroom = course.classroom;
      if (!classroom) continue;
      const { roster, from } = pickClassroomRoster(
        course,
        rosterSource,
        generatedByCourse.get(course.id) ?? [],
      );
      if (from !== rosterSource) notes.push(`${course.id}: classroom played by the ${from} roster`);
      const runs = await playClassroom({
        course,
        roster,
        promptIds,
        samples,
        concurrency,
        timeoutMs,
        mode: castingMode,
        tested,
        notes,
      });
      transcripts.push({ courseId: course.id, rosterFrom: from, roster, runs });

      if (parts.has('speaker')) {
        // The roster's caricature is read next to the accuracy it buys
        const rosterVerdict = await judgeRoster(
          judge.model,
          course,
          roster,
          `${course.id}#classroom`,
        );
        if (!rosterVerdict.error) rosterVerdicts[course.id] = rosterVerdict.personas;
        speaker.push(
          await assessSpeakers({
            courseId: course.id,
            roster,
            runs,
            judgeModel: judge.model,
            concurrency,
            rosterCaricatureMean: meanCaricature(rosterVerdict),
          }),
        );
      }
      if (parts.has('boundary')) {
        boundary.push(
          await assessBoundary({
            courseId: course.id,
            classroom,
            runs,
            judgeModel: judge.model,
            concurrency,
          }),
        );
      }
    }
  }

  const summary: PersonaFidelitySummary = {
    testedModel: testedStr,
    judgeModel: judgeStr,
    testedVendor: vendors.testedVendor,
    judgeVendor: vendors.judgeVendor,
    sameVendor: vendors.same,
    createdAt: new Date().toISOString(),
    samples,
    castingMode,
    rosterSource,
    ...(judgeCalibration ? { judgeCalibration } : {}),
    generation,
    speaker,
    boundary,
  };
  const reportPath = writeReport({ runDir, summary, transcripts, rosterVerdicts, notes });
  console.log(`\nReport: ${reportPath}`);

  let failed = false;
  if (judgeCalibration && !judgeCalibration.passed) {
    if (process.env.EVAL_ALLOW_UNCALIBRATED_JUDGE === '1') {
      console.log('Judge failed calibration (allowed by EVAL_ALLOW_UNCALIBRATED_JUDGE=1).');
    } else {
      console.log('FAIL: the judge failed calibration; its persona scores cannot be trusted.');
      failed = true;
    }
  }
  const baselinePath = process.env.EVAL_BASELINE;
  if (baselinePath) {
    const baseline = JSON.parse(readFileSync(baselinePath, 'utf-8')) as PersonaFidelitySummary;
    const regressions = findFidelityRegressions(summary, baseline, tolerance);
    for (const regression of regressions) {
      console.log(
        `REGRESSION ${regression.key} (${regression.better} is better): ${regression.baseline} -> ${regression.current}`,
      );
    }
    console.log(`Regressions: ${regressions.length} (tolerance ${tolerance})`);
    if (regressions.length > 0) failed = true;
  } else {
    console.log('No EVAL_BASELINE: report only.');
  }
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
