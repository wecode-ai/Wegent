// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { BookOpenText } from 'lucide-react'
import { ActionButton } from '@/components/ui/action-button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'

interface AddContextButtonProps {
  onClick: () => void
  selectedCount?: number
  triggerVariant?: 'button' | 'menu-item'
}

/**
 * Add Context Button - Button with icon and label that opens knowledge base selector
 * Displays BookOpenText icon with "知识库" label
 * Uses ActionButton for consistent styling with other control buttons
 */
export default function AddContextButton({
  onClick,
  selectedCount = 0,
  triggerVariant = 'button',
}: AddContextButtonProps) {
  const { t } = useTranslation()

  if (triggerVariant === 'menu-item') {
    return (
      <button
        type="button"
        onClick={onClick}
        className="w-full flex items-center justify-between px-3 py-2.5 text-left transition-colors hover:bg-hover active:bg-hover"
      >
        <span className="flex items-center gap-3">
          <BookOpenText className="h-4 w-4 text-text-muted" />
          <span className="text-sm">{t('knowledge:tooltip')}</span>
        </span>
        {selectedCount > 0 && (
          <span className="h-5 min-w-5 rounded-full bg-primary px-1.5 text-[11px] leading-5 text-white text-center">
            {selectedCount}
          </span>
        )}
      </button>
    )
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div>
            <ActionButton
              onClick={onClick}
              icon={<BookOpenText className="h-4 w-4" />}
              label={t('knowledge:tooltip')}
              title={t('knowledge:tooltip')}
            />
          </div>
        </TooltipTrigger>
        <TooltipContent side="top">
          <p>{t('knowledge:tooltip')}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}
