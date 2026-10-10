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
import { CAPTION_STATUS_LABEL_KEYS } from '@/components/classroom/caption-strip';

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
  'components/classroom/control-bar.tsx',
  'components/classroom/caption-strip.tsx',
  'components/edit/PlaybackChromeRoot.tsx',
  'components/chat/chat-area.tsx',
  'components/chat/conversation-stream.tsx',
  'components/chat/chat-session.tsx',
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

  it('resolves every caption status label in every locale', () => {
    const keys = Object.values(CAPTION_STATUS_LABEL_KEYS).filter((key): key is string => !!key);
    for (const [locale, resource] of Object.entries(LOCALES)) {
      const missing = keys.filter((key) => typeof resolve(resource, key) !== 'string');
      expect(missing, locale).toEqual([]);
    }
  });

  it('ships the design copy for the control bar and caption (zh-CN default)', () => {
    expect(resolve(zhCN, 'stage.pageCounter')).toBe('第 {{current}} / {{total}} 页');
    expect(resolve(zhCN, 'stage.whiteboardToggle')).toBe('白板');
    expect(resolve(zhCN, 'stage.caption.lecturing')).toBe('讲解中');
    expect(resolve(zhCN, 'stage.caption.paused')).toBe('已暂停，等你发言');
    expect(resolve(zhCN, 'roundtable.stopQA')).toBe('结束问答');
    // e2e resolves these controls by their English names
    expect(resolve(enUS, 'stage.previousScene')).toBe('Previous scene');
    expect(resolve(enUS, 'stage.nextScene')).toBe('Next scene');
    expect(resolve(enUS, 'stage.play')).toBe('Play');
    expect(resolve(enUS, 'stage.playbackSpeed')).toBe('Playback speed');
    expect(resolve(enUS, 'stage.mute')).toBe('Mute');
    expect(resolve(enUS, 'roundtable.autoPlay')).toBe('Auto-play');
  });
});
