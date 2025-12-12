// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useMemo, useRef, useEffect } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useTranslation } from '@/hooks/useTranslation';
import { useIsMobile } from '@/features/layout/hooks/useMediaQuery';
import { useUser } from '@/features/common/UserContext';

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
}

export default function ChatInput({
  message,
  setMessage,
  handleSendMessage,
  disabled = false,
  taskType = 'code',
  autoFocus = false,
  canSubmit = true,
}: ChatInputProps) {
  const { t } = useTranslation('chat');
  const placeholderKey = taskType === 'chat' ? 'placeholder.input' : 'placeholder.input';
  const [isComposing, setIsComposing] = useState(false);
  // Track if composition just ended (for Safari where compositionend fires before keydown)
  const compositionJustEndedRef = useRef(false);
  const isMobile = useIsMobile();
  const { user } = useUser();
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto focus the input when autoFocus is true and not disabled
  useEffect(() => {
    if (autoFocus && !disabled && textareaRef.current) {
      // Use setTimeout to ensure the DOM is fully rendered
      const timer = setTimeout(() => {
        textareaRef.current?.focus();
      }, 100);
      return () => clearTimeout(timer);
    }
  }, [autoFocus, disabled]);

  // Get user's send key preference (default to 'enter')
  const sendKey = user?.preferences?.send_key || 'enter';

  // Check if running on Mac
  const isMac = useMemo(() => {
    if (typeof window !== 'undefined') {
      return navigator.platform.toUpperCase().indexOf('MAC') >= 0;
    }
    return false;
  }, []);

  // Get tooltip text for send shortcut based on user preference
  const tooltipText = useMemo(() => {
    if (sendKey === 'cmd_enter') {
      return isMac ? t('send_shortcut_cmd_enter_mac') : t('send_shortcut_cmd_enter_win');
    }
    return t('send_shortcut');
  }, [t, sendKey, isMac]);

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

  const handleKeyPress = (e: React.KeyboardEvent) => {
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

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div className="w-full" data-tour="task-input">
            <TextareaAutosize
              ref={textareaRef}
              value={message}
              onChange={e => {
                if (!disabled) setMessage(e.target.value);
              }}
              onKeyDown={handleKeyPress}
              onCompositionStart={handleCompositionStart}
              onCompositionEnd={handleCompositionEnd}
              placeholder={t(placeholderKey)}
              className={`w-full px-3 py-2 bg-transparent custom-scrollbar text-text-primary text-base placeholder:text-text-muted placeholder:text-base focus:outline-none data-[focus]:outline-none ${disabled ? 'opacity-50 cursor-not-allowed' : ''}`}
              disabled={disabled}
              minRows={isMobile ? 2 : 1}
              maxRows={isMobile ? 6 : 8}
              style={{ resize: 'none', overflow: 'auto' }}
            />
          </div>
        </TooltipTrigger>
        <TooltipContent side="top" align="start">
          <p>{tooltipText}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
