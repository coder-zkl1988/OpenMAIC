'use client';

/**
 * AgentRosterPanel — who is in this classroom, and what each of them is like.
 *
 * Course-level content, not an app setting: the roster lives on the stage
 * document (`stage.generatedAgentConfigs`), and every edit here goes straight
 * into it through `useAgentRoster`. It is mounted from `RosterDialog`, opened
 * from the edit dock's global bar.
 *
 * One card per member, collapsed to a line and expanded to an editor. The lead
 * teacher is first and cannot be removed (the last-teacher guard lives in
 * `agent-ops`); AI classmates below it reorder and can leave the class.
 *
 * The course's script points at members: class moments they open (by id) and
 * lines that say their name. Removing or renaming a member the script points
 * at asks first, with the counts; a removed classmate's moments are handed to
 * the lead teacher or removed with them, instead of being skipped silently.
 *
 * "Rewrite as real people" (I25.2) sends the roster to the persona upgrade
 * and previews each member's new persona before anything changes; applying
 * is one roster edit, so undo takes it back.
 *
 * Colours: the chrome is theme tokens, so the panel reads correctly in both
 * themes. The one exception is each classmate's OWN colour, which is data on the
 * agent and therefore stays an inline value.
 */

import {
  type ReactNode,
  type Ref,
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { toast } from 'sonner';
import {
  Camera,
  ChevronDown,
  ChevronUp,
  Redo2,
  Sparkles,
  Undo2,
  UserMinus,
  UserPlus,
} from 'lucide-react';
import { cn } from '@/lib/utils/cn';
import { useI18n } from '@/lib/hooks/use-i18n';
import { useStageStore } from '@/lib/store/stage';
import type { GeneratedAgentConfig } from '@/lib/types/stage';
import {
  countAgentScriptReferences,
  rewriteAgentMoments,
  type AgentScriptReferences,
} from '@/lib/edit/agent-ops';
import { canUpgradePersonas } from '@/lib/edit/persona-upgrade';
import { useAgentRoster } from './useAgentRoster';
import { AvatarPicker } from './AvatarPicker';
import { PersonaUpgradePanel } from './PersonaUpgradePanel';

const PERSONA_MAX = 2000;

interface RosterDraft {
  readonly agentId: string;
  readonly patch: Partial<GeneratedAgentConfig>;
}

type RegisterDraft = (key: string, read: () => RosterDraft | null) => () => void;

// ─── Avatar with camera overlay ──────────────────────────────────────────────

interface AvatarWithOverlayProps {
  readonly agent: GeneratedAgentConfig;
  readonly size: number;
  readonly ringColor: string;
  readonly onPickerOpen: () => void;
}

function AvatarWithOverlay({ agent, size, ringColor, onPickerOpen }: AvatarWithOverlayProps) {
  const [hovering, setHovering] = useState(false);
  return (
    <div
      className="relative shrink-0 cursor-pointer"
      style={{ width: size, height: size }}
      onMouseEnter={() => setHovering(true)}
      onMouseLeave={() => setHovering(false)}
      onClick={(e) => {
        e.stopPropagation();
        onPickerOpen();
      }}
    >
      {/* Avatars are static public paths; the roster needs no image optimizer. */}
      <img
        src={agent.avatar}
        alt={agent.name}
        draggable={false}
        className="rounded-full object-cover"
        style={{ width: size, height: size, boxShadow: `0 0 0 2px ${ringColor}` }}
      />
      {hovering && (
        <div className="absolute inset-0 flex items-center justify-center rounded-full bg-zinc-900/45">
          <Camera className="size-3.5 text-white" />
        </div>
      )}
    </div>
  );
}

// ─── Inline editable name ────────────────────────────────────────────────────

interface EditableNameProps {
  readonly agentId: string;
  readonly draftKey: string;
  readonly value: string;
  readonly onCommit: (v: string) => void;
  readonly registerDraft: RegisterDraft;
  readonly className?: string;
  /**
   * A rename waits for confirmation: the field shows the new name, marked as
   * not saved yet, and points at the confirmation that explains it
   */
  readonly pendingDescribedBy?: string;
}

function EditableName({
  agentId,
  draftKey,
  value,
  onCommit,
  registerDraft,
  className,
  pendingDescribedBy,
}: EditableNameProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const draftValueRef = useRef(value);
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!focusedRef.current) draftValueRef.current = value;
  }, [value]);

  const handleBlur = useCallback(() => {
    const text = ref.current?.textContent?.trim() ?? '';
    if (text && text !== value) onCommit(text);
    else if (ref.current) ref.current.textContent = value;
  }, [value, onCommit]);
  const readDraft = useCallback((): RosterDraft | null => {
    // Immediate Radix closes can still read the live DOM; controlled owner
    // closes may already have detached it, in which case the input snapshot is
    // the durable owner-side copy.
    const name = (ref.current?.textContent ?? draftValueRef.current).trim();
    return name && name !== value ? { agentId, patch: { name } } : null;
  }, [agentId, value]);
  useEffect(() => registerDraft(draftKey, readDraft), [draftKey, readDraft, registerDraft]);

  return (
    <span
      ref={ref}
      data-testid="agent-roster-name"
      data-pending={pendingDescribedBy ? 'true' : undefined}
      aria-describedby={pendingDescribedBy}
      contentEditable
      suppressContentEditableWarning
      onInput={(event) => {
        draftValueRef.current = event.currentTarget.textContent ?? '';
      }}
      onFocus={() => {
        focusedRef.current = true;
      }}
      onBlur={() => {
        focusedRef.current = false;
        handleBlur();
      }}
      onClick={(e) => e.stopPropagation()}
      className={cn(
        'cursor-text rounded-[3px] outline-none',
        'hover:underline hover:decoration-primary/60 hover:decoration-dashed',
        'focus:shadow-[0_0_0_2px_var(--ring)]',
        className,
        // Not saved yet: the confirmation below decides
        pendingDescribedBy && 'italic decoration-dashed underline decoration-muted-foreground',
      )}
      style={{ minWidth: 10 }}
    >
      {value}
    </span>
  );
}

// ─── Persona textarea ─────────────────────────────────────────────────────────

interface PersonaEditorProps {
  readonly agentId: string;
  readonly value: string;
  readonly onUpdate: (id: string, persona: string) => void;
  readonly registerDraft: RegisterDraft;
}

function PersonaEditor({ agentId, value, onUpdate, registerDraft }: PersonaEditorProps) {
  const { t } = useI18n();
  const [prevValue, setPrevValue] = useState(value);
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);

  // Sync draft when value changes externally (e.g. undo/redo), but only when
  // not focused — avoids clobbering in-progress typing. Render-time state
  // update: React re-renders immediately with the new draft before painting.
  if (prevValue !== value && !focused) {
    setPrevValue(value);
    setDraft(value);
  }

  const handleChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setDraft(e.target.value.slice(0, PERSONA_MAX));
  };

  const handleBlur = useCallback(() => {
    setFocused(false);
    if (draft !== value) onUpdate(agentId, draft);
  }, [agentId, draft, onUpdate, value]);
  const readDraft = useCallback(
    (): RosterDraft | null => (draft !== value ? { agentId, patch: { persona: draft } } : null),
    [agentId, draft, value],
  );
  useEffect(
    () => registerDraft(`${agentId}:persona`, readDraft),
    [agentId, readDraft, registerDraft],
  );

  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11.5px] font-semibold tracking-[0.01em] text-muted-foreground">
        {t('edit.roster.personaLabel')}
      </span>
      <textarea
        data-persona={agentId}
        value={draft}
        onChange={handleChange}
        onFocus={() => setFocused(true)}
        onBlur={handleBlur}
        rows={4}
        maxLength={PERSONA_MAX}
        placeholder={t('edit.roster.personaPlaceholder')}
        className="w-full min-w-0 resize-none rounded-[10px] border border-border bg-background px-3 py-2.5 text-[12.5px] leading-relaxed text-foreground outline-none focus:border-primary/40 focus:ring-1 focus:ring-primary/20"
      />
      <span className="self-end text-[10px] text-muted-foreground/70">
        {draft.length} / {PERSONA_MAX}
      </span>
    </div>
  );
}

// ─── Script references: ask before a remove / rename ─────────────────────────

/** What the course's script says about a member */
type ReadReferences = (agent: GeneratedAgentConfig) => AgentScriptReferences;

/** How a removed classmate's class moments go: to the lead teacher, or with them */
type RemovedMoments = 'teacher' | 'drop';

type PendingScriptChange =
  | { readonly kind: 'remove'; readonly references: AgentScriptReferences }
  | { readonly kind: 'rename'; readonly name: string; readonly references: AgentScriptReferences };

interface ScriptImpactConfirmProps {
  /** The id of its explanation, for the field a pending rename marks */
  readonly descriptionId: string;
  readonly change: PendingScriptChange;
  /** The member's current name (a rename's old name) */
  readonly name: string;
  /** A lead teacher exists to open the removed classmate's moments */
  readonly canHandToTeacher: boolean;
  readonly onRemove: (moments?: RemovedMoments) => void;
  readonly onRename: (name: string) => void;
  readonly onCancel: () => void;
}

const impactButton =
  'rounded-lg px-2.5 py-1.5 text-[11.5px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring';

function ScriptImpactConfirm({
  descriptionId,
  change,
  name,
  canHandToTeacher,
  onRemove,
  onRename,
  onCancel,
}: ScriptImpactConfirmProps) {
  const { t } = useI18n();
  const titleId = useId();
  const firstActionRef = useRef<HTMLButtonElement>(null);
  // Keyboard and screen-reader users land on it: it is announced, and its
  // first (safe) action has the focus
  useEffect(() => {
    firstActionRef.current?.focus();
  }, []);
  const { moments, mentions } = change.references;
  const primary = cn(impactButton, 'bg-primary text-primary-foreground hover:bg-primary/90');
  const secondary = cn(
    impactButton,
    'border border-border bg-background text-foreground hover:bg-muted',
  );

  return (
    <div
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-testid="agent-roster-impact"
      onClick={(e) => e.stopPropagation()}
      className="mx-3 mb-3 flex flex-col gap-2 rounded-[10px] border border-border bg-muted/50 p-2.5 text-[11.5px] leading-relaxed text-foreground"
    >
      <span id={titleId} className="sr-only">
        {t('edit.roster.impact.title')}
      </span>
      <div id={descriptionId} className="flex flex-col gap-2">
        {change.kind === 'remove' ? (
          <>
            {moments > 0 && <p>{t('edit.roster.impact.moments', { name, count: moments })}</p>}
            {mentions > 0 && <p>{t('edit.roster.impact.mentions', { name, count: mentions })}</p>}
          </>
        ) : (
          <p>{t('edit.roster.impact.renameMentions', { name, count: mentions })}</p>
        )}
      </div>
      <div className="flex flex-wrap justify-end gap-1.5">
        <button
          ref={firstActionRef}
          type="button"
          data-testid="agent-roster-impact-cancel"
          onClick={onCancel}
          className={secondary}
        >
          {t('common.cancel')}
        </button>
        {change.kind === 'rename' ? (
          <button
            type="button"
            data-testid="agent-roster-rename-confirm"
            onClick={() => onRename(change.name)}
            className={primary}
          >
            {t('edit.roster.impact.renameAnyway')}
          </button>
        ) : moments > 0 ? (
          <>
            <button
              type="button"
              data-testid="agent-roster-remove-drop"
              onClick={() => onRemove('drop')}
              className={secondary}
            >
              {t('edit.roster.impact.dropMoments')}
            </button>
            {canHandToTeacher && (
              <button
                type="button"
                data-testid="agent-roster-remove-reassign"
                onClick={() => onRemove('teacher')}
                className={primary}
              >
                {t('edit.roster.impact.handToTeacher')}
              </button>
            )}
          </>
        ) : (
          <button
            type="button"
            data-testid="agent-roster-remove-confirm"
            onClick={() => onRemove()}
            className={primary}
          >
            {t('edit.roster.impact.removeAnyway')}
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * Puts the focus back where a cancelled confirmation came from (the name
 * field, the remove button), once the card has re-rendered without it.
 */
function useFocusAfterCancel(cardRef: React.RefObject<HTMLDivElement | null>) {
  const selectorRef = useRef<string | null>(null);
  useEffect(() => {
    const selector = selectorRef.current;
    if (!selector) return;
    selectorRef.current = null;
    cardRef.current?.querySelector<HTMLElement>(selector)?.focus();
  });
  return useCallback((selector: string) => {
    selectorRef.current = selector;
  }, []);
}

const NAME_FIELD = '[data-testid="agent-roster-name"]';
const REMOVE_BUTTON = '[data-testid="agent-roster-remove"]';

// ─── Teacher card ─────────────────────────────────────────────────────────────

interface TeacherCardProps {
  readonly agent: GeneratedAgentConfig;
  readonly open: boolean;
  readonly onToggle: () => void;
  readonly onUpdate: (id: string, patch: Partial<GeneratedAgentConfig>) => void;
  readonly readReferences: ReadReferences;
  readonly registerDraft: RegisterDraft;
}

function TeacherCard({
  agent,
  open,
  onToggle,
  onUpdate,
  readReferences,
  registerDraft,
}: TeacherCardProps) {
  const { t } = useI18n();
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
  const personaPreview = agent.persona?.slice(0, 40) || t('edit.roster.noPersona');
  const [pending, setPending] = useState<PendingScriptChange | null>(null);
  // Remounts the name editor so a cancelled rename shows the current name again
  const [nameKey, setNameKey] = useState(0);
  const impactId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const focusAfterCancel = useFocusAfterCancel(cardRef);
  const requestRename = (name: string) => {
    const references = readReferences(agent);
    if (references.mentions === 0) onUpdate(agent.id, { name });
    else setPending({ kind: 'rename', name, references });
  };

  return (
    <div
      ref={cardRef}
      data-testid="agent-roster-card"
      className="mb-3 w-full min-w-0 shrink-0 overflow-hidden rounded-[13px] border border-primary/25 bg-gradient-to-b from-primary/[0.07] to-transparent"
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== 'Enter' && event.key !== ' ') return;
          if (event.key === ' ') event.preventDefault();
          onToggle();
        }}
        className="flex cursor-pointer select-none items-center gap-3 px-3 py-[11px]"
      >
        <AvatarWithOverlay
          agent={agent}
          size={42}
          ringColor="var(--primary)"
          onPickerOpen={() => {
            if (!open) {
              onToggle();
              setShowAvatarPicker(true);
              return;
            }
            setShowAvatarPicker((v) => !v);
          }}
        />

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <EditableName
              key={nameKey}
              agentId={agent.id}
              draftKey={`${agent.id}:name`}
              value={agent.name || t('edit.roster.unnamed')}
              onCommit={requestRename}
              registerDraft={registerDraft}
              className="text-[13.5px] font-semibold text-foreground"
              pendingDescribedBy={pending?.kind === 'rename' ? impactId : undefined}
            />
            <span className="inline-flex items-center gap-0.5 rounded-full border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[9.5px] font-semibold text-primary">
              <span aria-hidden="true">👑</span>
              {t('edit.roster.teacherBadge')}
            </span>
          </div>
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={agent.persona}>
            {personaPreview}
          </p>
        </div>

        {open ? (
          <ChevronUp className="size-[17px] shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-[17px] shrink-0 text-muted-foreground" />
        )}
      </div>

      {pending && (
        <ScriptImpactConfirm
          descriptionId={impactId}
          change={pending}
          name={agent.name}
          canHandToTeacher={false}
          onRemove={() => setPending(null)}
          onRename={(name) => {
            setPending(null);
            onUpdate(agent.id, { name });
          }}
          onCancel={() => {
            setPending(null);
            setNameKey((key) => key + 1);
            focusAfterCancel(NAME_FIELD);
          }}
        />
      )}

      {open && (
        <div className="flex flex-col gap-3 border-t border-primary/15 bg-primary/[0.03] px-3 pb-3 pt-3">
          {showAvatarPicker && (
            <div className="pb-1">
              <AvatarPicker
                value={agent.avatar}
                onChange={(avatar) => {
                  onUpdate(agent.id, { avatar });
                  setShowAvatarPicker(false);
                }}
              />
            </div>
          )}
          <PersonaEditor
            agentId={agent.id}
            value={agent.persona ?? ''}
            onUpdate={(id, persona) => onUpdate(id, { persona })}
            registerDraft={registerDraft}
          />
        </div>
      )}
    </div>
  );
}

// ─── Classmate card ────────────────────────────────────────────────────────────

interface ClassmateCardProps {
  readonly agent: GeneratedAgentConfig;
  readonly open: boolean;
  readonly isFirst: boolean;
  readonly isLast: boolean;
  readonly onToggle: () => void;
  readonly onUpdate: (id: string, patch: Partial<GeneratedAgentConfig>) => void;
  /** Remove the classmate; `moments` says where the class moments they open go */
  readonly onRemove: (id: string, moments?: RemovedMoments) => void;
  readonly onMoveUp: () => void;
  readonly onMoveDown: () => void;
  readonly readReferences: ReadReferences;
  /** A lead teacher exists to open a removed classmate's moments */
  readonly canHandToTeacher: boolean;
  readonly registerDraft: RegisterDraft;
}

function ClassmateCard({
  agent,
  open,
  isFirst,
  isLast,
  onToggle,
  onUpdate,
  onRemove,
  onMoveUp,
  onMoveDown,
  readReferences,
  canHandToTeacher,
  registerDraft,
}: ClassmateCardProps) {
  const { t } = useI18n();
  const [showAvatarPicker, setShowAvatarPicker] = useState(false);
  const [pending, setPending] = useState<PendingScriptChange | null>(null);
  // Remounts the name editor so a cancelled rename shows the current name again
  const [nameKey, setNameKey] = useState(0);
  const impactId = useId();
  const cardRef = useRef<HTMLDivElement>(null);
  const focusAfterCancel = useFocusAfterCancel(cardRef);
  const requestRename = (name: string) => {
    const references = readReferences(agent);
    if (references.mentions === 0) onUpdate(agent.id, { name });
    else setPending({ kind: 'rename', name, references });
  };
  const requestRemove = () => {
    const references = readReferences(agent);
    if (references.moments + references.mentions === 0) onRemove(agent.id);
    else setPending({ kind: 'remove', references });
  };
  // The agent's own colour is data, so it stays an inline value; everything
  // around it is a theme token.
  const ringColor = agent.color || 'var(--muted-foreground)';
  const personaPreview = agent.persona?.slice(0, 35) || t('edit.roster.noPersona');

  return (
    <div
      ref={cardRef}
      data-testid="agent-roster-card"
      className={cn(
        'group/card mb-[9px] w-full min-w-0 shrink-0 overflow-hidden rounded-[13px] border bg-card transition-colors',
        open ? 'border-transparent' : 'border-border',
      )}
      style={open ? { borderColor: `${ringColor}66`, boxShadow: `0 2px 12px ${ringColor}22` } : {}}
    >
      <div
        role="button"
        tabIndex={0}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.target !== event.currentTarget) return;
          if (event.key !== 'Enter' && event.key !== ' ') return;
          if (event.key === ' ') event.preventDefault();
          onToggle();
        }}
        className="flex cursor-pointer select-none items-center gap-3 px-3 py-[11px]"
      >
        <AvatarWithOverlay
          agent={agent}
          size={40}
          ringColor={ringColor}
          onPickerOpen={() => {
            if (!open) {
              onToggle();
              setShowAvatarPicker(true);
              return;
            }
            setShowAvatarPicker((v) => !v);
          }}
        />

        <div className="min-w-0 flex-1">
          <EditableName
            key={nameKey}
            agentId={agent.id}
            draftKey={`${agent.id}:name`}
            value={agent.name || t('edit.roster.unnamed')}
            onCommit={requestRename}
            registerDraft={registerDraft}
            className="block truncate text-[13.5px] font-semibold text-foreground"
            pendingDescribedBy={pending?.kind === 'rename' ? impactId : undefined}
          />
          <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={agent.persona}>
            {personaPreview}
          </p>
        </div>

        {/* Reorder controls: quiet at rest so the row is not two chevron stacks,
            and brought up on hover / keyboard focus. Kept rendered (not hidden)
            so they stay reachable without a pointer. Stop propagation so they
            don't expand the card. */}
        <div
          className="flex shrink-0 flex-col gap-0.5 opacity-45 transition-opacity duration-150 group-hover/card:opacity-100 focus-within:opacity-100 motion-reduce:transition-none"
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            aria-label={t('edit.roster.moveUp')}
            disabled={isFirst}
            onClick={onMoveUp}
            className="grid size-5 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-25"
          >
            <ChevronUp className="size-3" />
          </button>
          <button
            type="button"
            aria-label={t('edit.roster.moveDown')}
            disabled={isLast}
            onClick={onMoveDown}
            className="grid size-5 place-items-center rounded text-muted-foreground transition-colors hover:bg-muted disabled:pointer-events-none disabled:opacity-25"
          >
            <ChevronDown className="size-3" />
          </button>
        </div>

        {open ? (
          <ChevronUp className="size-[17px] shrink-0 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-[17px] shrink-0 text-muted-foreground" />
        )}
      </div>

      {pending && (
        <ScriptImpactConfirm
          descriptionId={impactId}
          change={pending}
          name={agent.name}
          canHandToTeacher={canHandToTeacher}
          onRemove={(moments) => {
            setPending(null);
            onRemove(agent.id, moments);
          }}
          onRename={(name) => {
            setPending(null);
            onUpdate(agent.id, { name });
          }}
          onCancel={() => {
            if (pending.kind === 'rename') setNameKey((key) => key + 1);
            setPending(null);
            focusAfterCancel(pending.kind === 'rename' ? NAME_FIELD : REMOVE_BUTTON);
          }}
        />
      )}

      {open && (
        <div
          className="flex flex-col gap-3 border-t px-3 pb-3 pt-3"
          style={{ borderColor: `${ringColor}44`, background: `${ringColor}08` }}
        >
          {showAvatarPicker && (
            <div className="pb-1">
              <AvatarPicker
                value={agent.avatar}
                onChange={(avatar) => {
                  onUpdate(agent.id, { avatar });
                  setShowAvatarPicker(false);
                }}
              />
            </div>
          )}
          <PersonaEditor
            agentId={agent.id}
            value={agent.persona ?? ''}
            onUpdate={(id, persona) => onUpdate(id, { persona })}
            registerDraft={registerDraft}
          />

          <div className="mt-1 flex items-center justify-end border-t border-border pt-1">
            <button
              type="button"
              data-testid="agent-roster-remove"
              onClick={requestRemove}
              className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11.5px] text-muted-foreground transition-colors hover:bg-rose-50 hover:text-rose-600 dark:hover:bg-rose-500/15 dark:hover:text-rose-400"
            >
              <UserMinus className="size-3.5" />
              {t('edit.roster.removeFromClass')}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export interface AgentRosterPanelHandle {
  flushDrafts(): void;
}

interface AgentRosterPanelProps {
  readonly flushRef?: Ref<AgentRosterPanelHandle>;
  /**
   * A control the host slots at the end of the sub-head row (the dialog's close
   * button). Rendered inline with undo/redo so it shares their baseline and ghost
   * icon skin instead of floating over the corner as a boxed glyph.
   */
  readonly headerTrailing?: ReactNode;
}

export function AgentRosterPanel({ flushRef, headerTrailing }: AgentRosterPanelProps = {}) {
  const { t } = useI18n();
  const { roster, selectedId, select, add, update, updateMany, remove, reorder, history } =
    useAgentRoster();
  // "Rewrite as real people": its preview takes the list's place until applied or cancelled
  const [upgrading, setUpgrading] = useState(false);
  const setStageAgents = useStageStore.use.setStageAgents();
  const rosterRef = useRef(roster);
  useLayoutEffect(() => {
    rosterRef.current = roster;
  }, [roster]);
  const draftReaders = useRef(new Map<string, () => RosterDraft | null>());
  const registerDraft = useCallback<RegisterDraft>((key, read) => {
    draftReaders.current.set(key, read);
    return () => {
      if (draftReaders.current.get(key) === read) draftReaders.current.delete(key);
    };
  }, []);
  useImperativeHandle(
    flushRef,
    () => ({
      flushDrafts: () => {
        let next = rosterRef.current;
        for (const read of draftReaders.current.values()) {
          const draft = read();
          if (!draft) continue;
          const patch = draft.patch;
          if (patch.name !== undefined) {
            // The confirmation only informs (the lines keep the old name), and
            // closing leaves no room for it: the rename is kept, and what it
            // would have said is told once the dialog has gone
            const agent = next.find((member) => member.id === draft.agentId);
            const mentions = agent
              ? countAgentScriptReferences(useStageStore.getState().scenes, agent).mentions
              : 0;
            if (agent && mentions > 0) {
              toast.info(
                t('edit.roster.impact.renameMentions', { name: agent.name, count: mentions }),
              );
            }
          }
          next = next.map((agent) => (agent.id === draft.agentId ? { ...agent, ...patch } : agent));
        }
        if (next !== rosterRef.current) {
          // Commit synchronously to the owner store. A state update in an
          // unmount cleanup would never reach useAgentRoster's persistence
          // effect, which is precisely the close path this handle protects.
          rosterRef.current = next;
          setStageAgents(next);
        }
      },
    }),
    [setStageAgents, t],
  );

  const teachers = roster.filter((a) => a.role === 'teacher');
  const classmates = roster.filter((a) => a.role !== 'teacher');
  const leadTeacherId = teachers[0]?.id;

  // Read when asked: the counts must reflect the script as it is now
  const readReferences = useCallback<ReadReferences>(
    (agent) => countAgentScriptReferences(useStageStore.getState().scenes, agent),
    [],
  );

  // A removed classmate's class moments go to the lead teacher, or with them;
  // otherwise the engine would skip them silently (their opener is gone)
  const removeMember = (id: string, moments?: RemovedMoments) => {
    if (!moments) {
      remove(id);
      return;
    }
    const { scenes, updateScene } = useStageStore.getState();
    const teacherId = moments === 'teacher' ? leadTeacherId : undefined;
    const after = rewriteAgentMoments(scenes, id, teacherId);
    const before = after.map(({ sceneId }) => ({
      sceneId,
      actions: scenes.find((scene) => scene.id === sceneId)?.actions ?? [],
    }));
    for (const { sceneId, actions } of after) updateScene(sceneId, { actions });
    // Undo brings the classmate back together with their moments
    remove(id, { before, after });
  };

  const handleUpdate = useCallback(
    (id: string, patch: Partial<GeneratedAgentConfig>) => {
      update(id, patch as Parameters<typeof update>[1]);
    },
    [update],
  );

  const handleToggle = (id: string) => {
    select(selectedId === id ? null : id);
  };

  // Reorder indices are within the full roster array
  const classmateGlobalIndex = (localIdx: number) =>
    roster.findIndex((a) => a.id === classmates[localIdx]?.id);

  return (
    <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col">
      {/* Sub-head: title + count on the left; the edit hint, undo/redo and the
          host's close button on the right, all sharing one baseline and one
          ghost-icon skin. */}
      <div className="flex shrink-0 items-center gap-1.5 px-4 pb-1.5 pt-3.5">
        <span className="text-[13px] font-semibold text-foreground">{t('edit.roster.title')}</span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {t('edit.roster.count', { count: roster.length })}
        </span>
        <span className="flex-1" />
        <span className="text-[11px] text-muted-foreground">{t('edit.roster.editHint')}</span>
        <button
          type="button"
          title={t('edit.undo')}
          aria-label={t('edit.undo')}
          disabled={!history.canUndo}
          onClick={history.undo}
          className="ml-1 grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        >
          <Undo2 className="size-3.5" />
        </button>
        <button
          type="button"
          title={t('edit.redo')}
          aria-label={t('edit.redo')}
          disabled={!history.canRedo}
          onClick={history.redo}
          className="grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-30"
        >
          <Redo2 className="size-3.5" />
        </button>
        {headerTrailing}
      </div>

      {upgrading ? (
        <PersonaUpgradePanel
          roster={roster}
          onApply={(personas) => {
            updateMany(personas.map(({ id, persona }) => ({ id, patch: { persona } })));
            setUpgrading(false);
          }}
          onClose={() => setUpgrading(false)}
        />
      ) : (
        /* Scrollable list */
        <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col overflow-y-auto px-3 pb-4">
          {teachers.map((agent) => (
            <TeacherCard
              key={agent.id}
              agent={agent}
              open={selectedId === agent.id}
              onToggle={() => handleToggle(agent.id)}
              onUpdate={handleUpdate}
              readReferences={readReferences}
              registerDraft={registerDraft}
            />
          ))}

          {classmates.length > 0 && (
            <div className="mb-2 flex items-center gap-2 px-0.5">
              <span className="whitespace-nowrap text-[10.5px] font-semibold tracking-[0.04em] text-muted-foreground">
                {t('edit.roster.aiClassmates', { count: classmates.length })}
              </span>
              <div className="flex-1 border-t border-border" />
            </div>
          )}

          {classmates.map((agent, localIdx) => {
            const globalIdx = classmateGlobalIndex(localIdx);
            return (
              <ClassmateCard
                key={agent.id}
                agent={agent}
                open={selectedId === agent.id}
                isFirst={localIdx === 0}
                isLast={localIdx === classmates.length - 1}
                onToggle={() => handleToggle(agent.id)}
                onUpdate={handleUpdate}
                onRemove={removeMember}
                onMoveUp={() => reorder(agent.id, globalIdx - 1)}
                onMoveDown={() => reorder(agent.id, globalIdx + 1)}
                readReferences={readReferences}
                canHandToTeacher={leadTeacherId !== undefined}
                registerDraft={registerDraft}
              />
            );
          })}

          <button
            type="button"
            data-testid="agent-roster-add"
            // `add` selects the new member itself, so the card opens on its own.
            onClick={() => add('student')}
            className="flex w-full items-center justify-center gap-2 rounded-[13px] border-[1.5px] border-dashed border-border py-3 text-[12.5px] text-muted-foreground transition-colors hover:border-primary/50 hover:bg-primary/5 hover:text-primary"
          >
            <UserPlus className="size-4" />
            {t('edit.roster.addRole')}
          </button>

          <button
            type="button"
            data-testid="agent-roster-upgrade"
            disabled={!canUpgradePersonas(roster)}
            title={t('edit.roster.upgrade.actionHint')}
            onClick={() => setUpgrading(true)}
            className="mt-2 flex w-full items-center justify-center gap-1.5 rounded-[13px] py-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-primary/5 hover:text-primary disabled:pointer-events-none disabled:opacity-40"
          >
            <Sparkles className="size-3.5" />
            {t('edit.roster.upgrade.action')}
          </button>
        </div>
      )}
    </div>
  );
}
