'use client';

import { useId } from 'react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useSettingsStore } from '@/lib/store/settings';
import {
  AUTO_AGENT_COUNT_MAX,
  AUTO_AGENT_COUNT_MIN,
  CLASS_ATMOSPHERES,
} from '@/lib/orchestration/persona-guide';

const SIZES = Array.from(
  { length: AUTO_AGENT_COUNT_MAX - AUTO_AGENT_COUNT_MIN + 1 },
  (_, i) => AUTO_AGENT_COUNT_MIN + i,
);

const chip = (pressed: boolean) =>
  cn(
    'h-7 min-w-7 shrink-0 rounded-md border px-2 text-xs font-medium transition-colors cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
    pressed
      ? 'border-primary bg-primary/10 text-primary'
      : 'border-line bg-background text-fg-secondary hover:bg-subtle hover:text-fg',
  );

/**
 * Auto mode's class (I28): how many people the generated class has (teacher
 * included; "let the AI decide" by default) and, optionally, what kind of
 * class it is — quiet and focused, give-and-take, or lively. The atmosphere
 * only describes the people when their personas are written; nothing about
 * how often anyone speaks is set here. Pressing the chosen atmosphere again
 * clears it.
 */
export function AutoClassChoices() {
  const { t } = useI18n();
  const sizeLabelId = useId();
  const atmosphereLabelId = useId();
  const autoAgentCount = useSettingsStore((s) => s.autoAgentCount);
  const autoAgentCountSet = useSettingsStore((s) => s.autoAgentCountSet);
  const setAutoAgentCount = useSettingsStore((s) => s.setAutoAgentCount);
  const classAtmosphere = useSettingsStore((s) => s.classAtmosphere);
  const setClassAtmosphere = useSettingsStore((s) => s.setClassAtmosphere);

  return (
    <div data-testid="auto-class-choices" className="flex flex-col gap-3">
      <div role="group" aria-labelledby={sizeLabelId}>
        <div className="flex items-baseline justify-between gap-2">
          <span id={sizeLabelId} className="text-xs font-semibold text-fg-secondary">
            {t('settings.autoAgentCount')}
          </span>
          <span className="truncate text-[10px] text-fg-tertiary">
            {t('settings.autoAgentCountDesc')}
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          <button
            type="button"
            data-testid="auto-class-size-auto"
            aria-pressed={!autoAgentCountSet}
            onClick={() => setAutoAgentCount(null)}
            className={chip(!autoAgentCountSet)}
          >
            {t('settings.autoAgentCountAuto')}
          </button>
          {SIZES.map((size) => {
            const pressed = autoAgentCountSet && autoAgentCount === size;
            return (
              <button
                key={size}
                type="button"
                data-testid="auto-class-size"
                aria-pressed={pressed}
                onClick={() => setAutoAgentCount(size)}
                className={cn(chip(pressed), 'tabular-nums')}
              >
                {size}
              </button>
            );
          })}
        </div>
      </div>
      <div role="group" aria-labelledby={atmosphereLabelId}>
        <div className="flex items-baseline justify-between gap-2">
          <span id={atmosphereLabelId} className="text-xs font-semibold text-fg-secondary">
            {t('settings.classAtmosphere')}
          </span>
          <span className="truncate text-[10px] text-fg-tertiary">
            {t('settings.classAtmosphereDesc')}
          </span>
        </div>
        <div className="mt-1.5 flex flex-wrap gap-1">
          {CLASS_ATMOSPHERES.map((atmosphere) => {
            const pressed = classAtmosphere === atmosphere;
            return (
              <button
                key={atmosphere}
                type="button"
                data-testid="auto-class-atmosphere"
                data-atmosphere={atmosphere}
                aria-pressed={pressed}
                onClick={() => setClassAtmosphere(pressed ? undefined : atmosphere)}
                className={chip(pressed)}
              >
                {t(`settings.classAtmosphereOptions.${atmosphere}`)}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
