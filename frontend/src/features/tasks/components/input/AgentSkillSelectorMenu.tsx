// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import TeamSelectorButton from '../selector/TeamSelectorButton'
import type { Team, TaskDetail, TaskType } from '@/types/api'
import type { TeamModeFilter } from '../selector/team-selector-utils'

interface AgentSkillSelectorMenuProps {
  selectedTeam: Team | null
  teams: Team[]
  onTeamChange?: (team: Team) => void
  onTeamsRefresh?: () => Promise<void>
  selectedTaskDetail: TaskDetail | null
  taskType?: TaskType
  teamModeFilter?: TeamModeFilter
  hasMessages: boolean
  isLoading: boolean
  isStreaming: boolean
  hasNoTeams: boolean
}

export function AgentSkillSelectorMenu({
  selectedTeam,
  teams,
  onTeamChange,
  onTeamsRefresh,
  selectedTaskDetail,
  taskType,
  teamModeFilter = taskType ?? 'chat',
  hasMessages,
  isLoading,
  isStreaming,
  hasNoTeams,
}: AgentSkillSelectorMenuProps) {
  const showTeamSelector = teams.length > 0 && Boolean(onTeamChange) && !hasMessages

  if (!showTeamSelector) {
    return null
  }

  return (
    <TeamSelectorButton
      selectedTeam={selectedTeam}
      setSelectedTeam={(team: Team | null) => {
        if (team && onTeamChange) {
          onTeamChange(team)
        }
      }}
      teams={teams}
      disabled={hasNoTeams || isLoading || isStreaming}
      taskDetail={selectedTaskDetail}
      hideSettingsLink={false}
      currentMode={teamModeFilter}
      onTeamsRefresh={onTeamsRefresh}
      iconOnly
      triggerTestId="agent-skill-selector-button"
    />
  )
}

export default AgentSkillSelectorMenu
