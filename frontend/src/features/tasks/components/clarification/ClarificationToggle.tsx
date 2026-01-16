// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { MessageCircleQuestion } from 'lucide-react'
import { ActionButton } from '@/components/ui/action-button'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

interface ClarificationToggleProps {
  enabled: boolean
  onToggle: (enabled: boolean) => void
  disabled?: boolean
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
              icon={<MessageCircleQuestion className="h-4 w-4" />}
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
          <p>
            {enabled
              ? t('chat:clarification_toggle.disable')
              : t('chat:clarification_toggle.enable')}
          </p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
