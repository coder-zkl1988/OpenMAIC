'use client';

import {
  Fragment,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from 'react';
import { Hand, Loader2, Mic, MicOff, Quote, Send, Square, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { HandState } from '@/lib/playback';
import {
  useComposerController,
  type InputActivityKind,
  type MessageSendResult,
} from './use-composer-controller';
import {
  useQueuedQuestionEffects,
  type FocusTarget,
  type QueuedQuestionState,
} from './use-queued-question-effects';
import { ComposerStatusRows } from './composer-status-rows';

/** What the shell asks of the panel composer (shortcuts, the stream's "continue") */
export interface ComposerHandle {
  /** Focus the textarea as the user would (T): reports text activation */
  focus: () => void;
  /** Focus the textarea without reporting activation (a soft-closing session continues) */
  openTextInput: () => void;
  /** Start recording, or stop and transcribe (V) */
  toggleVoice: () => void;
  /** Leave the composer (Escape): blur the textarea and drop any recording; the draft stays */
  dismiss: () => void;
  /** 举手 / 放下, as the 举手 slot does (H) */
  toggleHand: () => void;
}

/**
 * A text-less raised hand (HandRaiseFlow.dc.html): raised while the line
 * finishes, then called — the classroom pauses for the learner.
 */
export interface ComposerHand {
  readonly state: HandState | null;
  /** What a raised hand waits for: the line in flight (default) or another step */
  readonly waitsFor?: 'sentence' | 'step';
  /** False when no hand can go up (the engine refused) */
  readonly onRaise: () => boolean;
  /** False when no hand was up */
  readonly onLower: () => boolean;
}

/** The composer reference chip: 互动白板 · 公式 · summary */
export interface ComposerReferenceChip {
  sceneLabel: string;
  elementType: string;
  displaySummary: string;
}

export interface ComposerProps {
  readonly composerRef?: Ref<ComposerHandle>;
  /** An agent bubble appeared: the send cooldown ends */
  readonly speakingAgentId?: string | null;
  readonly isStreaming?: boolean;
  readonly canSendMessage?: () => boolean;
  readonly onMessageSend?: (message: string) => MessageSendResult;
  /** Which input became active: voice pauses narration (the mic would record it); text does not */
  readonly onInputActivate?: (kind: 'text' | 'voice') => void;
  readonly onUserInputActivity?: (kind: InputActivityKind) => void;
  readonly elementReferencePill?: ComposerReferenceChip;
  readonly onClearElementReference?: () => void;
  readonly queuedQuestion?: QueuedQuestionState | null;
  readonly onCancelQueuedQuestion?: () => void;
  /**
   * The bare raised hand behind 举手. Without it 举手 only focuses the
   * textarea (a question sent mid-line still waits for the line).
   */
  readonly hand?: ComposerHand;
  /** Engine getSpeechProgress: the raised hand's progress bar */
  readonly getSpeechProgress?: () => number | null;
  /** The director handed the floor to the learner */
  readonly isCueUser?: boolean;
  /** A Q&A or discussion is open: the learner speaks without raising a hand */
  readonly isLiveSession?: boolean;
  /** The open session is the learner's Q&A: the box invites a follow-up */
  readonly isFollowUp?: boolean;
  /**
   * Composing — recording, or a focused box with a draft: the shell holds
   * auto-advance and treats Escape as closing the composer
   */
  readonly onInteractionChange?: (active: boolean) => void;
  /**
   * A question became the learner's line: sent now, or a raised hand
   * delivered (the fullscreen overlay shows it; the stream has its own bubble)
   */
  readonly onUserMessage?: (text: string) => void;
  /** A question went out, now or queued: the fullscreen card closes */
  readonly onSent?: () => void;
  readonly className?: string;
}

// The textarea grows from three lines (72px) and scrolls past ~seven
const TEXTAREA_MIN_HEIGHT_PX = 72;
export const COMPOSER_TEXTAREA_MAX_HEIGHT_PX = 160;

// The recording row's bars; the reduced-motion fallback is a static scale
function RecordingWave() {
  return (
    <span
      aria-hidden="true"
      className="ml-auto inline-flex h-4 items-center gap-0.5 text-accent-text"
    >
      {[0, 0.12, 0.24, 0.36, 0.48].map((delay) => (
        <i
          key={delay}
          className="block h-4 w-[2.5px] origin-center rounded-[2px] bg-current motion-reduce:scale-y-[0.6] motion-safe:animate-[caption-wave_1s_ease-in-out_infinite]"
          style={{ animationDelay: `${delay}s` }}
        />
      ))}
    </span>
  );
}

const roundButton =
  'flex size-8 shrink-0 items-center justify-center rounded-full transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring/50 active:scale-95';

/**
 * The interaction panel's composer (Classroom.dc.html): an 18px-radius box
 * with the element-reference chip, an always-visible textarea and a bottom
 * row of 举手, voice and send; status rows above it for a raised hand or the
 * learner's cue; recording replaces the textarea.
 *
 * Focusing reports text activation (typing never pauses the lecture),
 * recording reports voice (it pauses it). The shell counts the composer as
 * composing only while it records or a focused box holds a draft: focus
 * that stays after a send, or a draft left in an unfocused box, holds nothing.
 */
export function Composer({
  composerRef,
  speakingAgentId,
  isStreaming,
  canSendMessage,
  onMessageSend,
  onInputActivate,
  onUserInputActivity,
  elementReferencePill,
  onClearElementReference,
  queuedQuestion,
  onCancelQueuedQuestion,
  hand,
  getSpeechProgress,
  isCueUser,
  isLiveSession,
  isFollowUp,
  onInteractionChange,
  onUserMessage,
  onSent,
  className,
}: ComposerProps) {
  const { t } = useI18n();
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const [isFocused, setIsFocused] = useState(false);

  // Programmatic focus that must not count as the user opening the input
  // (a returned draft, a delivered question's follow-up, a continued session)
  const quietFocusRef = useRef(false);
  const focusQuietly = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea || document.activeElement === textarea) return;
    quietFocusRef.current = true;
    textarea.focus();
    // Hidden (collapsed panel, 笔记 tab): no focus event will consume the flag
    if (document.activeElement !== textarea) quietFocusRef.current = false;
  }, []);

  // Focus the textarea once it is shown again: 'quiet' for text handed back
  // (a returned draft, a continued session), 'user' for T over a recording
  const pendingFocusRef = useRef<'quiet' | 'user' | null>(null);
  const controller = useComposerController({
    speakingAgentId,
    isStreaming,
    canSendMessage,
    onMessageSend,
    onUserMessage,
    onSent,
    onInputActivate,
    onUserInputActivity,
    onClearElementReference,
    onTextInputOpened: () => {
      pendingFocusRef.current = 'quiet';
    },
    hand: hand ? { state: hand.state, onRaise: hand.onRaise, onLower: hand.onLower } : undefined,
  });
  const { voice, isSendCooldown } = controller;

  /** Focus as the user would (T): onFocus reports text activation */
  const focusAsUser = useCallback(() => {
    const tryFocus = () => {
      textareaRef.current?.focus();
      return document.activeElement === textareaRef.current;
    };
    // The panel may only now be expanding or switching to 互动
    if (!tryFocus()) requestAnimationFrame(tryFocus);
  }, []);

  useEffect(() => {
    const pending = pendingFocusRef.current;
    if (!pending || !textareaRef.current) return;
    pendingFocusRef.current = null;
    if (pending === 'quiet') focusQuietly();
    else focusAsUser();
  });

  // A delivered question hands a keyboard user on 撤回 to the textarea —
  // quietly, since reporting it would pause the answer that is starting
  const focusTargetRef = useRef<FocusTarget | null>(null);
  const setTextarea = useCallback(
    (node: HTMLTextAreaElement | null) => {
      textareaRef.current = node;
      focusTargetRef.current = node ? { focus: focusQuietly } : null;
    },
    [focusQuietly],
  );
  const {
    statusRef: queuedStatusRef,
    pillRef: queuedRowRef,
    liveText: queuedLiveText,
    isQueued,
    label: queuedLabel,
    handLabel,
    announceHandLowered,
    isHandRaised,
    isHandCalled,
    speechProgress,
  } = useQueuedQuestionEffects({
    queuedQuestion,
    isSendCooldown,
    isSendCoolingDown: controller.isSendCoolingDown,
    // The stream shows the delivered question as the learner's bubble on its own
    onDelivered: (text) => onUserMessage?.(text),
    onReturned: controller.restoreDraft,
    focusTargetRef,
    handState: hand?.state,
    handWaitsFor: hand?.waitsFor,
    isCueUser,
    getSpeechProgress,
  });
  // Called hand or the director's cue: the floor is the learner's
  const isCued = !!isCueUser || isHandCalled;

  /**
   * The 举手 slot. Up: a bare hand while the lecture plays (called at the end
   * of the line; at once when paused or idle) — refused, the textarea takes
   * focus for a question instead. Down: the hand, or the waiting question.
   */
  const raiseHand = () => {
    if (isLiveSession) return;
    if (!hand || !controller.hand.toggle()) textareaRef.current?.focus();
  };
  const withdrawQuestion = () => {
    if (!onCancelQueuedQuestion) return;
    announceHandLowered();
    onCancelQueuedQuestion();
  };
  const lowerHand = () => {
    if (controller.hand.state) {
      if (controller.hand.toggle()) announceHandLowered();
    } else {
      withdrawQuestion();
    }
  };

  const isRecordingSurface = voice.isOpen || voice.isProcessing;
  // Focus alone is not composing: it stays in the box after a send, and an
  // empty focused box must not hold auto-play's scene advance
  const isComposing =
    voice.isOpen ||
    voice.isRecording ||
    voice.isProcessing ||
    (isFocused && controller.draft.trim().length > 0);
  useEffect(() => {
    onInteractionChange?.(isComposing);
    return () => {
      if (isComposing) onInteractionChange?.(false);
    };
  }, [isComposing, onInteractionChange]);

  // Mic, stop and 取消 unmount the control that was activated: carry focus to
  // the recording controls, then back to the textarea, instead of <body>
  const stopButtonRef = useRef<HTMLButtonElement>(null);
  const cancelButtonRef = useRef<HTMLButtonElement>(null);
  const carryFocusRef = useRef(false);
  const noteFocusOn = (control: HTMLElement) => {
    carryFocusRef.current = document.activeElement === control;
  };
  useEffect(() => {
    if (!carryFocusRef.current) return;
    const active = document.activeElement;
    // Only where focus was lost with the control (or sits on 取消 as stop
    // appears) — never take it from elsewhere
    if (active && active !== document.body && active !== cancelButtonRef.current) {
      carryFocusRef.current = false;
      return;
    }
    if (isRecordingSurface) {
      (stopButtonRef.current ?? cancelButtonRef.current)?.focus();
    } else {
      carryFocusRef.current = false;
      focusQuietly();
    }
  }, [focusQuietly, isRecordingSurface, voice.isRecording]);

  // Announced through an always-mounted region: one that mounts with its text is often missed
  const voiceLiveText = voice.isProcessing
    ? t('roundtable.processing')
    : voice.isOpen || voice.isRecording
      ? t('roundtable.listening')
      : '';

  // Grow with the draft between three lines and the cap, then scroll
  useLayoutEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(
      Math.max(textarea.scrollHeight, TEXTAREA_MIN_HEIGHT_PX),
      COMPOSER_TEXTAREA_MAX_HEIGHT_PX,
    )}px`;
  }, [controller.draft, isRecordingSurface]);

  useImperativeHandle(
    composerRef,
    () => ({
      focus: () => {
        // T over a recording drops it and types instead, as the strip's T
        // did; the textarea is focused once it replaces the recording row
        if (voice.isOpen || voice.isProcessing) {
          pendingFocusRef.current = 'user';
          voice.dismiss();
          return;
        }
        focusAsUser();
      },
      openTextInput: controller.openTextInput,
      toggleVoice: () => {
        if (voice.available) voice.toggle();
      },
      dismiss: () => {
        textareaRef.current?.blur();
        controller.dismiss();
      },
      toggleHand: () => {
        if (isQueued || controller.hand.state) lowerHand();
        else raiseHand();
      },
    }),
    // No deps: the controller (and the 举手 slot's handlers) are new each render
  );

  // The 举手 slot reads 放下 while a hand is up: a bare hand (raised or
  // called) or a question waiting for the line
  const handRaised = isQueued || isHandRaised || isHandCalled;
  const canSend = controller.draft.trim().length > 0 && !isSendCooldown;
  const placeholder = isCued
    ? t('stage.composer.cuePlaceholder')
    : isHandRaised
      ? t('stage.composer.raisedPlaceholder')
      : isFollowUp
        ? t('stage.composer.followUpPlaceholder')
        : // A referenced element frames the question (WhiteboardStates.dc.html)
          elementReferencePill
          ? t('stage.composer.referencePlaceholder', { type: elementReferencePill.elementType })
          : t('roundtable.inputPlaceholder');

  return (
    <div
      data-testid="classroom-composer"
      className={cn('shrink-0 border-t border-line bg-background px-3 pt-2.5 pb-3', className)}
    >
      {/* Always mounted: a live region that appears together with its text is
          often not announced. Also where focus parks if the row unmounts under it. */}
      <span
        ref={queuedStatusRef}
        role="status"
        aria-live="polite"
        tabIndex={-1}
        className="sr-only"
      >
        {queuedLiveText}
      </span>
      <span role="status" aria-live="polite" className="sr-only">
        {voiceLiveText}
      </span>
      {/* Everything but the live regions: a host that hides the composer
          (the fullscreen card) hides this and keeps the regions announcing */}
      <div data-composer-body="">
        <ComposerStatusRows
          queuedText={isQueued ? (queuedQuestion?.text ?? '') : isHandRaised ? '' : null}
          queuedKind={isQueued ? 'question' : 'hand'}
          queuedLabel={isQueued ? queuedLabel : handLabel}
          speechProgress={speechProgress}
          onCancelQueued={isQueued ? withdrawQuestion : lowerHand}
          queuedRowRef={queuedRowRef}
          isCueUser={isCued}
        />
        <div
          data-testid="composer-box"
          data-state={isCued ? 'cue' : isRecordingSurface ? 'voice' : 'default'}
          className={cn(
            'flex flex-col gap-1.5 rounded-[18px] border bg-background pt-2.5 pr-2.5 pb-2 pl-3.5 transition-[border-color,box-shadow]',
            isCued
              ? 'border-warning ring-1 ring-warning'
              : isRecordingSurface
                ? 'border-accent-line ring-[3px] ring-accent-soft'
                : 'border-line shadow-xs focus-within:border-line-strong',
          )}
        >
          {elementReferencePill && (
            <div
              data-testid="slide-element-reference-pill"
              className="inline-flex h-7 max-w-full items-center gap-1.5 self-start rounded-full border border-accent-line bg-accent-soft pr-1 pl-2.5 text-xs"
            >
              <Quote aria-hidden="true" className="size-3 shrink-0 fill-accent-text stroke-none" />
              <span className="shrink-0 font-semibold text-accent-hover dark:text-accent-text">
                {elementReferencePill.sceneLabel} · {elementReferencePill.elementType} ·
              </span>
              <span
                className="min-w-0 truncate text-icon"
                title={elementReferencePill.displaySummary}
              >
                {elementReferencePill.displaySummary}
              </span>
              <button
                type="button"
                onClick={controller.clearReference}
                aria-label={t('chat.elementReference.clear')}
                title={t('chat.elementReference.clear')}
                className="flex size-[22px] shrink-0 items-center justify-center rounded-full text-icon transition-colors hover:bg-background hover:text-fg cursor-pointer"
              >
                <X className="size-3 stroke-[2.25]" />
              </button>
            </div>
          )}

          {/* Keyed: the two rows must not share DOM nodes (a reused button
            would keep focus while turning into a different control) */}
          {isRecordingSurface ? (
            <Fragment key="voice">
              <div className="flex min-h-[72px] items-center gap-2.5 pr-1">
                {voice.isProcessing ? (
                  <Loader2
                    aria-hidden="true"
                    className="size-4 shrink-0 animate-spin text-accent-text"
                  />
                ) : (
                  <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-danger" />
                )}
                <span className="text-sm font-semibold text-accent-hover dark:text-accent-text">
                  {voice.isProcessing ? t('roundtable.processing') : t('roundtable.listening')}
                </span>
                {!voice.isProcessing && <RecordingWave />}
              </div>
              <div className="flex items-center gap-1.5">
                <button
                  ref={cancelButtonRef}
                  type="button"
                  aria-label={t('stage.composer.cancelRecording')}
                  onClick={(event) => {
                    noteFocusOn(event.currentTarget);
                    voice.dismiss();
                  }}
                  className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-subtle pr-3 pl-2.5 text-[13px] font-semibold text-fg-secondary transition-colors hover:text-fg cursor-pointer"
                >
                  <X aria-hidden="true" className="size-3.5" />
                  {t('common.cancel')}
                </button>
                {voice.isRecording && (
                  <button
                    ref={stopButtonRef}
                    type="button"
                    aria-label={t('roundtable.stopRecording')}
                    onClick={(event) => {
                      noteFocusOn(event.currentTarget);
                      voice.toggle();
                    }}
                    className={cn(
                      roundButton,
                      'ml-auto bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer',
                    )}
                  >
                    <Square aria-hidden="true" className="size-3 fill-current stroke-none" />
                  </button>
                )}
              </div>
            </Fragment>
          ) : (
            <Fragment key="text">
              <textarea
                ref={setTextarea}
                {...controller.textareaProps}
                aria-label={t('roundtable.textInput')}
                placeholder={placeholder}
                rows={3}
                onFocus={() => {
                  setIsFocused(true);
                  if (quietFocusRef.current) {
                    quietFocusRef.current = false;
                    return;
                  }
                  controller.activateText();
                }}
                onBlur={() => setIsFocused(false)}
                onKeyDown={(event) => {
                  // Escape leaves the box even when the shell does not count it
                  // as composing (an empty draft); an IME's Escape stays its own
                  if (event.key === 'Escape' && !event.nativeEvent.isComposing) {
                    event.currentTarget.blur();
                    return;
                  }
                  controller.textareaProps.onKeyDown(event);
                }}
                className="block min-h-[72px] w-full resize-none overflow-y-auto border-0 bg-transparent pt-0.5 pr-1 text-sm leading-[1.6] text-fg shadow-none outline-none placeholder:text-fg-tertiary focus:ring-0"
                style={{ maxHeight: COMPOSER_TEXTAREA_MAX_HEIGHT_PX }}
              />
              <div className="flex items-center gap-1.5">
                {handRaised ? (
                  <button
                    type="button"
                    data-testid="composer-lower-hand"
                    aria-pressed="true"
                    title={t('stage.composer.lowerHandHint')}
                    onClick={lowerHand}
                    className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-amber-500 pr-3 pl-2.5 text-[13px] font-semibold text-white transition-colors hover:bg-amber-600 cursor-pointer"
                  >
                    <Hand aria-hidden="true" className="size-[15px]" />
                    {t('stage.composer.lowerHand')}
                  </button>
                ) : (
                  <button
                    type="button"
                    data-testid="composer-raise-hand"
                    disabled={isLiveSession}
                    title={
                      isLiveSession
                        ? t('stage.composer.raiseHandInLiveSession')
                        : t('stage.composer.raiseHandHint')
                    }
                    onClick={raiseHand}
                    className="flex h-8 shrink-0 items-center gap-1 rounded-full bg-subtle pr-3 pl-2.5 text-[13px] font-semibold text-fg-secondary transition-colors hover:text-fg disabled:cursor-not-allowed disabled:opacity-40 cursor-pointer"
                  >
                    <Hand aria-hidden="true" className="size-[15px] text-warning" />
                    {t('stage.composer.raiseHand')}
                  </button>
                )}
                <button
                  type="button"
                  aria-label={
                    voice.available
                      ? t('roundtable.voiceInput')
                      : t('roundtable.voiceInputDisabled')
                  }
                  title={
                    voice.available
                      ? t('roundtable.voiceInput')
                      : t('roundtable.voiceInputDisabled')
                  }
                  disabled={!voice.available || isSendCooldown}
                  onClick={(event) => {
                    noteFocusOn(event.currentTarget);
                    voice.toggle();
                  }}
                  className={cn(
                    roundButton,
                    'disabled:cursor-not-allowed disabled:opacity-50',
                    isCued
                      ? 'bg-accent-soft text-accent-text'
                      : 'bg-subtle text-icon enabled:hover:text-fg',
                    voice.available && 'cursor-pointer',
                  )}
                >
                  {voice.available ? (
                    <Mic aria-hidden="true" className="size-4" />
                  ) : (
                    <MicOff aria-hidden="true" className="size-4" />
                  )}
                </button>
                <button
                  type="button"
                  aria-label={t('stage.composer.send')}
                  title={t('stage.composer.send')}
                  disabled={!canSend}
                  // Keep focus in the textarea: sending is not leaving the composer
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={controller.send}
                  className={cn(
                    roundButton,
                    'ml-auto',
                    canSend
                      ? 'bg-primary text-primary-foreground hover:bg-primary/90 cursor-pointer'
                      : 'cursor-not-allowed bg-accent-soft text-accent-text/50',
                  )}
                >
                  {isSendCooldown ? (
                    <Loader2 aria-hidden="true" className="size-4 animate-spin" />
                  ) : (
                    <Send aria-hidden="true" className="size-[15px]" />
                  )}
                </button>
              </div>
            </Fragment>
          )}
        </div>
      </div>
    </div>
  );
}
