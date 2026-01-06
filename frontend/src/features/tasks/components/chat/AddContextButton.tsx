// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import React from 'react'
import { ActionButton } from '@/components/ui/action-button'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'

interface AddContextButtonProps {
  onClick: () => void
}

/**
 * Add Context Button - Icon-only button that opens knowledge base selector
 * Always displays "#" symbol with tooltip on hover
 * Uses ActionButton for consistent 36px size with other control buttons
 */
export default function AddContextButton({ onClick }: AddContextButtonProps) {
  const { t } = useTranslation()

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <div>
            <ActionButton
              variant="outline"
              onClick={onClick}
              icon={<span className="text-base font-medium text-text-primary">#</span>}
              title={t('knowledge:tooltip')}
              className="border-border bg-base text-text-primary hover:bg-hover"
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
