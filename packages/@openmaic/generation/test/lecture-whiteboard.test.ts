import { describe, expect, test } from 'vitest';
import type { Action } from '@openmaic/dsl';

import {
  normalizeLectureWhiteboard,
  parseActionsFromStructuredOutput,
  repairLatexControlChars,
} from '@openmaic/generation';

const speech = (text: string) => ({ id: `s-${text}`, type: 'speech', text }) as Action;
const spotlight = (elementId: string) =>
  ({ id: `sp-${elementId}`, type: 'spotlight', elementId }) as Action;
const latex = (value: string, id = 'f') =>
  ({ id, type: 'wb_draw_latex', latex: value, x: 60, y: 40, height: 80 }) as Action;
const board = (type: 'wb_open' | 'wb_clear' | 'wb_close', id: string = type) =>
  ({ id, type }) as Action;

const types = (actions: Action[]) => actions.map((action) => action.type);

describe('a slide page whiteboard script', () => {
  test('starts the first segment on a clean board and ends with the board closed', () => {
    const result = normalizeLectureWhiteboard([
      speech('intro'),
      board('wb_open'),
      latex('E=mc^2'),
      speech('explain'),
    ]);
    expect(types(result)).toEqual([
      'speech',
      'wb_open',
      'wb_clear',
      'wb_draw_latex',
      'speech',
      'wb_close',
    ]);
  });

  test('keeps a well-formed script as it is', () => {
    const script = [
      spotlight('title'),
      speech('intro'),
      board('wb_open'),
      board('wb_clear'),
      latex('a+b'),
      speech('explain'),
      board('wb_close'),
      speech('back to the slide'),
    ];
    expect(normalizeLectureWhiteboard(script)).toEqual(script);
  });

  test('opens the board for a drawing made while it is closed', () => {
    const result = normalizeLectureWhiteboard([speech('intro'), latex('x^2'), speech('explain')]);
    expect(types(result)).toEqual([
      'speech',
      'wb_open',
      'wb_clear',
      'wb_draw_latex',
      'speech',
      'wb_close',
    ]);
  });

  test('closes the board before pointing at the slide again', () => {
    const result = normalizeLectureWhiteboard([
      board('wb_open'),
      board('wb_clear'),
      latex('x'),
      speech('on the board'),
      spotlight('chart'),
      speech('on the slide'),
    ]);
    expect(types(result)).toEqual([
      'wb_open',
      'wb_clear',
      'wb_draw_latex',
      'speech',
      'wb_close',
      'spotlight',
      'speech',
    ]);
  });

  test('closes the board before a closing discussion, which stays last', () => {
    const result = normalizeLectureWhiteboard([
      board('wb_open'),
      latex('x'),
      speech('wrap up'),
      { id: 'd', type: 'discussion', topic: 'Why?' } as Action,
    ]);
    expect(types(result).slice(-2)).toEqual(['wb_close', 'discussion']);
  });

  test('cleans only the first segment; a later one keeps what the script does', () => {
    const result = normalizeLectureWhiteboard([
      board('wb_open', 'o1'),
      latex('a', 'f1'),
      board('wb_close', 'c1'),
      speech('slide'),
      board('wb_open', 'o2'),
      latex('b', 'f2'),
    ]);
    expect(types(result)).toEqual([
      'wb_open',
      'wb_clear',
      'wb_draw_latex',
      'wb_close',
      'speech',
      'wb_open',
      'wb_draw_latex',
      'wb_close',
    ]);
  });

  test('drops redundant opens and closes, and drawings that cannot render', () => {
    const result = normalizeLectureWhiteboard([
      board('wb_close', 'stray-close'),
      board('wb_open', 'o1'),
      board('wb_open', 'o2'),
      { id: 'no-latex', type: 'wb_draw_latex', x: 1, y: 2 } as unknown as Action,
      { id: 'no-pos', type: 'wb_draw_text', content: 'hi' } as unknown as Action,
      {
        id: 'bad-chart',
        type: 'wb_draw_chart',
        x: 0,
        y: 0,
        width: 10,
        height: 10,
      } as unknown as Action,
      { id: 'edit', type: 'wb_edit_code', elementId: 'c', operation: 'insert_after' } as Action,
      latex('ok', 'kept'),
    ]);
    expect(result.map((action) => action.id).filter((id) => !id.startsWith('action_'))).toEqual([
      'o1',
      'kept',
    ]);
    expect(types(result)).toEqual(['wb_open', 'wb_clear', 'wb_draw_latex', 'wb_close']);
  });

  test('repairs LaTeX whose backslashes JSON read as control characters', () => {
    // What the model meant: \frac{\theta}{\beta} \times \rightarrow \nu
    const broken = JSON.parse('"\\frac{\\theta}{\\beta} \\times \\rightarrow \\nu"') as string;
    expect(broken).not.toContain('\\frac');
    expect(repairLatexControlChars(broken)).toBe(
      '\\frac{\\theta}{\\beta} \\times \\rightarrow \\nu',
    );
    // Correctly escaped LaTeX is left alone.
    expect(repairLatexControlChars('\\frac{a}{b} \\\\ c')).toBe('\\frac{a}{b} \\\\ c');

    const [, , drawn] = normalizeLectureWhiteboard([
      board('wb_open'),
      board('wb_clear'),
      latex(broken),
    ]);
    expect((drawn as { latex: string }).latex).toBe(
      '\\frac{\\theta}{\\beta} \\times \\rightarrow \\nu',
    );
  });

  test('works on the parsed model output', () => {
    const response = JSON.stringify([
      { type: 'text', content: 'Let us derive it.' },
      { type: 'action', name: 'wb_open', params: {} },
      {
        type: 'action',
        name: 'wb_draw_chart',
        params: {
          chartType: 'line',
          x: 60,
          y: 40,
          width: 600,
          height: 260,
          data: { labels: ['0', '1', '2'], legends: ['sin'], series: [[0, 1, 0]] },
        },
      },
      { type: 'text', content: 'A sine wave.' },
    ]);
    const result = normalizeLectureWhiteboard(parseActionsFromStructuredOutput(response, 'slide'));
    expect(types(result)).toEqual([
      'speech',
      'wb_open',
      'wb_clear',
      'wb_draw_chart',
      'speech',
      'wb_close',
    ]);
  });
});
