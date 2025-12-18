// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery';
import { useUser } from '@/features/common/UserContext';
import type { ChatTipItem } from '@/types/api';
import MentionAutocomplete from './chat/MentionAutocomplete';

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
  // Group chat support
  isGroupChat?: boolean;
  teamName?: string;
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
  isGroupChat = false,
  teamName = '',
}: ChatInputProps) {
  const { t, i18n } = useTranslation('chat');

  // Get current language for tip text
  const currentLang = i18n.language?.startsWith('zh') ? 'zh' : 'en';

  // Use tip text as placeholder if available, otherwise use default
  const placeholder = useMemo(() => {
    if (tipText) {
      return tipText[currentLang] || tipText.en || t('placeholder.input');
    }
    // For group chat, show mention instruction
    if (isGroupChat && teamName) {
      return t('groupChat.mentionToTrigger', { teamName });
    }
    return t('placeholder.input');
  }, [tipText, currentLang, t, isGroupChat, teamName]);
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

  // Mention autocomplete state
  const [showMentionMenu, setShowMentionMenu] = useState(false);
  const [mentionMenuPosition, setMentionMenuPosition] = useState({ top: 0, left: 0 });

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

  // Helper function to extract text with preserved newlines from contentEditable
  const getTextWithNewlines = useCallback((element: HTMLElement): string => {
    let text = '';
    const childNodes = element.childNodes;

    for (let i = 0; i < childNodes.length; i++) {
      const node = childNodes[i];

      if (node.nodeType === Node.TEXT_NODE) {
        text += node.textContent || '';
      } else if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        const tagName = el.tagName.toLowerCase();

        // Handle <br> as newline
        if (tagName === 'br') {
          text += '\n';
        } else if (tagName === 'div' || tagName === 'p') {
          // Handle block elements (div, p) - add newline before if not first and has content
          if (text && !text.endsWith('\n')) {
            text += '\n';
          }
          text += getTextWithNewlines(el);
        } else {
          // For other elements, recursively get text
          text += getTextWithNewlines(el);
        }
      }
    }

    return text;
  }, []);

  // Helper function to set innerHTML with newlines converted to <br> tags
  const setContentWithNewlines = useCallback((element: HTMLElement, text: string) => {
    // Convert newlines to <br> tags for proper display in contentEditable
    // Use innerHTML to properly render the <br> tags
    const htmlContent = text
      .split('\n')
      .map(line => {
        // Escape HTML entities to prevent XSS
        const escaped = line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return escaped;
      })
      .join('<br>');
    element.innerHTML = htmlContent;
  }, []);

  // Sync contenteditable content with message prop
  useEffect(() => {
    if (editableRef.current) {
      // Get current content with newlines preserved
      const currentContent = getTextWithNewlines(editableRef.current);
      if (currentContent !== message) {
        // Only update if different to avoid cursor jumping
        const selection = window.getSelection();
        const hadFocus = document.activeElement === editableRef.current;

        setContentWithNewlines(editableRef.current, message);

        // Restore cursor to end if had focus
        if (hadFocus && selection && message) {
          const range = document.createRange();
          range.selectNodeContents(editableRef.current);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }
    }
  }, [message, getTextWithNewlines, setContentWithNewlines]);

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
      const text = getTextWithNewlines(e.currentTarget);
      setMessage(text);
      setShowPlaceholder(!text);

      // Check for @ trigger in group chat mode
      if (isGroupChat && teamName) {
        const lastChar = text[text.length - 1];
        if (lastChar === '@') {
          // Get cursor position to show autocomplete menu
          const selection = window.getSelection();
          if (selection && selection.rangeCount > 0) {
            const range = selection.getRangeAt(0);
            const rect = range.getBoundingClientRect();
            const containerRect = editableRef.current?.getBoundingClientRect();

            if (containerRect) {
              setMentionMenuPosition({
                top: rect.bottom - containerRect.top + 4,
                left: rect.left - containerRect.left,
              });
              setShowMentionMenu(true);
            }
          }
        } else if (showMentionMenu) {
          // Close menu if user continues typing after @
          const words = text.split(/\s/);
          const lastWord = words[words.length - 1];
          if (!lastWord.startsWith('@')) {
            setShowMentionMenu(false);
          }
        }
      }
    },
    [disabled, setMessage, getTextWithNewlines, isGroupChat, teamName, showMentionMenu]
  );

  // Handle mention selection
  const handleMentionSelect = useCallback(
    (mention: string) => {
      if (editableRef.current) {
        const currentText = getTextWithNewlines(editableRef.current);
        // Replace the last @ with the selected mention
        const newText = currentText.replace(/@$/, mention + ' ');
        setMessage(newText);
        setContentWithNewlines(editableRef.current, newText);

        // Move cursor to end
        const selection = window.getSelection();
        if (selection && editableRef.current) {
          const range = document.createRange();
          range.selectNodeContents(editableRef.current);
          range.collapse(false);
          selection.removeAllRanges();
          selection.addRange(range);
        }

        // Focus back to input
        editableRef.current.focus();
      }
    },
    [getTextWithNewlines, setMessage, setContentWithNewlines]
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLDivElement>) => {
      e.preventDefault();
      if (disabled) return;

      // Get plain text from clipboard, stripping all formatting and invisible characters
      const clipboardData = e.clipboardData;
      let pastedText = clipboardData.getData('text/plain');

      // Remove invisible/control characters that can break layout
      // This includes: zero-width spaces, zero-width joiners, direction marks, etc.
      // Keep normal whitespace (space, tab, newline) but remove problematic Unicode characters
      pastedText = pastedText.replace(/[\u200B-\u200D\u2028\u2029\uFEFF\u00A0\u2060\u180E]/g, '');

      // Get current selection
      const selection = window.getSelection();
      if (!selection || selection.rangeCount === 0) return;

      const range = selection.getRangeAt(0);
      range.deleteContents();

      // Insert plain text node
      const textNode = document.createTextNode(pastedText);
      range.insertNode(textNode);

      // Move cursor to end of inserted text
      range.setStartAfter(textNode);
      range.setEndAfter(textNode);
      selection.removeAllRanges();
      selection.addRange(range);

      // Update message state - use getTextWithNewlines to preserve newlines
      if (editableRef.current) {
        const newText = getTextWithNewlines(editableRef.current);
        setMessage(newText);
        setShowPlaceholder(!newText);
      }
    },
    [disabled, setMessage, getTextWithNewlines]
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

      {/* Mention autocomplete menu */}
      {showMentionMenu && isGroupChat && teamName && (
        <MentionAutocomplete
          teamName={teamName}
          onSelect={handleMentionSelect}
          onClose={() => setShowMentionMenu(false)}
          position={mentionMenuPosition}
        />
      )}

      {/* Scrollable container that includes both badge and editable content */}
      <div
        className="w-full custom-scrollbar"
        style={{
          minHeight,
          maxHeight,
          overflowY: 'auto',
        }}
      >
        {/* Inner content wrapper with badge and text */}
        <div className="relative">
          {/* Badge - positioned absolutely so it doesn't affect text flow */}
          {badge && (
            <span
              ref={badgeRef}
              className="absolute left-0 top-2 pointer-events-auto z-10"
              style={{ userSelect: 'none' }}
            >
              {badge}
            </span>
          )}

          {/* Editable content area */}
          <div
            ref={editableRef}
            contentEditable={!disabled}
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            onCompositionStart={handleCompositionStart}
            onCompositionEnd={handleCompositionEnd}
            onFocus={handleFocus}
            data-testid="message-input"
            className={`w-full py-2 bg-transparent text-text-primary text-base focus:outline-none ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
            style={{
              minHeight,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              // Use text-indent for first line to leave space for badge
              // Subsequent lines will start from the left edge
              textIndent: badge ? `${badgeWidth}px` : 0,
            }}
            suppressContentEditableWarning
          />
        </div>
      </div>
    </div>
  );
}
