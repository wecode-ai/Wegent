// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client';

import React from 'react';
import { Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useTranslation } from '@/hooks/useTranslation';
import { cn } from '@/lib/utils';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';

interface DeepThinkingToggleProps {
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  disabled?: boolean;
}

export default function DeepThinkingToggle({
  enabled,
  onToggle,
  disabled = false,
}: DeepThinkingToggleProps) {
  const { t } = useTranslation('chat');

  const handleToggle = () => {
    onToggle(!enabled);
  };

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            onClick={handleToggle}
            disabled={disabled}
            className={cn(
              'h-8 w-8 rounded-full flex-shrink-0 transition-colors',
              enabled
                ? 'border-primary bg-primary/10 text-primary hover:bg-primary/20'
                : 'border-border bg-base text-text-primary hover:bg-hover'
            )}
          >
            <Sparkles className="h-4 w-4" />
          </Button>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>{enabled ? t('deep_thinking.disable') : t('deep_thinking.enable')}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
