// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { Sparkles } from 'lucide-react'
import { ActionButton } from '@/components/ui/action-button'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

interface DeepThinkingToggleProps {
  enabled: boolean
  onToggle: (enabled: boolean) => void
  disabled?: boolean
}

export default function DeepThinkingToggle({
  enabled,
  onToggle,
  disabled = false,
}: DeepThinkingToggleProps) {
  const { t } = useTranslation()

  const handleToggle = () => {
    onToggle(!enabled)
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div>
            <ActionButton
              variant="outline"
              onClick={handleToggle}
              disabled={disabled}
              icon={<Sparkles className="h-4 w-4" />}
              className={cn(
                'transition-colors',
                enabled
                  ? 'border-primary bg-primary/10 text-primary hover:bg-primary/20'
                  : 'border-border bg-base text-text-primary hover:bg-hover'
              )}
            />
          </div>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>{enabled ? t('chat:deep_thinking.disable') : t('chat:deep_thinking.enable')}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
