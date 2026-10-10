'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChangeEvent, KeyboardEvent } from 'react';
import type { HandState } from '@/lib/playback';
import { useVoiceInput } from './use-voice-input';

/**
 * Outcome of onMessageSend: 'queued' — the question waits for the current line
 * (its bubble shows on delivery); 'blocked' — a question is already waiting, so
 * the text stays in the input; otherwise it was sent.
 */
export type MessageSendResult = 'queued' | 'blocked' | void;

export type InputActivityKind = 'text_input' | 'composition_start' | 'recording_start';

/** How long the "you asked" overlay stays when no answer starts sooner */
const USER_MESSAGE_OVERLAY_MS = 3000;

/**
 * The question the user just sent, shown in place of the current line until
 * the answer starts (or a few seconds pass).
 */
export function useUserMessageOverlay({ hasAgentFeedback }: { hasAgentFeedback: boolean }) {
  const [userMessage, setUserMessage] = useState<string | null>(null);
  const clearTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const prevHasAgentFeedbackRef = useRef(hasAgentFeedback);

  const clearTimer = useCallback(() => {
    if (clearTimerRef.current) {
      clearTimeout(clearTimerRef.current);
      clearTimerRef.current = null;
    }
  }, []);

  const showUserMessage = useCallback(
    (text: string) => {
      setUserMessage(text);
      // Mark as "already seen feedback" so that the immediate thinkingState
      // transition (false→true) after user sends won't trigger the early-clear
      // effect and swallow the user bubble.
      prevHasAgentFeedbackRef.current = true;
      clearTimer();
      clearTimerRef.current = setTimeout(() => {
        setUserMessage(null);
        clearTimerRef.current = null;
      }, USER_MESSAGE_OVERLAY_MS);
    },
    [clearTimer],
  );

  // Clear user message early when agent starts responding
  useEffect(() => {
    const feedbackStarted = hasAgentFeedback && !prevHasAgentFeedbackRef.current;
    if (userMessage && feedbackStarted) {
      clearTimer();
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the overlay yields once the answer's first feedback is committed
      setUserMessage(null);
    }
    prevHasAgentFeedbackRef.current = hasAgentFeedback;
  }, [clearTimer, hasAgentFeedback, userMessage]);

  useEffect(() => () => clearTimer(), [clearTimer]);

  return { userMessage, showUserMessage };
}

export interface UseComposerControllerOptions {
  /** An agent bubble appeared: the send cooldown ends */
  speakingAgentId?: string | null;
  /** Streaming ended: the send cooldown ends (safety net) */
  isStreaming?: boolean;
  /** False while the attached element reference cannot be sent; the text stays */
  canSendMessage?: () => boolean;
  onMessageSend?: (message: string) => MessageSendResult;
  /** A question went out now (not queued): show it until the answer starts */
  onUserMessage?: (text: string) => void;
  /** A question went out, now or queued (not blocked): the input is done with it */
  onSent?: () => void;
  /** Which input opened: voice must pause narration (the mic would record it); text need not */
  onInputActivate?: (kind: 'text' | 'voice') => void;
  onUserInputActivity?: (kind: InputActivityKind) => void;
  onClearElementReference?: () => void;
  /**
   * Text went back into the draft for the user (a returned question, a voice
   * transcript that could not go out, a continued session): an always-visible
   * composer focuses its textarea here, without reporting activation
   */
  onTextInputOpened?: () => void;
  /**
   * A text-less raised hand (engine raiseHand / lowerHand / getHandState).
   * Text sent while the hand waits upgrades it to a question in the owner's
   * onMessageSend (attachQuestion).
   */
  hand?: {
    state: HandState | null;
    onRaise?: () => boolean;
    onLower?: () => boolean;
  };
}

/**
 * The question composer: the draft, the open text / voice surface, the send
 * cooldown, onMessageSend's queued / blocked handling and the textarea's
 * keyboard contract (IME-safe Enter to send, Shift+Enter for a newline).
 */
export function useComposerController({
  speakingAgentId,
  isStreaming,
  canSendMessage,
  onMessageSend,
  onUserMessage,
  onSent,
  onInputActivate,
  onUserInputActivity,
  onClearElementReference,
  onTextInputOpened,
  hand,
}: UseComposerControllerOptions) {
  const [draft, setDraft] = useState('');
  const [isInputOpen, setIsInputOpen] = useState(false);

  // Send cooldown: lock input from "message sent" until "agent bubble appears"
  const [isSendCooldown, setIsSendCooldown] = useState(false);
  const isSendCooldownRef = useRef(false);
  const setSendCooldown = useCallback((next: boolean) => {
    setIsSendCooldown(next);
    isSendCooldownRef.current = next;
  }, []);
  const isSendCoolingDown = useCallback(() => isSendCooldownRef.current, []);

  // Clear send cooldown when agent bubble appears
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the lock follows the owner's speaker prop
    if (isSendCooldown && speakingAgentId) setSendCooldown(false);
  }, [isSendCooldown, setSendCooldown, speakingAgentId]);

  // Safety net: clear cooldown when streaming transitions from active → ended
  // (not when isStreaming was already false — that would clear cooldown immediately)
  const prevStreamingRef = useRef(false);
  useEffect(() => {
    if (prevStreamingRef.current && !isStreaming && isSendCooldown) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reacts to the streaming prop's falling edge
      setSendCooldown(false);
    }
    prevStreamingRef.current = !!isStreaming;
  }, [isStreaming, isSendCooldown, setSendCooldown]);

  /** A send went out: a queued question shows its bubble only once it is delivered. */
  const handleSent = useCallback(
    (text: string, result: MessageSendResult) => {
      if (result !== 'queued') onUserMessage?.(text);
      setSendCooldown(true);
      onSent?.();
    },
    [onSent, onUserMessage, setSendCooldown],
  );

  const voice = useVoiceInput({
    isSendBlocked: isSendCoolingDown,
    canSendMessage,
    onMessageSend,
    onFallbackToDraft: (text) => {
      setDraft(text);
      setIsInputOpen(true);
      onTextInputOpened?.();
    },
    onSent: handleSent,
    onOpen: () => {
      onInputActivate?.('voice');
      onUserInputActivity?.('recording_start');
      setIsInputOpen(false);
    },
  });

  const send = () => {
    if (!draft.trim() || isSendCooldown || canSendMessage?.() === false) return;

    const result = onMessageSend?.(draft);
    // Another question is already waiting — keep this one in the input
    if (result === 'blocked') return;
    // The teacher's current line stays visible while a queued question waits
    handleSent(draft, result);
    setDraft('');
    setIsInputOpen(false);
  };

  /** Open the text input (reporting it) or close it; any voice capture is dropped. */
  const toggleInput = () => {
    if (isSendCooldown) return;
    if (!isInputOpen) {
      onInputActivate?.('text');
    }
    setIsInputOpen(!isInputOpen);
    // Cancel any in-flight ASR to prevent ghost auto-sends
    if (voice.isOpen || voice.isProcessing) {
      voice.cancelRecording();
      voice.setOpen(false);
    }
  };

  /**
   * An always-visible text input took focus: report it like opening one
   * (text keeps the lecture going), except while a send cools down.
   */
  const activateText = () => {
    if (isSendCooldownRef.current) return;
    onInputActivate?.('text');
  };

  /** Show the text input (e.g. a soft-closing session continues) without reporting activation. */
  const openTextInput = () => {
    voice.setOpen(false);
    setIsInputOpen(true);
    onTextInputOpened?.();
  };

  /** Give text back to the reopened input (a cancelled or restored raised hand). */
  const restoreDraft = (text: string) => {
    setSendCooldown(false);
    setDraft(text);
    voice.setOpen(false);
    setIsInputOpen(true);
    onTextInputOpened?.();
  };

  /** Close both inputs and drop any recording in flight (Escape, click outside). */
  const dismiss = () => {
    setIsInputOpen(false);
    voice.dismiss();
  };

  const textareaProps = {
    value: draft,
    onChange: (event: ChangeEvent<HTMLTextAreaElement>) => setDraft(event.target.value),
    onBeforeInput: () => onUserInputActivity?.('text_input'),
    onCompositionStart: () => onUserInputActivity?.('composition_start'),
    onKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends; Shift+Enter is a newline; Enter that commits an IME
      // composition must not send
      if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        send();
      }
    },
  };

  const handState = hand?.state ?? null;
  /** Raise a text-less hand, or lower it; false when the engine refused. */
  const toggleHand = () =>
    handState === null ? (hand?.onRaise?.() ?? false) : (hand?.onLower?.() ?? false);

  return {
    draft,
    setDraft,
    isInputOpen,
    setInputOpen: setIsInputOpen,
    isSendCooldown,
    isSendCoolingDown,
    /** Text or voice input open, or speech still being captured / transcribed */
    isActive: isInputOpen || voice.isOpen || voice.isRecording || voice.isProcessing,
    voice,
    send,
    toggleInput,
    activateText,
    openTextInput,
    restoreDraft,
    dismiss,
    textareaProps,
    clearReference: () => onClearElementReference?.(),
    hand: {
      state: handState,
      isRaised: handState === 'raised',
      isCalled: handState === 'called',
      toggle: toggleHand,
    },
  };
}

export type ComposerController = ReturnType<typeof useComposerController>;
