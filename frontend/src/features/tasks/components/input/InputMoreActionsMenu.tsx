// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import { ActionButton } from '@/components/ui/action-button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import ClarificationToggle from '../clarification/ClarificationToggle'
import CorrectionModeToggle from '../CorrectionModeToggle'
import { useTranslation } from '@/hooks/useTranslation'

interface InputMoreActionsMenuProps {
  showClarification: boolean
  enableClarification: boolean
  setEnableClarification: (value: boolean) => void
  showCorrection: boolean
  enableCorrectionMode: boolean
  onCorrectionModeToggle?: (enabled: boolean, modelId?: string, modelName?: string) => void
  correctionModelName?: string | null
  taskId: number | null
  disabled: boolean
}

export function InputMoreActionsMenu({
  showClarification,
  enableClarification,
  setEnableClarification,
  showCorrection,
  enableCorrectionMode,
  onCorrectionModeToggle,
  correctionModelName,
  taskId,
  disabled,
}: InputMoreActionsMenuProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)

  if (!showClarification && !showCorrection) {
    return null
  }

  return (
    <TooltipProvider>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <div>
                <ActionButton
                  onClick={() => setOpen(current => !current)}
                  disabled={disabled}
                  icon={<MoreHorizontal className="h-4 w-4" />}
                  title={t('common:teams.more_actions', '更多操作')}
                  data-testid="desktop-input-more-actions-button"
                />
              </div>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{t('common:teams.more_actions', '更多操作')}</p>
          </TooltipContent>
        </Tooltip>

        <PopoverContent
          align="end"
          side="top"
          className="w-56 p-1"
          data-testid="desktop-input-more-actions-menu"
        >
          {showClarification && (
            <ClarificationToggle
              enabled={enableClarification}
              onToggle={setEnableClarification}
              disabled={disabled}
              triggerVariant="menu-item"
            />
          )}

          {showCorrection && onCorrectionModeToggle && (
            <CorrectionModeToggle
              enabled={enableCorrectionMode}
              onToggle={onCorrectionModeToggle}
              disabled={disabled}
              correctionModelName={correctionModelName}
              taskId={taskId}
              triggerVariant="menu-item"
            />
          )}
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  )
}

export default InputMoreActionsMenu
