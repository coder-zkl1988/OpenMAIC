/**
 * Built-in agents (`default-1..6`) under the names the learner sees in the
 * interface: the registry keeps one stock name per agent, while the UI shows
 * `settings.agentNames.<id>` of the learner's locale. Prompts and @-mentions
 * must use the name on screen, or "小思" in the chat is "Curious Mind" to the
 * director.
 */
import { supportedLocales } from '@/lib/i18n/locales';
import type { Locale } from '@/lib/i18n/types';
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
import { getBuiltInAgent } from '@/lib/orchestration/registry/built-in';
import type { AgentConfig } from '@/lib/orchestration/registry/types';

const LOCALE_RESOURCES: Record<Locale, unknown> = {
  'en-US': enUS,
  'zh-CN': zhCN,
  'zh-TW': zhTW,
  'ja-JP': jaJP,
  'ko-KR': koKR,
  'es-MX': esMX,
  'fr-FR': frFR,
  'vi-VN': viVN,
  'pt-BR': ptBR,
  'ru-RU': ruRU,
  'ar-SA': arSA,
  'de-DE': deDE,
};

const SUPPORTED_LOCALE_CODES: readonly string[] = supportedLocales.map((locale) => locale.code);

function isLocale(value: unknown): value is Locale {
  return typeof value === 'string' && SUPPORTED_LOCALE_CODES.includes(value);
}

/** `settings.agentNames.<agentId>` of `locale`, when that locale names this built-in agent */
export function getLocalizedBuiltInAgentName(
  agentId: string,
  locale: string | undefined,
): string | undefined {
  if (!isLocale(locale) || !getBuiltInAgent(agentId)) return undefined;
  const resource = LOCALE_RESOURCES[locale] as {
    settings?: { agentNames?: Record<string, unknown> };
  };
  const name = resource.settings?.agentNames?.[agentId];
  return typeof name === 'string' && name.trim() ? name.trim() : undefined;
}

/**
 * A built-in agent under its interface name. Only the stock name is replaced:
 * an agent the learner renamed keeps the name they gave it.
 */
export function withLocalizedBuiltInName<T extends Pick<AgentConfig, 'id' | 'name'>>(
  agent: T,
  locale: string | undefined,
): T {
  const builtIn = getBuiltInAgent(agent.id);
  if (!builtIn || agent.name !== builtIn.name) return agent;
  const name = getLocalizedBuiltInAgentName(agent.id, locale);
  return name && name !== agent.name ? { ...agent, name } : agent;
}

/** The longest name (or role) a prompt shows, in characters */
export const PROMPT_NAME_MAX_CHARS = 40;

/**
 * A name as the prompts may show it: on one line, without the quote marks
 * and angle brackets that would close a quoted field or a persona block, and
 * cut to PROMPT_NAME_MAX_CHARS. A shared course's agent name is someone
 * else's text; a newline and a fake heading in it must stay a name.
 */
export function toPromptName(name: string): string {
  const flat = name
    .replace(/[\s\u2028\u2029]+/g, ' ')
    .replace(/["`<>«»“”‹›]/g, '')
    .trim();
  const chars = Array.from(flat);
  return chars.length > PROMPT_NAME_MAX_CHARS
    ? `${chars.slice(0, PROMPT_NAME_MAX_CHARS - 1).join('')}…`
    : flat;
}

/** An agent with its name and role as the prompts may show them (an emptied name falls back to the id) */
export function withPromptName<T extends Pick<AgentConfig, 'id' | 'name' | 'role'>>(agent: T): T {
  const name = toPromptName(agent.name) || toPromptName(agent.id);
  const role = typeof agent.role === 'string' ? toPromptName(agent.role) : agent.role;
  return name === agent.name && role === agent.role ? agent : { ...agent, name, role };
}
