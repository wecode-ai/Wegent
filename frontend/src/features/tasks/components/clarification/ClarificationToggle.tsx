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
  triggerVariant?: 'button' | 'menu-item'
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
  triggerVariant = 'button',
}: ClarificationToggleProps) {
  const { t } = useTranslation()

  const handleToggle = () => {
    onToggle(!enabled)
  }

  if (triggerVariant === 'menu-item') {
    return (
      <button
        type="button"
        onClick={handleToggle}
        disabled={disabled}
        data-testid="clarification-toggle"
        className={cn(
          'w-full flex items-center justify-between px-3 py-2.5 text-left transition-colors hover:bg-hover active:bg-hover disabled:opacity-50 disabled:cursor-not-allowed',
          enabled ? 'text-primary' : 'text-text-primary'
        )}
      >
        <span className="flex items-center gap-3">
          <MessageCircleQuestion
            className={cn('h-4 w-4', enabled ? 'text-primary' : 'text-text-muted')}
          />
          <span className="text-sm">{t('chat:clarification_toggle.label')}</span>
        </span>
        {enabled && <span className="h-2 w-2 rounded-full bg-primary" />}
      </button>
    )
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div>
            <ActionButton
              onClick={handleToggle}
              disabled={disabled}
              icon={<MessageCircleQuestion className="h-4 w-4" />}
              label={t('chat:clarification_toggle.label')}
              data-testid="clarification-toggle"
              className={cn(
                'transition-colors',
                enabled
                  ? 'bg-primary/10 text-primary hover:bg-primary/20'
                  : 'text-text-primary hover:bg-hover'
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
