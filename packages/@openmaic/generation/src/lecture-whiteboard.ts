/**
 * The whiteboard in a generated slide lecture: the scripted actions that open
 * it, draw on it and close it again, made safe to play.
 *
 * Playback does not reset the whiteboard between pages: it stays open, with
 * whatever is on it, until an action closes it. So a page's script must hand
 * the board back the way it found it, and the model's script is normalized
 * here rather than trusted:
 *
 * - the page's first whiteboard segment starts on a clean board (`wb_clear`
 *   after `wb_open`; a no-op on an empty board), since the board may still hold
 *   another page's drawing or a live answer's sketch;
 * - a drawing while the board is closed opens it first;
 * - spotlight, laser, video and discussion point at the slide, which the open
 *   board covers: the board closes before them;
 * - the page ends with the board closed;
 * - a drawing without the fields it needs to render is dropped, and LaTeX
 *   whose backslashes JSON turned into control characters is repaired.
 */
import type { Action } from '@openmaic/dsl';
import { nanoid } from 'nanoid';

import { noopGenerationLogger, type GenerationLogger } from './logger.js';

/** Actions that point at (or play) something on the slide the open board covers. */
const SLIDE_FACING = new Set<Action['type']>(['spotlight', 'laser', 'play_video', 'discussion']);

/** Actions that need the board open (the engine would open it implicitly). */
const BOARD_ACTIONS = new Set<Action['type']>([
  'wb_draw_text',
  'wb_draw_shape',
  'wb_draw_chart',
  'wb_draw_latex',
  'wb_draw_table',
  'wb_draw_line',
  'wb_draw_code',
  'wb_clear',
  'wb_delete',
]);

/**
 * JSON escapes that collide with LaTeX commands (`\frac` → form feed + "rac"),
 * mapped back to the backslash and letter the model meant. A newline is only
 * taken back when a letter follows it (`\nu`, `\neq`); elsewhere it is a line
 * break.
 */
const LATEX_CONTROL_REPAIRS: Array<[string, string]> = [
  ['\t', '\\t'],
  ['\r', '\\r'],
  ['\f', '\\f'],
  ['\b', '\\b'],
  ['\v', '\\v'],
];

export function repairLatexControlChars(latex: string): string {
  const repaired = LATEX_CONTROL_REPAIRS.reduce(
    (text, [control, escape]) => text.replaceAll(control, escape),
    latex,
  );
  return repaired.replace(/\n(?=[a-zA-Z])/g, '\\n');
}

function isNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Whether a whiteboard action carries what it needs to render (or act). */
function isPlayable(action: Action): boolean {
  const fields = action as unknown as Record<string, unknown>;
  const at = isNumber(fields.x) && isNumber(fields.y);
  switch (action.type) {
    case 'wb_draw_text':
      return at && isNonEmptyString(fields.content);
    case 'wb_draw_latex':
      return at && isNonEmptyString(fields.latex);
    case 'wb_draw_shape':
      return at && isNumber(fields.width) && isNumber(fields.height);
    case 'wb_draw_line':
      return (
        isNumber(fields.startX) &&
        isNumber(fields.startY) &&
        isNumber(fields.endX) &&
        isNumber(fields.endY)
      );
    case 'wb_draw_chart': {
      const data = fields.data as { labels?: unknown; series?: unknown } | undefined;
      return (
        at &&
        isNumber(fields.width) &&
        isNumber(fields.height) &&
        Array.isArray(data?.labels) &&
        Array.isArray(data?.series) &&
        data.series.every((row) => Array.isArray(row))
      );
    }
    case 'wb_draw_table':
      return (
        at &&
        isNumber(fields.width) &&
        isNumber(fields.height) &&
        Array.isArray(fields.data) &&
        fields.data.length > 0 &&
        fields.data.every((row) => Array.isArray(row))
      );
    case 'wb_draw_code':
      return at && isNonEmptyString(fields.code);
    case 'wb_delete':
      return isNonEmptyString(fields.elementId);
    // Line ids exist only once the block is drawn: a script cannot name them.
    case 'wb_edit_code':
      return false;
    default:
      return true;
  }
}

function boardAction(type: 'wb_open' | 'wb_clear' | 'wb_close'): Action {
  return { id: `action_${nanoid(8)}`, type } as Action;
}

/** Normalize the whiteboard actions of one slide page's script (see the module comment). */
export function normalizeLectureWhiteboard(
  actions: readonly Action[],
  logger: GenerationLogger = noopGenerationLogger,
): Action[] {
  const result: Action[] = [];
  let open = false;
  let opened = false;
  let dropped = 0;
  let inserted = 0;

  const openBoard = (explicit?: Action) => {
    result.push(explicit ?? boardAction('wb_open'));
    if (!explicit) inserted++;
    open = true;
  };

  for (let i = 0; i < actions.length; i++) {
    const action = actions[i]!;

    if (action.type.startsWith('wb_') && !isPlayable(action)) {
      dropped++;
      continue;
    }

    if (action.type === 'wb_open') {
      if (open) {
        dropped++;
        continue;
      }
      openBoard(action);
      // The page's first segment starts on a clean board.
      if (!opened && actions[i + 1]?.type !== 'wb_clear') {
        result.push(boardAction('wb_clear'));
        inserted++;
      }
      opened = true;
      continue;
    }

    if (action.type === 'wb_close') {
      if (!open) {
        dropped++;
        continue;
      }
      result.push(action);
      open = false;
      continue;
    }

    if (BOARD_ACTIONS.has(action.type) && !open) {
      openBoard();
      if (!opened && action.type !== 'wb_clear') {
        result.push(boardAction('wb_clear'));
        inserted++;
      }
      opened = true;
    }

    if (SLIDE_FACING.has(action.type) && open) {
      result.push(boardAction('wb_close'));
      inserted++;
      open = false;
    }

    if (action.type === 'wb_draw_latex') {
      const latex = (action as { latex: string }).latex;
      const repaired = repairLatexControlChars(latex);
      result.push(repaired === latex ? action : ({ ...action, latex: repaired } as Action));
      continue;
    }

    result.push(action);
  }

  if (open) {
    result.push(boardAction('wb_close'));
    inserted++;
  }

  if (dropped > 0 || inserted > 0) {
    logger.info(
      `Whiteboard script normalized: dropped ${dropped}, inserted ${inserted} board action(s)`,
    );
  }
  return result;
}
