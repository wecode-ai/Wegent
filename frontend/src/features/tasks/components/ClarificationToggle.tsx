// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React from 'react';
import { MessageCircleQuestion } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/hooks/useTranslation';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface ClarificationToggleProps {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  disabled?: boolean;
}

/**
 * ClarificationToggle component for enabling/disabling clarification mode.
 *
 * When enabled, the system will append clarification-related prompts to the
 * system prompt, allowing the AI to ask clarifying questions before proceeding.
 */
export default function ClarificationToggle({
  enabled,
  onToggle,
  disabled = false,
}: ClarificationToggleProps) {
  const { t } = useTranslation('chat');

  const handleToggle = () => {
    onToggle(!enabled);
  };

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            onClick={handleToggle}
            disabled={disabled}
            className={cn(
              'h-8 w-8 rounded-lg flex-shrink-0 transition-colors',
              enabled
                ? 'bg-primary/10 text-primary hover:bg-primary/20'
                : 'text-text-muted hover:bg-surface hover:text-text-primary'
            )}
          >
            <MessageCircleQuestion className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>{enabled ? t('clarification_toggle.disable') : t('clarification_toggle.enable')}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
