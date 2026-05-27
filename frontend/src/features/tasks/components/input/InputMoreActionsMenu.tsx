// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { MoreHorizontal } from 'lucide-react'
import type { RefObject } from 'react'
import { ActionButton } from '@/components/ui/action-button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import ClarificationToggle from '../clarification/ClarificationToggle'
import CorrectionModeToggle from '../CorrectionModeToggle'
import SkillSelectorPopover, { SkillSelectorPopoverRef } from '../selector/SkillSelectorPopover'
import { useTranslation } from '@/hooks/useTranslation'
import { isChatShell } from '../../service/messageService'
import type { Team } from '@/types/api'
import type { UnifiedSkill } from '@/apis/skills'

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
  selectedTeam: Team | null
  hasMessages: boolean
  availableSkills: UnifiedSkill[]
  teamSkillNames: string[]
  preloadedSkillNames: string[]
  selectedSkillNames: string[]
  onToggleSkill?: (skillName: string) => void
  skillSelectorRef?: RefObject<SkillSelectorPopoverRef | null>
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
  selectedTeam,
  hasMessages,
  availableSkills,
  teamSkillNames,
  preloadedSkillNames,
  selectedSkillNames,
  onToggleSkill,
  skillSelectorRef,
}: InputMoreActionsMenuProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const showSkillSelector = availableSkills.length > 0 && Boolean(onToggleSkill)
  const selectedSkillCount = selectedSkillNames.length

  if (!showClarification && !showCorrection && !showSkillSelector) {
    return null
  }

  return (
    <TooltipProvider>
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip>
          <TooltipTrigger asChild>
            <PopoverTrigger asChild>
              <div className="relative">
                <ActionButton
                  onClick={() => setOpen(current => !current)}
                  disabled={disabled}
                  icon={<MoreHorizontal className="h-4 w-4" />}
                  title={t('common:teams.more_actions', '更多操作')}
                  data-testid="desktop-input-more-actions-button"
                />
                {selectedSkillCount > 0 && (
                  <span className="absolute -top-1.5 -right-1.5 h-[18px] min-w-[18px] rounded-full bg-primary px-1 text-center text-[10px] leading-[18px] text-white pointer-events-none">
                    {selectedSkillCount}
                  </span>
                )}
              </div>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{t('common:teams.more_actions', '更多操作')}</p>
          </TooltipContent>
        </Tooltip>

        <PopoverContent
          align="start"
          side="top"
          className="w-56 p-1"
          data-testid="desktop-input-more-actions-menu"
        >
          {showSkillSelector && onToggleSkill && (
            <SkillSelectorPopover
              ref={skillSelectorRef}
              skills={availableSkills}
              teamSkillNames={teamSkillNames}
              preloadedSkillNames={preloadedSkillNames}
              selectedSkillNames={selectedSkillNames}
              onToggleSkill={onToggleSkill}
              isChatShell={isChatShell(selectedTeam)}
              disabled={disabled}
              readOnly={hasMessages}
              triggerVariant="menu-item"
            />
          )}

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
