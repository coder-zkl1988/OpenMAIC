import { readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { compile } from 'tailwindcss';
import { describe, expect, it } from 'vitest';
import { cn } from '@/lib/utils/cn';

/**
 * Contract for the design-token layer in app/globals.css.
 *
 * The redesign consumes role tokens (text-fg-secondary, border-line, bg-page,
 * bg-accent-soft …) and the Ant primary scale (bg-primary-1 … primary-10)
 * instead of raw gray/violet classes. This guards three things:
 *  - every role variable has both a light (:root) and a dark (.dark) value,
 *    and light values match the design Tokens board;
 *  - the utilities really compile, through the same Tailwind entry point
 *    (globals.css with its imports), to those values;
 *  - nothing collides with the existing shadcn names (text-primary is the
 *    purple --primary, text-secondary is the grey --secondary background).
 */

const ROOT = resolve(__dirname, '..', '..');
const GLOBALS_PATH = join(ROOT, 'app/globals.css');
const globalsCss = readFileSync(GLOBALS_PATH, 'utf-8');

/** Light values from the design Tokens board (Tokens.dc.html). */
const LIGHT_ROLE_VALUES: Record<string, string> = {
  fg: '#0a0a0a',
  'fg-secondary': '#404040',
  'fg-tertiary': '#666666',
  icon: '#525252',
  'icon-muted': '#737373',
  line: '#e5e5e5',
  'line-strong': '#d4d4d4',
  subtle: '#f5f5f5',
  page: '#f8fafc',
  'page-end': '#f1f5f9',
  'accent-soft': '#f9f0ff',
  'accent-line': '#d3adf7',
  'accent-text': '#722ed1',
  'accent-hover': '#531dab',
  interactive: '#0e7490',
  'interactive-soft': '#ecfeff',
  warning: '#b45309',
  'warning-soft': '#fef3c7',
  'warning-foreground': '#ffffff',
  danger: '#dc2626',
  'danger-soft': '#fef2f2',
  success: '#047857',
  'success-soft': '#ecfdf5',
};
const ROLES = Object.keys(LIGHT_ROLE_VALUES);

const PRIMARY_SCALE = [
  '#f9f0ff',
  '#efdbff',
  '#d3adf7',
  '#b37feb',
  '#9254de',
  '#722ed1',
  '#531dab',
  '#391085',
  '#22075e',
  '#120338',
];

/** Body of the first top-level rule whose header line is exactly `header {`. */
function topLevelBlock(css: string, header: string): string {
  const start = css.indexOf(`\n${header} {\n`);
  expect(start, `missing top-level "${header}" block`).toBeGreaterThanOrEqual(0);
  const open = css.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unterminated "${header}" block`);
}

function declarations(block: string): Map<string, string> {
  const decls = new Map<string, string>();
  for (const match of block.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
    decls.set(match[1], match[2].trim());
  }
  return decls;
}

const rootDecls = declarations(topLevelBlock(globalsCss, ':root'));
const darkDecls = declarations(topLevelBlock(globalsCss, '.dark'));
const themeInlineDecls = declarations(topLevelBlock(globalsCss, '@theme inline'));
const themeDecls = declarations(topLevelBlock(globalsCss, '@theme'));

/** Resolve the bare `@import`s of globals.css the way the `style` condition does. */
async function loadStylesheet(id: string, base: string) {
  let path: string;
  if (id.startsWith('.') || id.startsWith('/')) {
    path = resolve(base, id);
  } else {
    const [scope, name, ...rest] = id.split('/');
    const pkgName = scope.startsWith('@') ? `${scope}/${name}` : scope;
    const subpath = (scope.startsWith('@') ? rest : [name, ...rest]).filter(Boolean).join('/');
    const pkgDir = join(ROOT, 'node_modules', pkgName);
    const pkg = JSON.parse(readFileSync(join(pkgDir, 'package.json'), 'utf-8'));
    const entry = pkg.exports?.[subpath ? `./${subpath}` : '.'];
    const target = typeof entry === 'string' ? entry : (entry?.style ?? pkg.style);
    path = join(pkgDir, target);
  }
  return { path, base: dirname(path), content: readFileSync(path, 'utf-8') };
}

async function buildUtilities(candidates: string[]): Promise<string> {
  const compiler = await compile(globalsCss, {
    base: dirname(GLOBALS_PATH),
    loadStylesheet,
  });
  return compiler.build(candidates);
}

/** The declarations of one generated utility class, e.g. `.text-fg`. */
function utilityBody(css: string, className: string): string {
  const selector = `.${className.replace(/[/:]/g, (c) => `\\${c}`)} {`;
  const start = css.indexOf(selector);
  expect(start, `utility ${className} was not generated`).toBeGreaterThanOrEqual(0);
  return css.slice(start + selector.length, css.indexOf('}', start));
}

describe('design tokens in app/globals.css', () => {
  it('defines every role variable for light and dark', () => {
    for (const role of ROLES) {
      expect(rootDecls.get(`--${role}`), `:root --${role}`).toBe(LIGHT_ROLE_VALUES[role]);
      expect(darkDecls.get(`--${role}`), `.dark --${role}`).toBeTruthy();
    }
  });

  it('maps every role to a --color-* theme variable', () => {
    for (const role of ROLES) {
      expect(themeInlineDecls.get(`--color-${role}`)).toBe(`var(--${role})`);
    }
  });

  it('adds the static Ant primary scale', () => {
    PRIMARY_SCALE.forEach((hex, i) => {
      expect(themeDecls.get(`--color-primary-${i + 1}`)).toBe(hex);
    });
  });

  it('keeps the shadcn names untouched and adds no colliding text-* tokens', () => {
    expect(globalsCss).not.toMatch(/--color-text-primary\s*:/);
    expect(globalsCss).not.toMatch(/--color-text-secondary\s*:/);
    expect(rootDecls.get('--primary')).toBe('#722ed1');
    expect(themeInlineDecls.get('--color-primary')).toBe('var(--primary)');
    expect(themeInlineDecls.get('--color-secondary')).toBe('var(--secondary)');
    expect(rootDecls.get('--muted-foreground')).toBe('oklch(0.556 0 0)');
    expect(rootDecls.get('--background')).toBe('oklch(1 0 0)');
    expect(rootDecls.get('--border')).toBe('oklch(0.922 0 0)');
  });

  it('uses dark values that stay readable on a dark page', () => {
    expect(darkDecls.get('--fg-tertiary')).toBe('#a3a3a3');
    expect(darkDecls.get('--accent-text')).toBe('#b37feb');
    expect(darkDecls.get('--accent-hover')).toBe('#9254de');
    expect(darkDecls.get('--accent-soft')).toBe('rgba(146, 84, 222, 0.16)');
    expect(darkDecls.get('--line')).toBe(darkDecls.get('--border'));
    // Near-black on the dark primary was 3.57:1; white passes AA.
    expect(darkDecls.get('--primary-foreground')).toBe('#ffffff');
  });

  it('retunes --muted-foreground only inside [data-ui=v2], to the tertiary text', () => {
    const scoped = declarations(topLevelBlock(globalsCss, "[data-ui='v2']"));
    // fg-tertiary is #666 in light and the dark fg-tertiary in dark
    expect(scoped.get('--muted-foreground')).toBe('var(--fg-tertiary)');
    expect([...scoped.keys()]).toEqual(['--muted-foreground']);
    expect(rootDecls.get('--fg-tertiary')).toBe('#666666');
    // Never globally: :root and .dark keep the shadcn values
    expect(rootDecls.get('--muted-foreground')).toBe('oklch(0.556 0 0)');
    expect(darkDecls.get('--muted-foreground')).toBe('oklch(0.708 0 0)');
    // Both redesigned roots opt in
    for (const file of ['app/page.tsx', 'components/classroom/ClassroomSurface.tsx']) {
      expect(readFileSync(join(ROOT, file), 'utf-8'), file).toContain('data-ui="v2"');
    }
  });

  it('draws the desktop title bar from the page and icon tokens', () => {
    const titlebar = globalsCss.slice(
      globalsCss.indexOf('html[data-openmaic-desktop] .desktop-titlebar {'),
    );
    expect(titlebar).toMatch(/background: var\(--page\);/);
    expect(titlebar).toMatch(/color: var\(--icon-muted\);/);
    expect(globalsCss).toContain('--desktop-titlebar-height: 32px;');
    expect(globalsCss).toMatch(/@utility h-app \{\s*height: var\(--app-viewport-height\);/);
  });
});

describe('design token utilities', () => {
  it('compile and resolve to the Tokens board values in light mode', async () => {
    const css = await buildUtilities([
      'bg-primary-1',
      'ring-primary-3',
      'text-primary-7',
      'text-fg',
      'text-fg-secondary',
      'text-fg-tertiary',
      'text-icon',
      'text-icon-muted',
      'border-line',
      'border-line-strong',
      'bg-subtle',
      'bg-page',
      'bg-accent-soft',
      'border-accent-line',
      'text-accent-text',
      'text-warning',
      'bg-danger-soft',
      'text-interactive',
      'bg-success-soft',
      'to-page-end',
      'text-warning-foreground',
    ]);

    const roleUtilities: Array<[string, string, string]> = [
      ['text-fg', 'color', 'fg'],
      ['text-fg-secondary', 'color', 'fg-secondary'],
      ['text-fg-tertiary', 'color', 'fg-tertiary'],
      ['text-icon', 'color', 'icon'],
      ['text-icon-muted', 'color', 'icon-muted'],
      ['border-line', 'border-color', 'line'],
      ['border-line-strong', 'border-color', 'line-strong'],
      ['bg-subtle', 'background-color', 'subtle'],
      ['bg-page', 'background-color', 'page'],
      ['bg-accent-soft', 'background-color', 'accent-soft'],
      ['border-accent-line', 'border-color', 'accent-line'],
      ['text-accent-text', 'color', 'accent-text'],
      ['text-warning', 'color', 'warning'],
      ['bg-danger-soft', 'background-color', 'danger-soft'],
      ['text-interactive', 'color', 'interactive'],
      ['bg-success-soft', 'background-color', 'success-soft'],
      ['to-page-end', '--tw-gradient-to', 'page-end'],
      ['text-warning-foreground', 'color', 'warning-foreground'],
    ];
    for (const [utility, property, role] of roleUtilities) {
      expect(utilityBody(css, utility)).toContain(`${property}: var(--${role});`);
      expect(rootDecls.get(`--${role}`)).toBe(LIGHT_ROLE_VALUES[role]);
    }

    expect(utilityBody(css, 'bg-primary-1')).toContain('var(--color-primary-1)');
    expect(utilityBody(css, 'ring-primary-3')).toContain('var(--color-primary-3)');
    expect(utilityBody(css, 'text-primary-7')).toContain('var(--color-primary-7)');
    expect(css).toContain('--color-primary-1: #f9f0ff;');
    expect(css).toContain('--color-primary-3: #d3adf7;');
    expect(css).toContain('--color-primary-7: #531dab;');
  });

  it('leaves the existing primary utilities on the theme-aware --primary', async () => {
    const css = await buildUtilities([
      'bg-primary',
      'bg-primary/10',
      'text-primary',
      'text-secondary',
      'border-line',
      'border-primary',
    ]);
    expect(utilityBody(css, 'bg-primary')).toContain('background-color: var(--primary);');
    expect(utilityBody(css, 'text-primary')).toContain('color: var(--primary);');
    expect(utilityBody(css, 'text-secondary')).toContain('color: var(--secondary);');
    expect(css).toContain('color-mix(in oklab, var(--primary) 10%, transparent)');
    // The slide editor's BorderLine pairs a legacy `border-line` marker class
    // with border-primary; the primary colour must keep winning the cascade.
    expect(css.indexOf('.border-primary {')).toBeGreaterThan(css.indexOf('.border-line {'));
  });

  it('are kept by cn() next to size utilities', () => {
    expect(cn('text-sm', 'text-fg-secondary')).toBe('text-sm text-fg-secondary');
    expect(cn('border', 'border-line')).toBe('border border-line');
    expect(cn('text-fg', 'text-fg-tertiary')).toBe('text-fg-tertiary');
  });
});
