'use client';

import { useCallback, useState } from 'react';
import { toast } from 'sonner';
import { useAudioRecorder } from '@/lib/hooks/use-audio-recorder';
import { useASRAvailable } from '@/lib/hooks/use-asr-available';
import { useI18n } from '@/lib/hooks/use-i18n';
import type { MessageSendResult } from './use-composer-controller';

export interface UseVoiceInputOptions {
  /** A send is cooling down: a transcript arriving now is dropped, not sent twice */
  isSendBlocked: () => boolean;
  canSendMessage?: () => boolean;
  onMessageSend?: (message: string) => MessageSendResult;
  /** The transcript could not go out: put it into the text draft to edit */
  onFallbackToDraft: (text: string) => void;
  /** The transcript went out (sent now, or queued behind the current line) */
  onSent: (text: string, result: MessageSendResult) => void;
  /** Voice is opening: the owner pauses narration (the mic would record it) */
  onOpen?: () => void;
  /**
   * Voice input is over — sent, cancelled, nothing heard, failed, or handed to
   * the draft — so the owner can undo what onOpen did (resume narration)
   */
  onEnd?: () => void;
}

/**
 * Speech input: the recorder, whether ASR is available, the open voice panel
 * and where a transcript goes (sent, queued, or back into the text draft).
 */
export function useVoiceInput({
  isSendBlocked,
  canSendMessage,
  onMessageSend,
  onFallbackToDraft,
  onSent,
  onOpen,
  onEnd,
}: UseVoiceInputOptions) {
  const { t } = useI18n();
  const available = useASRAvailable();
  const [isOpen, setIsOpen] = useState(false);

  const { isRecording, isProcessing, startRecording, stopRecording, cancelRecording } =
    useAudioRecorder({
      onTranscription: (text) => {
        if (!text.trim()) {
          toast.info(t('roundtable.noSpeechDetected'));
          setIsOpen(false);
          onEnd?.();
          return;
        }
        // Block if in send cooldown (e.g. text was sent while voice was processing)
        if (isSendBlocked()) {
          setIsOpen(false);
          onEnd?.();
          return;
        }
        if (canSendMessage?.() === false) {
          onFallbackToDraft(text);
          setIsOpen(false);
          onEnd?.();
          return;
        }
        const result = onMessageSend?.(text);
        if (result === 'blocked') {
          // Another question is already waiting — keep this one editable
          onFallbackToDraft(text);
          setIsOpen(false);
          onEnd?.();
          return;
        }
        onSent(text, result);
        setIsOpen(false);
        onEnd?.();
      },
      onError: (error) => {
        toast.error(error);
        setIsOpen(false);
        onEnd?.();
      },
    });

  /** Open the voice panel and record, or stop recording (which transcribes) and close it. */
  const toggle = useCallback(() => {
    if (isOpen) {
      if (isRecording) {
        stopRecording();
      } else if (!isProcessing) {
        // Nothing to transcribe: voice ends here
        onEnd?.();
      }
      setIsOpen(false);
    } else {
      if (isSendBlocked() || isProcessing) return;
      onOpen?.();
      setIsOpen(true);
      startRecording();
    }
  }, [
    isOpen,
    isProcessing,
    isRecording,
    isSendBlocked,
    onEnd,
    onOpen,
    startRecording,
    stopRecording,
  ]);

  /** Close the panel and drop any recording or transcription in flight. */
  const dismiss = useCallback(() => {
    const wasActive = isOpen || isRecording || isProcessing;
    setIsOpen(false);
    if (isRecording || isProcessing) cancelRecording();
    if (wasActive) onEnd?.();
  }, [cancelRecording, isOpen, isProcessing, isRecording, onEnd]);

  return {
    /** ASR is configured (otherwise the mic control is disabled) */
    available,
    isOpen,
    setOpen: setIsOpen,
    isRecording,
    isProcessing,
    toggle,
    dismiss,
    stopRecording,
    cancelRecording,
  };
}
