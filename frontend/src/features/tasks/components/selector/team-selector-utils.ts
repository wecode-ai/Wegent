// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Team, TaskType } from '@/types/api'

export type SelectableTeam = Team & {
  display_name?: string | null
  is_system?: boolean
}

export function getTeamDisplayName(team: SelectableTeam): string {
  return team.display_name?.trim() || team.displayName?.trim() || team.name
}

export function filterTeamsByMode(teams: Team[], currentMode: TaskType): Team[] {
  return teams
    .filter(team => !(Array.isArray(team.bind_mode) && team.bind_mode.length === 0))
    .filter(team => !team.bind_mode || team.bind_mode.includes(currentMode))
}
