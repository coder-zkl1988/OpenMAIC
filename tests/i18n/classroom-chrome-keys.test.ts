import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import arSA from '@/lib/i18n/locales/ar-SA.json';
import deDE from '@/lib/i18n/locales/de-DE.json';
import enUS from '@/lib/i18n/locales/en-US.json';
import esMX from '@/lib/i18n/locales/es-MX.json';
import frFR from '@/lib/i18n/locales/fr-FR.json';
import jaJP from '@/lib/i18n/locales/ja-JP.json';
import koKR from '@/lib/i18n/locales/ko-KR.json';
import ptBR from '@/lib/i18n/locales/pt-BR.json';
import ruRU from '@/lib/i18n/locales/ru-RU.json';
import viVN from '@/lib/i18n/locales/vi-VN.json';
import zhCN from '@/lib/i18n/locales/zh-CN.json';
import zhTW from '@/lib/i18n/locales/zh-TW.json';

/**
 * Guard for the classroom chrome copy. The workbench-pane branch of
 * HeaderControls once rendered `t('stage.proMode')`, a key that exists in no
 * locale, so users saw the raw key next to the Pro switch. Every static
 * `t('...')` key in the classroom chrome must resolve in all 12 locales.
 */
const CHROME_FILES = [
  'components/header.tsx',
  'components/stage/header-controls.tsx',
  'components/stage/scene-sidebar.tsx',
  'components/edit/EditShell/CommandBar.tsx',
] as const;

const LOCALES: Record<string, unknown> = {
  'ar-SA': arSA,
  'de-DE': deDE,
  'en-US': enUS,
  'es-MX': esMX,
  'fr-FR': frFR,
  'ja-JP': jaJP,
  'ko-KR': koKR,
  'pt-BR': ptBR,
  'ru-RU': ruRU,
  'vi-VN': viVN,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
};

const source = (path: string) => readFileSync(join(process.cwd(), path), 'utf8');

function resolve(resource: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      resource,
    );
}

function staticKeys(text: string): string[] {
  return [...text.matchAll(/\bt\(\s*'([a-zA-Z0-9_.]+)'/g)].map((match) => match[1]);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('classroom chrome i18n keys', () => {
  it.each(CHROME_FILES)('%s only uses keys present in every locale', (file) => {
    const keys = staticKeys(source(file));
    expect(keys.length).toBeGreaterThan(0);
    for (const [locale, resource] of Object.entries(LOCALES)) {
      const missing = keys.filter((key) => {
        const value = resolve(resource, key);
        return typeof value !== 'string' || value.length === 0;
      });
      expect(missing, `${file} in ${locale}`).toEqual([]);
    }
  });

  it('no longer references the missing stage.proMode key (edit.proMode is the label)', () => {
    const offenders = ['app', 'components', 'lib']
      .flatMap((dir) => sourceFiles(join(process.cwd(), dir)))
      .filter((path) => /['"`]stage\.proMode['"`]/.test(readFileSync(path, 'utf8')));
    expect(offenders).toEqual([]);
    expect(source('components/stage/header-controls.tsx')).toContain("t('edit.proMode')");
  });
});
