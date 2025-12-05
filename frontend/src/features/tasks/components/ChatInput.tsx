// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React, { useState, useMemo } from 'react';
import TextareaAutosize from 'react-textarea-autosize';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
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
  const { t } = useTranslation('chat');
  const placeholderKey = taskType === 'chat' ? 'placeholder.input' : 'placeholder.input';
  const [isComposing, setIsComposing] = useState(false);
  const isMobile = useIsMobile();

  // Get tooltip text for send shortcut
  const tooltipText = useMemo(() => {
    return t('send_shortcut');
  }, [t]);

  const handleCompositionStart = () => {
    setIsComposing(true);
  };

  const handleCompositionEnd = () => {
    setIsComposing(false);
  };

  const handleKeyPress = (e: React.KeyboardEvent) => {
    // Enter sends message, Shift+Enter creates new line
    if (e.key === 'Enter' && !e.shiftKey && !disabled && !isComposing) {
      e.preventDefault();
      handleSendMessage();
    }
    // Shift+Enter creates new line (default behavior, no preventDefault)
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
