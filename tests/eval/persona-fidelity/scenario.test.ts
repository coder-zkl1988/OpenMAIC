/**
 * The persona fidelity eval's course file (I26), without a model: it is
 * sound, every classroom has 3+ people and prompts of every kind, prompts
 * name people by role so any roster can play them, and the taught/upcoming
 * split matches what the Pi server considers narrated.
 */
import path from 'path';
import { describe, expect, it } from 'vitest';
import { buildScenarioRequest } from '@/eval/pi-casting/scenario';
import {
  buildClassroomScenario,
  currentNarration,
  fillNames,
  loadFidelityFile,
  missingRefs,
  resolveAgentRef,
  rosterRefs,
  splitPages,
  taughtText,
  validateFidelityFile,
  type FidelityAgent,
  type FidelityCourse,
  type FidelityFile,
} from '@/eval/persona-fidelity/scenario';

const file = loadFidelityFile(
  path.join(process.cwd(), 'eval/persona-fidelity/scenarios/courses.json'),
);
const waves = file.courses.find(({ id }) => id === 'waves-zh')!;

describe('courses.json', () => {
  it('is sound', () => {
    expect(validateFidelityFile(file)).toEqual([]);
  });

  it('has the calibration set, generation-only courses and two classrooms', () => {
    expect(file.calibration.personas.map(({ key }) => key).sort()).toEqual([
      'caricature',
      'plain',
      'script',
    ]);
    const classrooms = file.courses.filter((course) => course.classroom);
    expect(classrooms.map(({ id }) => id)).toEqual(['waves-zh', 'python-en']);
    expect(file.courses.length).toBeGreaterThan(classrooms.length);
    for (const course of classrooms) {
      const roles = course.classroom!.roster.map(({ role }) => role);
      expect(roles.length).toBeGreaterThanOrEqual(3);
      expect(new Set(roles)).toEqual(new Set(['teacher', 'assistant', 'student']));
      const promptIds = course.classroom!.prompts.map(({ id }) => id);
      expect(promptIds).toEqual(expect.arrayContaining(['ask-student', 'whole-class', 'ahead']));
      expect(course.classroom!.upcomingTerms.length).toBeGreaterThan(0);
    }
    // Both scripts the language check knows are exercised, and private details are listed
    expect(new Set(file.courses.map(({ expectScript }) => expectScript))).toEqual(
      new Set(['han', 'latin']),
    );
    for (const course of file.courses) expect(course.privateTerms?.length).toBeGreaterThan(0);
  });
});

describe('roster placeholders', () => {
  const roster = waves.classroom!.roster;
  const refs = rosterRefs(roster);

  it('names the teacher, the first assistant and the students in order', () => {
    expect(Object.fromEntries(Object.entries(refs).map(([ref, agent]) => [ref, agent.id]))).toEqual(
      { teacher: 't1', assistant: 'ta1', student1: 's1', student2: 's2' },
    );
    expect(fillNames('{student1}，你觉得呢？{teacher}说过', refs)).toBe(
      '小思，你觉得呢？林老师说过',
    );
    expect(missingRefs('{student3} and {assistant}', refs)).toEqual(['student3']);
    expect(resolveAgentRef('{student2}', refs, roster)).toBe('s2');
    expect(resolveAgentRef('t1', refs, roster)).toBe('t1');
    expect(resolveAgentRef('ghost', refs, roster)).toBeUndefined();
  });
});

describe('buildClassroomScenario', () => {
  const prompt = (id: string) => waves.classroom!.prompts.find((candidate) => candidate.id === id)!;

  it('fills names and ids for whichever roster plays the class', () => {
    const generated: FidelityAgent[] = [
      { id: 'g1', name: '周老师', role: 'teacher', persona: 'p' },
      { id: 'g2', name: '大卫', role: 'student', persona: 'p' },
      { id: 'g3', name: '安安', role: 'assistant', persona: 'p' },
    ];
    const built = buildClassroomScenario(waves, prompt('ask-student'), generated);
    if ('skip' in built) throw new Error(built.skip);
    expect(built.learnerText).toBe('大卫，你觉得为什么有的地方会抵消？');
    expect(built.scenario.config?.addressedAgentIds).toEqual(['g2']);
    const body = buildScenarioRequest(built.file, built.scenario);
    expect(body.config.agentIds).toEqual(['g1', 'g2', 'g3']);
    expect(body.storeState.currentSceneId).toBe('p7');
    expect(body.storeState.lectureProgress).toEqual({ sceneId: 'p7', actionIndex: 1 });
  });

  it('resolves an earlier teacher message and a discussion opener', () => {
    const followUp = buildClassroomScenario(
      waves,
      prompt('confused-follow-up'),
      waves.classroom!.roster,
    );
    if ('skip' in followUp) throw new Error(followUp.skip);
    expect(followUp.scenario.messages[1]).toMatchObject({ role: 'assistant', agentId: 't1' });

    const moment = buildClassroomScenario(
      waves,
      prompt('student-opens-moment'),
      waves.classroom!.roster,
    );
    if ('skip' in moment) throw new Error(moment.skip);
    expect(moment.learnerText).toBe('');
    expect(moment.scenario.config).toMatchObject({
      sessionType: 'discussion',
      triggerAgentId: 's2',
    });
  });

  it('skips a prompt that names someone the roster lacks', () => {
    const twoPeople: FidelityAgent[] = [
      { id: 't', name: 'T', role: 'teacher', persona: 'p' },
      { id: 's', name: 'S', role: 'student', persona: 'p' },
    ];
    expect(buildClassroomScenario(waves, prompt('student-opens-moment'), twoPeople)).toEqual({
      skip: 'the roster has nobody for {student2}',
    });
  });
});

describe('what has been taught', () => {
  const classroom = waves.classroom!;

  it('splits the pages at the current one', () => {
    const { taught, upcoming } = splitPages(classroom);
    expect(taught.map(({ id }) => id)).toEqual(['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7']);
    expect(upcoming.map(({ id }) => id)).toEqual(['p8', 'p9', 'p10', 'p11', 'p12']);
  });

  it('counts the current page’s narration only up to the lecture position', () => {
    expect(currentNarration(classroom)).toHaveLength(2);
    expect(
      currentNarration({ ...classroom, lectureProgress: { pageId: 'p7', actionIndex: 0 } }),
    ).toHaveLength(1);
    expect(currentNarration({ ...classroom, lectureProgress: undefined })).toEqual([]);
    const text = taughtText({ ...classroom, lectureProgress: undefined });
    expect(text).toContain('分开以后，两列波还是原来的样子');
    expect(text).not.toContain('有的地方振动始终加强');
    expect(text).not.toContain('驻波');
  });
});

describe('validateFidelityFile', () => {
  const sound = (): FidelityFile => JSON.parse(JSON.stringify(file)) as FidelityFile;
  const course = (data: FidelityFile) => data.courses.find(({ id }) => id === 'waves-zh')!;

  it('flags an upcoming term the class has already heard', () => {
    const data = sound();
    course(data).classroom!.upcomingTerms.push('相位差');
    expect(validateFidelityFile(data)).toEqual([
      'course waves-zh: upcoming term "相位差" is already in the taught pages',
    ]);
  });

  it('flags a thin classroom, a broken prompt and a missing calibration persona', () => {
    const data = sound();
    const classroom = course(data).classroom!;
    classroom.roster = classroom.roster.filter(({ role }) => role !== 'assistant').slice(0, 2);
    classroom.prompts.push({
      id: 'dangling',
      messages: [{ role: 'assistant', agentId: '{teacher}', text: 'hi' }],
    });
    data.calibration.personas = data.calibration.personas.filter(({ key }) => key !== 'script');
    const problems = validateFidelityFile(data);
    expect(problems).toEqual(
      expect.arrayContaining([
        'calibration: no "script" persona',
        'course waves-zh: a classroom needs at least 3 people',
        "course waves-zh: prompt dangling must end with the learner's message",
        'course waves-zh: prompt student-opens-moment: the roster has nobody for {student2}',
      ]),
    );
  });

  it('flags a private term that is not in the learner description', () => {
    const data = sound();
    const extra: FidelityCourse = { ...course(data), id: 'extra', classroom: undefined };
    extra.privateTerms = ['北京'];
    data.courses.push(extra);
    expect(validateFidelityFile(data)).toEqual([
      'course extra: private term "北京" is not in learnerLevel',
    ]);
  });
});
