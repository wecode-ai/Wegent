// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useMemo } from 'react';
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
}

export default function ChatInput({
  message,
  setMessage,
  handleSendMessage,
  disabled = false,
  taskType = 'code',
}: ChatInputProps) {
  const { t } = useTranslation('chat');
  const placeholderKey = taskType === 'chat' ? 'placeholder.input' : 'placeholder.input';
  const [isComposing, setIsComposing] = useState(false);
  const isMobile = useIsMobile();
  const { user } = useUser();

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
  };

  const handleCompositionEnd = () => {
    setIsComposing(false);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    if (disabled || isComposing) return;

    // On mobile, Enter always creates new line (no easy Shift+Enter on mobile keyboards)
    // Users can tap the send button to send messages

    if (sendKey === 'cmd_enter') {
      // Cmd/Ctrl+Enter sends message, Enter creates new line
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        handleSendMessage();
      }
      // Enter without modifier creates new line (default behavior)
    } else {
      if (isMobile) {
        return;
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        handleSendMessage();
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
