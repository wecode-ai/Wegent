// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useRef, useEffect } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import { useTranslation } from '@/hooks/useTranslation';
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery';

interface ChatInputProps {
  message: string;
  setMessage: (message: string) => void;
  handleSendMessage: () => void;
  isLoading: boolean;
  disabled?: boolean;
  taskType?: 'chat' | 'code';
}

export default function ChatInput({
  message,
  setMessage,
  handleSendMessage,
  disabled = false,
  taskType = 'code',
}: ChatInputProps) {
  const { t } = useTranslation('common');
  const placeholderKey = taskType === 'chat' ? 'chat.placeholder_chat' : 'chat.placeholder_code';
  const [isComposing, setIsComposing] = useState(false);
  const isMobile = useIsMobile();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const handleCompositionStart = () => {
    setIsComposing(true);
  };

  const handleCompositionEnd = () => {
    setIsComposing(false);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    // Mobile: Allow Enter to create new lines, users send via button
    if (isMobile) {
      return;
    }

    // Desktop: Enter sends message, Shift+Enter creates new line
    if (e.key === 'Enter' && !e.shiftKey && !disabled && !isComposing) {
      e.preventDefault();
      handleSendMessage();
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    // Handle Tab key - insert \t placeholder instead of default tab behavior
    if (e.key === 'Tab' && !disabled && !isComposing) {
      e.preventDefault();

      const textarea = e.target as HTMLTextAreaElement;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const value = textarea.value;

      // Insert \t placeholder at cursor position
      const newValue = value.substring(0, start) + '\t' + value.substring(end);

      setMessage(newValue);

      // Set cursor position after the inserted tab
      setTimeout(() => {
        textarea.selectionStart = start + 1;
        textarea.selectionEnd = start + 1;
      }, 0);
      return;
    }

    // Handle Backspace key - remove auto-indented whitespace
    if (e.key === 'Backspace' && !disabled && !isComposing) {
      const textarea = e.target as HTMLTextAreaElement;
      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const value = textarea.value;

      // Only handle when cursor is at a single position (no selection)
      if (start === end && start > 0) {
        // Get the current line and previous character
        const lines = value.substring(0, start).split('\n');
        const currentLine = lines[lines.length - 1];

        // Check if we're at the beginning of a line and the line contains only whitespace
        if (currentLine.trim() === '' && currentLine.length > 0) {
          e.preventDefault();

          // Remove the entire line of whitespace and the newline character
          const previousLines = lines.slice(0, -1);
          const remainingText = value.substring(start);
          const newValue = previousLines.join('\n') + (previousLines.length > 0 ? '\n' : '') + remainingText;

          setMessage(newValue);

          // Set cursor position at the end of the previous line
          const newCursorPos = previousLines.length > 0 ? previousLines.join('\n').length + 1 : 0;
          setTimeout(() => {
            textarea.selectionStart = newCursorPos;
            textarea.selectionEnd = newCursorPos;
          }, 0);
          return;
        }

        // Check if we're deleting whitespace that was auto-indented
        const charBeforeCursor = value.substring(start - 1, start);
        if (charBeforeCursor === ' ' || charBeforeCursor === '\t') {
          // Get the line start position
          const lineStart = value.lastIndexOf('\n', start - 1) + 1;
          const lineContent = value.substring(lineStart, start);

          // If the line contains only whitespace up to cursor, remove all whitespace
          if (lineContent.trim() === '') {
            e.preventDefault();
            const newValue = value.substring(0, lineStart) + value.substring(start);
            setMessage(newValue);

            setTimeout(() => {
              textarea.selectionStart = lineStart;
              textarea.selectionEnd = lineStart;
            }, 0);
            return;
          }
        }
      }
    }

    // Handle Enter key for auto-indentation
    if (e.key === 'Enter' && !disabled && !isComposing) {
      // Desktop: Enter sends message, Shift+Enter creates new line
      if (!isMobile && !e.shiftKey) {
        e.preventDefault();
        handleSendMessage();
        return;
      }

      // Mobile: Enter creates new line with auto-indentation
      // Desktop: Shift+Enter creates new line with auto-indentation
      if (isMobile || e.shiftKey) {
        e.preventDefault();

        const textarea = e.target as HTMLTextAreaElement;
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        const value = textarea.value;

        // Get the current line and its leading whitespace
        const lines = value.substring(0, start).split('\n');
        const currentLine = lines[lines.length - 1];
        const leadingWhitespace = currentLine.match(/^\s*/)?.[0] || '';

        // Insert new line with preserved indentation
        const newValue = value.substring(0, start) + '\n' + leadingWhitespace + value.substring(end);

        setMessage(newValue);

        // Set cursor position after the inserted whitespace
        setTimeout(() => {
          textarea.selectionStart = start + 1 + leadingWhitespace.length;
          textarea.selectionEnd = start + 1 + leadingWhitespace.length;
        }, 0);
        return;
      }
    }
  };

  const handleInsertTab = () => {
    if (disabled || isComposing) return;

    const textarea = textareaRef.current;
    if (!textarea) return;

    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;

    // Insert \t placeholder at cursor position
    const newValue = value.substring(0, start) + '\t' + value.substring(end);

    setMessage(newValue);

    // Set cursor position after inserted tab
    setTimeout(() => {
      textarea.selectionStart = start + 1;
      textarea.selectionEnd = start + 1;
      textarea.focus();
    }, 0);
  };

  // Auto-focus on mount
  useEffect(() => {
    if (textareaRef.current && !disabled) {
      textareaRef.current.focus();
    }
  }, [disabled]);

  return (
    <div className="w-full" data-tour="task-input">
      <TextareaAutosize
        ref={textareaRef}
        value={message}
        onChange={e => {
          if (!disabled) setMessage(e.target.value);
        }}
        onKeyDown={handleKeyDown}
        onKeyPress={handleKeyPress}
        onCompositionStart={handleCompositionStart}
        onCompositionEnd={handleCompositionEnd}
        placeholder={t(placeholderKey)}
        className={`w-full p-3 bg-transparent custom-scrollbar text-text-primary text-base placeholder:text-text-muted placeholder:text-base focus:outline-none data-[focus]:outline-none ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
        disabled={disabled}
        minRows={isMobile ? 2 : 3}
        maxRows={isMobile ? 6 : 8}
        style={{ resize: 'none', overflow: 'auto', whiteSpace: 'pre-wrap', wordWrap: 'break-word' }}
      />
      {/* Mobile toolbar with Tab button */}
      {isMobile && (
        <div className="flex justify-end mt-2 px-1">
          <button
            onClick={handleInsertTab}
            disabled={disabled}
            className="px-3 py-1 text-sm bg-gray-100 hover:bg-gray-200 dark:bg-gray-700 dark:hover:bg-gray-600 rounded-md transition-colors disabled:opacity-50 disabled:cursor-not-allowed text-text-primary"
          >
            Tab
          </button>
        </div>
      )}
    </div>
  );
}
