// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery';
import { useUser } from '@/features/common/UserContext';
import type { ChatTipItem } from '@/types/api';

interface ChatInputProps {
  message: string;
  setMessage: (message: string) => void;
  handleSendMessage: () => void;
  isLoading: boolean;
  disabled?: boolean;
  taskType?: 'chat' | 'code';
  autoFocus?: boolean;
  // Controls whether the message can be submitted (e.g., model selection required)
  canSubmit?: boolean;
  tipText?: ChatTipItem | null;
  // Optional badge element to render inline with text
  badge?: React.ReactNode;
}

export default function ChatInput({
  message,
  setMessage,
  handleSendMessage,
  disabled = false,
  taskType: _taskType = 'code',
  autoFocus = false,
  canSubmit = true,
  tipText,
  badge,
}: ChatInputProps) {
  const { t, i18n } = useTranslation('chat');

  // Get current language for tip text
  const currentLang = i18n.language?.startsWith('zh') ? 'zh' : 'en';

  // Use tip text as placeholder if available, otherwise use default
  const placeholder = useMemo(() => {
    if (tipText) {
      return tipText[currentLang] || tipText.en || t('placeholder.input');
    }
    return t('placeholder.input');
  }, [tipText, currentLang, t]);
  const [isComposing, setIsComposing] = useState(false);
  // Track if composition just ended (for Safari where compositionend fires before keydown)
  const compositionJustEndedRef = useRef(false);
  const isMobile = useIsMobile();
  const { user } = useUser();
  const editableRef = useRef<HTMLDivElement>(null);
  const badgeRef = useRef<HTMLSpanElement>(null);
  const [badgeWidth, setBadgeWidth] = useState(0);

  // Track if we should show placeholder
  const [showPlaceholder, setShowPlaceholder] = useState(!message);

  // Update placeholder visibility when message changes externally
  useEffect(() => {
    setShowPlaceholder(!message);
  }, [message]);

  // Measure badge width for text-indent
  useEffect(() => {
    if (badgeRef.current && badge) {
      // Add some margin (6px = mr-1.5)
      setBadgeWidth(badgeRef.current.offsetWidth + 8);
    } else {
      setBadgeWidth(0);
    }
  }, [badge]);

  // Sync contenteditable content with message prop
  useEffect(() => {
    if (editableRef.current && editableRef.current.textContent !== message) {
      // Only update if different to avoid cursor jumping
      const selection = window.getSelection();
      const hadFocus = document.activeElement === editableRef.current;

      editableRef.current.textContent = message;

      // Restore cursor to end if had focus
      if (hadFocus && selection && message) {
        const range = document.createRange();
        range.selectNodeContents(editableRef.current);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  }, [message]);

  // Auto focus the input when autoFocus is true and not disabled
  useEffect(() => {
    if (autoFocus && !disabled && editableRef.current) {
      // Use setTimeout to ensure the DOM is fully rendered
      const timer = setTimeout(() => {
        editableRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [autoFocus, disabled]);

  // Get user's send key preference (default to 'enter')
  const sendKey = user?.preferences?.send_key || 'enter';

  const handleCompositionStart = () => {
    setIsComposing(true);
    compositionJustEndedRef.current = false;
  };

  const handleCompositionEnd = () => {
    setIsComposing(false);
    // Set flag to indicate composition just ended
    // This handles Safari where compositionend fires before keydown
    compositionJustEndedRef.current = true;
    // Clear the flag after a short delay to allow normal Enter key behavior
    setTimeout(() => {
      compositionJustEndedRef.current = false;
    }, 100);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    // Check multiple conditions for IME compatibility:
    // 1. isComposing state - tracks composition via React state
    // 2. nativeEvent.isComposing - native browser flag (more reliable in some browsers)
    // 3. compositionJustEndedRef - handles Safari where compositionend fires before keydown
    //    This prevents the Enter key that confirms IME selection from also sending the message
    if (disabled || isComposing || e.nativeEvent.isComposing || compositionJustEndedRef.current)
      return;

    // On mobile, Enter always creates new line (no easy Shift+Enter on mobile keyboards)
    // Users can tap the send button to send messages

    if (sendKey === 'cmd_enter') {
      // Cmd/Ctrl+Enter sends message, Enter creates new line
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        // Check if submission is allowed (e.g., model is selected when required)
        if (canSubmit) {
          handleSendMessage();
        }
      }
      // Enter without modifier creates new line (default behavior)
    } else {
      if (isMobile) {
        return;
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        // Check if submission is allowed (e.g., model is selected when required)
        if (canSubmit) {
          handleSendMessage();
        }
      }
      // Shift+Enter creates new line (default behavior, no preventDefault)
    }
  };

  const handleInput = useCallback(
    (e: React.FormEvent<HTMLDivElement>) => {
      if (disabled) return;
      const text = e.currentTarget.textContent || '';
      setMessage(text);
      setShowPlaceholder(!text);
    },
    [disabled, setMessage]
  );

  const handleFocus = useCallback(() => {
    // Move cursor to end on focus
    if (editableRef.current) {
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(editableRef.current);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    }
  }, []);

  // Calculate min height based on device
  const minHeight = isMobile ? '3.5rem' : '1.75rem';
  const maxHeight = isMobile ? '9rem' : '12rem';

  return (
    <div className="w-full relative" data-tour="task-input">
      {/* Badge - positioned absolutely, not editable */}
      {badge && (
        <span
          ref={badgeRef}
          className="absolute left-0 top-2 z-10 pointer-events-auto"
          style={{ userSelect: 'none' }}
        >
          {badge}
        </span>
      )}

      {/* Placeholder - shown when empty */}
      {showPlaceholder && (
        <div
          className="absolute pointer-events-none text-text-muted text-base"
          style={{
            top: '0.5rem',
            left: badge ? `${badgeWidth}px` : '0',
          }}
        >
          {placeholder}
        </div>
      )}

      {/* Editable content area */}
      <div
        ref={editableRef}
        contentEditable={!disabled}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        onFocus={handleFocus}
        className={`w-full py-2 bg-transparent custom-scrollbar text-text-primary text-base focus:outline-none ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        style={{
          minHeight,
          maxHeight,
          overflowY: 'auto',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
          // Use text-indent for first line to make room for badge
          textIndent: badge ? `${badgeWidth}px` : '0',
        }}
        suppressContentEditableWarning
      />
    </div>
  );
}
