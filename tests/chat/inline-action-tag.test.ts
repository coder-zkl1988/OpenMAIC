import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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
import {
  ACTION_CONFIG,
  InlineActionTag,
  getActionTagLabelKey,
  isWhiteboardAction,
} from '@/components/chat/inline-action-tag';

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

function lookup(resource: unknown, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined,
      resource,
    );
}

let resource: unknown = zhCN;
vi.mock('@/lib/hooks/use-i18n', () => ({
  useI18n: () => ({
    t: (key: string) => {
      const value = lookup(resource, key);
      return typeof value === 'string' ? value : key;
    },
  }),
}));

const render = (actionName: string, state = 'result') =>
  renderToStaticMarkup(createElement(InlineActionTag, { actionName, state }));

describe('InlineActionTag labels', () => {
  beforeEach(() => {
    resource = zhCN;
  });

  it.each(Object.keys(ACTION_CONFIG))('%s has a label in every locale', (actionName) => {
    const key = getActionTagLabelKey(actionName);
    for (const [locale, messages] of Object.entries(LOCALES)) {
      const value = lookup(messages, key);
      expect(typeof value === 'string' && value.length > 0, `${locale}: ${key}`).toBe(true);
    }
  });

  it('labels the whiteboard chips 板书 · … in zh-CN', () => {
    expect(render('wb_draw_latex')).toContain('板书 · 公式');
    expect(render('wb_draw_text')).toContain('板书 · 文字');
    expect(render('wb_draw_shape')).toContain('板书 · 图形');
    expect(render('wb_draw_chart')).toContain('板书 · 图表');
    expect(render('wb_draw_table')).toContain('板书 · 表格');
    expect(render('wb_draw_code')).toContain('板书 · 代码');
  });

  it('uses English labels in en-US', () => {
    resource = enUS;
    expect(render('wb_draw_latex')).toContain('Whiteboard · Formula');
    expect(render('spotlight')).toContain('Spotlight');
  });

  it('falls back to the raw name for an unknown action', () => {
    expect(render('mystery_action')).toContain('mystery_action');
  });
});

describe('InlineActionTag chips', () => {
  it('draws whiteboard chips at 22px, 11px/600 on the accent', () => {
    const html = render('wb_draw_table');
    expect(html).toContain('h-[22px]');
    expect(html).toContain('text-[11px] font-semibold');
    expect(html).toContain('bg-accent-soft');
    expect(html).toContain('text-primary-7');
    expect(html).toContain('data-state="done"');
  });

  it('outlines the running chip and spins', () => {
    const html = render('wb_draw_code', 'running');
    expect(html).toContain('border border-accent-line bg-background');
    expect(html).toContain('animate-spin');
    expect(html).toContain('data-state="running"');
  });

  it('tells whiteboard actions from inline ones', () => {
    expect(isWhiteboardAction('wb_draw_latex')).toBe(true);
    expect(isWhiteboardAction('wb_open')).toBe(true);
    expect(isWhiteboardAction('spotlight')).toBe(false);
    expect(isWhiteboardAction('discussion')).toBe(false);
  });
});
