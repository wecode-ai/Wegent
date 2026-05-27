// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import type { RefObject } from 'react'
import { Badge } from '@/components/ui/badge'
import { ActionButton } from '@/components/ui/action-button'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'
import { AgentIcon } from '@/components/icons/AgentIcon'
import TeamSelectorButton from '../selector/TeamSelectorButton'
import SkillSelectorPopover, { SkillSelectorPopoverRef } from '../selector/SkillSelectorPopover'
import { isChatShell } from '../../service/messageService'
import { useTranslation } from '@/hooks/useTranslation'
import type { Team, TaskDetail, TaskType } from '@/types/api'
import type { UnifiedSkill } from '@/apis/skills'

interface AgentSkillSelectorMenuProps {
  selectedTeam: Team | null
  teams: Team[]
  onTeamChange?: (team: Team) => void
  onTeamsRefresh?: () => Promise<void>
  selectedTaskDetail: TaskDetail | null
  taskType?: TaskType
  hasMessages: boolean
  isLoading: boolean
  isStreaming: boolean
  hasNoTeams: boolean
  availableSkills: UnifiedSkill[]
  teamSkillNames: string[]
  preloadedSkillNames: string[]
  selectedSkillNames: string[]
  onToggleSkill?: (skillName: string) => void
  skillSelectorRef?: RefObject<SkillSelectorPopoverRef | null>
}

export function AgentSkillSelectorMenu({
  selectedTeam,
  teams,
  onTeamChange,
  onTeamsRefresh,
  selectedTaskDetail,
  taskType,
  hasMessages,
  isLoading,
  isStreaming,
  hasNoTeams,
  availableSkills,
  teamSkillNames,
  preloadedSkillNames,
  selectedSkillNames,
  onToggleSkill,
  skillSelectorRef,
}: AgentSkillSelectorMenuProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const showTeamSelector = teams.length > 0 && Boolean(onTeamChange) && !hasMessages
  const showSkillSelector = availableSkills.length > 0 && Boolean(onToggleSkill)
  const selectedCount = selectedSkillNames.length

  if (!showTeamSelector && !showSkillSelector) {
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
                  disabled={hasNoTeams || isLoading || isStreaming}
                  icon={<AgentIcon className="h-4 w-4" />}
                  title={t('common:teamSelector.agent_skill_label', '智能体与技能')}
                  data-testid="agent-skill-selector-button"
                />
                {selectedCount > 0 && (
                  <Badge
                    variant="secondary"
                    className="absolute -top-1.5 -right-1.5 h-[18px] min-w-[18px] flex items-center justify-center text-[10px] px-1 bg-primary text-white pointer-events-none z-10 rounded-full"
                  >
                    {selectedCount}
                  </Badge>
                )}
              </div>
            </PopoverTrigger>
          </TooltipTrigger>
          <TooltipContent side="top">
            <p>{t('common:teamSelector.agent_skill_label', '智能体与技能')}</p>
          </TooltipContent>
        </Tooltip>

        <PopoverContent
          align="end"
          side="top"
          className="w-60 p-1"
          data-testid="agent-skill-selector-menu"
        >
          {showTeamSelector && onTeamChange && (
            <TeamSelectorButton
              selectedTeam={selectedTeam}
              setSelectedTeam={(team: Team | null) => {
                if (team) {
                  onTeamChange(team)
                }
              }}
              teams={teams}
              disabled={isLoading || isStreaming}
              taskDetail={selectedTaskDetail}
              hideSettingsLink={false}
              currentMode={taskType}
              onTeamsRefresh={onTeamsRefresh}
              triggerVariant="menu-item"
            />
          )}

          {showSkillSelector && onToggleSkill && (
            <SkillSelectorPopover
              ref={skillSelectorRef}
              skills={availableSkills}
              teamSkillNames={teamSkillNames}
              preloadedSkillNames={preloadedSkillNames}
              selectedSkillNames={selectedSkillNames}
              onToggleSkill={onToggleSkill}
              isChatShell={isChatShell(selectedTeam)}
              disabled={isLoading || isStreaming}
              readOnly={hasMessages}
              triggerVariant="menu-item"
            />
          )}
        </PopoverContent>
      </Popover>
    </TooltipProvider>
  )
}

export default AgentSkillSelectorMenu
