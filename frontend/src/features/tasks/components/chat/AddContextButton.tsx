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
}

/**
 * Add Context Button - Button with icon and label that opens knowledge base selector
 * Displays BookOpenText icon with "知识库" label
 * Uses ActionButton for consistent styling with other control buttons
 */
export default function AddContextButton({ onClick }: AddContextButtonProps) {
  const { t } = useTranslation()

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
