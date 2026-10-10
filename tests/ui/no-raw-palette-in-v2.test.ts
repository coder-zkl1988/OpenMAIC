import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative, resolve } from 'path';
import { describe, expect, it } from 'vitest';

/**
 * Guard for the redesigned (data-ui="v2") surfaces: they draw from the role
 * tokens in app/globals.css (text-fg-*, text-icon*, border-line*, bg-subtle,
 * bg-page, accent-* and the semantic pairs) and the static primary-1…10
 * scale, never from raw Tailwind greys / violets or muted-foreground opacity
 * steps, which bypass dark mode and the design's contrast steps.
 *
 * The allow-list is explicit on purpose. Most of the app (charts, slide
 * illustrations, the Pro editor, quiz / PBL internals) still uses the raw
 * palette and is out of scope; add a redesigned file here when it is migrated,
 * rather than widening the scan.
 */

const ROOT = resolve(__dirname, '..', '..');

/** Redesigned files and directories (directories are scanned recursively). */
const REDESIGNED_PATHS = [
  // Home
  'app/page.tsx',
  'components/discovery',
  // Classroom shell
  'components/classroom',
  'components/header.tsx',
  'components/stage/header-controls.tsx',
  'components/stage/scene-sidebar.tsx',
  // Interaction panel
  'components/chat/chat-area.tsx',
  'components/chat/chat-session.tsx',
  'components/chat/conversation-stream.tsx',
  'components/chat/inline-action-tag.tsx',
  'components/chat/proactive-card.tsx',
  // Whiteboard
  'components/whiteboard',
] as const;

const RAW_PALETTE = /\b(?:violet|purple|indigo|gray|slate|zinc)-\d+/g;
const MUTED_OPACITY_STEP = /\btext-muted-foreground\/(?:\d+|\[)/g;

function sourceFiles(path: string): string[] {
  const abs = join(ROOT, path);
  if (!statSync(abs).isDirectory()) return [abs];
  return readdirSync(abs, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    if (entry.isDirectory()) return sourceFiles(child);
    return /\.(tsx?|css)$/.test(entry.name) ? [join(ROOT, child)] : [];
  });
}

function violations(file: string): string[] {
  const found: string[] = [];
  readFileSync(file, 'utf-8')
    .split('\n')
    .forEach((line, i) => {
      for (const pattern of [RAW_PALETTE, MUTED_OPACITY_STEP]) {
        for (const match of line.matchAll(pattern)) {
          found.push(`${relative(ROOT, file)}:${i + 1}  ${match[0]}`);
        }
      }
    });
  return found;
}

describe('redesigned surfaces use design tokens, not the raw palette', () => {
  it('lists only paths that exist', () => {
    for (const path of REDESIGNED_PATHS) {
      expect(() => statSync(join(ROOT, path)), path).not.toThrow();
    }
  });

  it.each(REDESIGNED_PATHS)('%s has no raw grey/violet classes or muted opacity steps', (path) => {
    const files = sourceFiles(path);
    expect(files.length).toBeGreaterThan(0);
    expect(files.flatMap(violations)).toEqual([]);
  });

  it('catches the patterns it is meant to reject', () => {
    const sample = [
      'bg-violet-500/80',
      'dark:bg-slate-900',
      'text-gray-400',
      'ring-indigo-50',
      'hover:bg-zinc-100',
      'border-purple-300',
      'text-muted-foreground/60',
      'placeholder:text-muted-foreground/40',
    ].join(' ');
    const hits = [...sample.matchAll(RAW_PALETTE), ...sample.matchAll(MUTED_OPACITY_STEP)];
    expect(hits).toHaveLength(8);
    // Tokens and the primary scale pass
    const allowed = 'text-fg-tertiary bg-primary-1 text-muted-foreground bg-accent-soft';
    expect([...allowed.matchAll(RAW_PALETTE), ...allowed.matchAll(MUTED_OPACITY_STEP)]).toEqual([]);
  });
});
