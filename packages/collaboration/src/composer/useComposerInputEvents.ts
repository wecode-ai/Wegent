import { useRef, useState, type RefObject } from "react";
import { isImeComposingEvent, isImeEnterEvent } from "@wegent/chat-core/ime";
import type {
  ComposerEditorHandle,
  ComposerEditorSnapshot,
} from "./ComposerProseMirrorEditor";
import { findComposerMentionDeletionRange } from "./composerMentions";
import {
  primaryComposerSubmitOptions,
  type ComposerFollowUpBehavior,
  type ComposerSubmitOptions,
} from "./composerInputTypes";
import { textMetrics } from "./composerInputDiagnostics";

export interface ComposerAutocompleteEvents {
  isOpen: () => boolean;
  optionCount: () => number;
  move: (direction: number) => boolean;
  close: () => void;
  confirm: () => boolean;
  debugDetails?: () => Record<string, unknown>;
}

export interface ComposerInputEventsProps {
  editorRef: RefObject<ComposerEditorHandle | null>;
  valueRef: RefObject<string>;
  onSubmit: (value: string, options?: ComposerSubmitOptions) => void;
  canSend: boolean;
  sendKey?: "enter" | "cmd_enter";
  isStreaming?: boolean;
  followUpBehavior?: ComposerFollowUpBehavior;
  onKeyDown?: (
    event: KeyboardEvent,
    snapshot: ComposerEditorSnapshot,
  ) => boolean | void;
  onKeyUp?: () => void;
  onSnapshotChange?: (snapshot: ComposerEditorSnapshot) => void;
  onBlur?: () => void;
  onCompositionStart?: () => void;
  onCompositionEnd?: () => void;
  autocomplete?: ComposerAutocompleteEvents;
  debug?: (event: string, details: Record<string, unknown>) => void;
}

/** Shared native editor input policy. Hosts only supply menu and submission actions. */
export function useComposerInputEvents({
  editorRef,
  valueRef,
  onSubmit,
  canSend,
  sendKey = "enter",
  isStreaming = false,
  followUpBehavior = "queue",
  onKeyDown,
  onKeyUp,
  onSnapshotChange,
  onBlur,
  onCompositionStart,
  onCompositionEnd,
  autocomplete,
  debug,
}: ComposerInputEventsProps) {
  const [isComposing, setIsComposing] = useState(false);
  const suppressEnterUntilKeyUpRef = useRef(false);

  const handleCompositionStart = () => {
    setIsComposing(true);
    onCompositionStart?.();
    debug?.("composition-start", {
      propValue: textMetrics(valueRef.current),
      suppressEnterUntilKeyUp: suppressEnterUntilKeyUpRef.current,
    });
  };
  const handleCompositionEnd = () => {
    setIsComposing(false);
    suppressEnterUntilKeyUpRef.current = true;
    onCompositionEnd?.();
    debug?.("composition-end", {
      propValue: textMetrics(valueRef.current),
      suppressEnterUntilKeyUp: suppressEnterUntilKeyUpRef.current,
    });
  };
  const handleKeyUp = (event: KeyboardEvent) => {
    if (suppressEnterUntilKeyUpRef.current) {
      suppressEnterUntilKeyUpRef.current = false;
      debug?.("keyup-clear-composition-enter-suppression", {
        key: event.key,
        propValue: textMetrics(valueRef.current),
      });
    }
    onKeyUp?.();
  };
  const handleEditorSnapshot = (snapshot: ComposerEditorSnapshot) => {
    valueRef.current = snapshot.value;
    onSnapshotChange?.(snapshot);
  };
  const handleEditorBeforeInput = (event: InputEvent) =>
    (event.inputType === "insertParagraph" ||
      event.inputType === "insertLineBreak") &&
    suppressEnterUntilKeyUpRef.current;

  const handleEditorKeyDown = (
    event: KeyboardEvent,
    snapshot: ComposerEditorSnapshot,
  ): boolean => {
    const delegateKeyDown = () => {
      if (!onKeyDown?.(event, snapshot)) return false;
      event.preventDefault();
      event.stopPropagation();
      return true;
    };
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!autocomplete?.isOpen() || autocomplete.optionCount() <= 0)
        return false;
      event.preventDefault();
      return autocomplete.move(event.key === "ArrowDown" ? 1 : -1);
    }
    if (event.key === "Escape") {
      if (!autocomplete?.isOpen()) return delegateKeyDown();
      event.preventDefault();
      autocomplete.close();
      return true;
    }
    if (event.key === "Tab" && !event.shiftKey) {
      if (isComposing || isImeComposingEvent(event)) return false;
      if (!autocomplete?.isOpen() || !autocomplete.confirm()) return false;
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
    if (event.key === "Enter") {
      debug?.("keydown-enter", {
        shiftKey: event.shiftKey,
        canSend,
        stateIsComposing: isComposing,
        nativeIsComposing: event.isComposing,
        suppressEnterUntilKeyUp: suppressEnterUntilKeyUpRef.current,
        ...autocomplete?.debugDetails?.(),
        domValue: textMetrics(snapshot.value),
      });
      if (isComposing || isImeEnterEvent(event) || isImeComposingEvent(event)) {
        suppressEnterUntilKeyUpRef.current = true;
        return false;
      }
      if (suppressEnterUntilKeyUpRef.current) {
        event.preventDefault();
        return true;
      }
      if (autocomplete?.confirm()) {
        suppressEnterUntilKeyUpRef.current = true;
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
      const modifierPressed = event.metaKey || event.ctrlKey;
      if (sendKey === "cmd_enter") {
        if (!modifierPressed) {
          event.preventDefault();
          return editorRef.current?.insertLineBreak() ?? false;
        }
      } else if (event.shiftKey && !modifierPressed) {
        return false;
      }
      event.preventDefault();
      if (snapshot.value.trim().length > 0 || canSend) {
        onSubmit(
          snapshot.value,
          modifierPressed && event.shiftKey
            ? { interruptWhenBusy: true }
            : primaryComposerSubmitOptions(isStreaming, followUpBehavior),
        );
      }
      return true;
    }
    if (event.key !== "Backspace" && event.key !== "Delete")
      return delegateKeyDown();
    const range = findComposerMentionDeletionRange(
      snapshot.value,
      snapshot.selectionStart,
      snapshot.selectionEnd,
      event.key,
    );
    if (!range) return delegateKeyDown();
    event.preventDefault();
    editorRef.current?.setValue(
      snapshot.value.slice(0, range.start) + snapshot.value.slice(range.end),
      range.cursor,
    );
    return true;
  };
  return {
    handleCompositionStart,
    handleCompositionEnd,
    handleKeyUp,
    handleEditorSnapshot,
    handleEditorBeforeInput,
    handleEditorKeyDown,
    handleBlur: () => onBlur?.(),
  };
}
