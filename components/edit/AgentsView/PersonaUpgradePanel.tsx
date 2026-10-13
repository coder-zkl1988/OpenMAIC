'use client';

/**
 * PersonaUpgradePanel — "rewrite as real people" (I25.2).
 *
 * Opt-in, from the roster: the whole roster goes to the persona upgrade
 * route (course context, everyone's current persona, an empty one included)
 * and comes back with each member written as a person rather than a list of
 * duties. Nothing changes until the learner has seen it: every member gets a
 * before / after preview with a checkbox, and Apply writes only the checked
 * `persona` fields, as one roster edit that undo takes back. Names, roles,
 * avatars and voices are never touched.
 *
 * Colours are theme tokens, like the panel around it.
 */

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store/stage';
import { Checkbox } from '@/components/ui/checkbox';
import {
  buildPersonaUpgradeRequest,
  requestPersonaUpgrade,
  type PersonaUpgradeFailure,
  type UpgradeRosterMember,
} from '@/lib/edit/persona-upgrade';

type UpgradeState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'preview'; readonly personas: ReadonlyArray<{ id: string; persona: string }> }
  | { readonly kind: 'error'; readonly failure: PersonaUpgradeFailure };

interface PersonaUpgradePanelProps {
  /** The roster as the editor holds it now */
  readonly roster: readonly UpgradeRosterMember[];
  /** Apply the checked personas (one undoable roster edit) */
  readonly onApply: (personas: Array<{ id: string; persona: string }>) => void;
  readonly onClose: () => void;
}

const button =
  'rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-40';
const primary = cn(button, 'bg-primary text-primary-foreground hover:bg-primary/90');
const secondary = cn(button, 'border border-border bg-background text-foreground hover:bg-muted');

export function PersonaUpgradePanel({ roster, onApply, onClose }: PersonaUpgradePanelProps) {
  const { t } = useI18n();
  // The roster as it was asked about: the preview's "now" stays what was sent
  const [snapshot] = useState(() =>
    roster.map(({ id, name, role, persona }) => ({ id, name, role, persona: persona ?? '' })),
  );
  const [state, setState] = useState<UpgradeState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const controller = new AbortController();
    const { stage, outlines, scenes } = useStageStore.getState();
    const request = buildPersonaUpgradeRequest({
      stage,
      outlines,
      scenes,
      roster: snapshot,
      targetAgentIds: snapshot.map((member) => member.id),
    });
    requestPersonaUpgrade(request, { signal: controller.signal })
      .then((result) => {
        if (controller.signal.aborted) return;
        if (!result.ok) {
          setState({ kind: 'error', failure: result.failure });
          return;
        }
        // Checked by default where the persona really changes
        const before = new Map(snapshot.map((member) => [member.id, member.persona.trim()]));
        setChosen(
          new Set(
            result.personas
              .filter((entry) => entry.persona !== before.get(entry.id))
              .map((entry) => entry.id),
          ),
        );
        setState({ kind: 'preview', personas: result.personas });
      })
      .catch(() => {
        if (!controller.signal.aborted) {
          setState({ kind: 'error', failure: { kind: 'failed' } });
        }
      });
    return () => controller.abort();
  }, [attempt, snapshot]);

  const retry = () => {
    setState({ kind: 'loading' });
    setAttempt((value) => value + 1);
  };

  const toggle = (id: string, checked: boolean) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });

  if (state.kind === 'loading') {
    return (
      <div
        data-testid="persona-upgrade"
        data-state="loading"
        className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-8 text-center"
      >
        <Loader2 aria-hidden="true" className="size-5 animate-spin text-muted-foreground" />
        <p role="status" className="text-[12px] text-muted-foreground">
          {t('edit.roster.upgrade.loading')}
        </p>
        <button type="button" onClick={onClose} className={secondary}>
          {t('common.cancel')}
        </button>
      </div>
    );
  }

  if (state.kind === 'error') {
    return (
      <div
        data-testid="persona-upgrade"
        data-state="error"
        className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-8 text-center"
      >
        <p role="alert" className="text-[12px] leading-relaxed text-foreground">
          {t(
            state.failure.kind === 'invalid'
              ? 'edit.roster.upgrade.invalid'
              : 'edit.roster.upgrade.failed',
          )}
        </p>
        <div className="flex gap-1.5">
          <button type="button" onClick={onClose} className={secondary}>
            {t('common.cancel')}
          </button>
          {state.failure.kind === 'failed' && (
            <button
              type="button"
              data-testid="persona-upgrade-retry"
              onClick={retry}
              className={primary}
            >
              {t('common.retry')}
            </button>
          )}
        </div>
      </div>
    );
  }

  const rewritten = new Map(state.personas.map((entry) => [entry.id, entry.persona]));
  return (
    <div
      data-testid="persona-upgrade"
      data-state="preview"
      className="flex min-h-0 w-full min-w-0 flex-1 flex-col"
    >
      <div className="shrink-0 px-4 pb-2">
        <p className="text-[12.5px] font-semibold text-foreground">
          {t('edit.roster.upgrade.previewTitle')}
        </p>
        <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
          {t('edit.roster.upgrade.previewHint')}
        </p>
      </div>
      <ul className="flex min-h-0 w-full min-w-0 flex-1 flex-col gap-2 overflow-y-auto px-3 pb-3">
        {snapshot.map((member) => {
          const after = rewritten.get(member.id) ?? '';
          const checkboxId = `persona-upgrade-${member.id}`;
          return (
            <li
              key={member.id}
              data-testid="persona-upgrade-row"
              data-agent-id={member.id}
              className="flex min-w-0 flex-col gap-1.5 rounded-[10px] border border-border bg-card p-2.5"
            >
              <label htmlFor={checkboxId} className="flex cursor-pointer items-center gap-2">
                <Checkbox
                  id={checkboxId}
                  checked={chosen.has(member.id)}
                  onCheckedChange={(checked) => toggle(member.id, checked === true)}
                />
                <span className="min-w-0 truncate text-[12.5px] font-semibold text-foreground">
                  {member.name.trim() || t('edit.roster.unnamed')}
                </span>
              </label>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[10.5px] font-semibold tracking-[0.02em] text-muted-foreground">
                  {t('edit.roster.upgrade.now')}
                </span>
                <p className="line-clamp-3 text-[11.5px] leading-relaxed text-muted-foreground">
                  {member.persona.trim() || t('edit.roster.noPersona')}
                </p>
              </div>
              <div className="flex min-w-0 flex-col gap-0.5">
                <span className="text-[10.5px] font-semibold tracking-[0.02em] text-primary">
                  {t('edit.roster.upgrade.rewritten')}
                </span>
                <p
                  data-testid="persona-upgrade-after"
                  className="whitespace-pre-line text-[11.5px] leading-relaxed text-foreground"
                >
                  {after}
                </p>
              </div>
            </li>
          );
        })}
      </ul>
      <div className="flex shrink-0 justify-end gap-1.5 border-t border-border px-3 py-2.5">
        <button type="button" onClick={onClose} className={secondary}>
          {t('common.cancel')}
        </button>
        <button
          type="button"
          data-testid="persona-upgrade-apply"
          disabled={chosen.size === 0}
          onClick={() =>
            onApply(state.personas.filter((entry) => chosen.has(entry.id)).map((e) => ({ ...e })))
          }
          className={primary}
        >
          {t('edit.roster.upgrade.apply')}
        </button>
      </div>
    </div>
  );
}
