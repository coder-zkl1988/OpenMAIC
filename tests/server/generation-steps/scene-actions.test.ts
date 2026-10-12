import { beforeEach, describe, expect, it, vi } from 'vitest';

import { generateSceneActions } from '@/lib/server/generation/steps/scene-actions';
import type { SceneOutline } from '@/lib/types/generation';

import { fakeModel, testLogger } from './helpers';

const mocks = vi.hoisted(() => ({
  callLLM: vi.fn(),
  generateSceneActions: vi.fn(),
}));

vi.mock('@/lib/ai/llm', () => ({ callLLM: mocks.callLLM }));
vi.mock('@openmaic/generation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@openmaic/generation')>()),
  generateSceneActions: mocks.generateSceneActions,
}));

const model = fakeModel();

const outline = (id: string, order: number, title: string): SceneOutline => ({
  id,
  order,
  type: 'slide',
  title,
  description: title,
  keyPoints: [],
});

const body = {
  outline: outline('o2', 2, 'Second'),
  allOutlines: [outline('o1', 1, 'First'), outline('o2', 2, 'Second'), outline('o3', 3, 'Third')],
  content: { elements: [] },
  stageId: 'stage-1',
  previousSpeeches: ['Welcome back.'],
  userProfile: 'A curious learner',
  languageDirective: 'Teach in English.',
};

describe('scene actions step', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.callLLM.mockReset();
    mocks.generateSceneActions.mockReset();
    mocks.generateSceneActions.mockResolvedValue([
      { id: 'a1', type: 'speech', text: 'Now the second part.' },
      { id: 'a2', type: 'speech', text: 'Let us look closer.' },
    ]);
  });

  it("generates in the scene's place in the course and hands its speeches on", async () => {
    const result = await generateSceneActions({ ...body, model }, { log: testLogger() });

    const [, , , options] = mocks.generateSceneActions.mock.calls[0]!;
    expect(options).toEqual({
      ctx: {
        pageIndex: 2,
        totalPages: 3,
        allTitles: ['First', 'Second', 'Third'],
        allKeyPoints: [[], [], []],
        allKinds: ['slide', 'slide', 'slide'],
        previousSpeeches: ['Welcome back.'],
      },
      agents: undefined,
      userProfile: 'A curious learner',
      languageDirective: 'Teach in English.',
    });
    expect(result.scene).toMatchObject({ stageId: 'stage-1', type: 'slide', title: 'Second' });
    expect(result.previousSpeeches).toEqual(['Now the second part.', 'Let us look closer.']);
  });

  it('asks the page to settle the moment that ended the page before, by the teacher note', async () => {
    const actual =
      await vi.importActual<typeof import('@openmaic/generation')>('@openmaic/generation');
    mocks.generateSceneActions.mockImplementation(actual.generateSceneActions);
    mocks.callLLM.mockResolvedValue({
      text: JSON.stringify([{ type: 'text', content: 'Someone asked whether it repeats.' }]),
    });
    const moments = [
      {
        page: 1,
        agentName: 'Kai',
        agentRole: 'student',
        topic: 'Does it repeat forever?',
        prompt: 'Wrong idea: every pattern repeats. Only periodic signals do.',
      },
    ];

    await generateSceneActions({ ...body, model, previousMoments: moments }, { log: testLogger() });

    const { system, prompt } = mocks.callLLM.mock.calls[0]![0] as {
      system: string;
      prompt: string;
    };
    expect(prompt).toContain(
      '  - page 1 (it ended the page just before this one): Kai (student) — "Does it repeat forever?"',
    );
    expect(prompt).toContain(
      "    teacher's note: Wrong idea: every pattern repeats. Only periodic signals do.",
    );
    expect(system).toContain('**Following up a class moment**');
  });

  it('shows the page what the pages before it taught, for the class to recall', async () => {
    const actual =
      await vi.importActual<typeof import('@openmaic/generation')>('@openmaic/generation');
    mocks.generateSceneActions.mockImplementation(actual.generateSceneActions);
    mocks.callLLM.mockResolvedValue({
      text: JSON.stringify([{ type: 'text', content: 'Remember what a period is?' }]),
    });
    const first = { ...outline('o1', 1, 'First'), keyPoints: ['A period is one full cycle'] };
    const third = { ...outline('o3', 3, 'Third'), keyPoints: ['Not yet taught'] };

    await generateSceneActions(
      { ...body, allOutlines: [first, body.outline, third], model },
      { log: testLogger() },
    );

    const { system, prompt } = mocks.callLLM.mock.calls[0]![0] as {
      system: string;
      prompt: string;
    };
    expect(prompt).toContain(
      'Taught on earlier pages (key points):\n  - page 1: A period is one full cycle',
    );
    expect(prompt).not.toContain('Not yet taught');
    expect(system).toContain('**Building on an earlier page**');
  });

  it('passes the class moments of the pages before into the page context', async () => {
    const moments = [{ page: 1, agentName: 'Kai', topic: 'Why does it repeat?' }];
    await generateSceneActions({ ...body, model, previousMoments: moments }, { log: testLogger() });
    const [, , , options] = mocks.generateSceneActions.mock.calls[0]!;
    expect(options).toMatchObject({ ctx: { pageIndex: 2, previousMoments: moments } });
  });
});
