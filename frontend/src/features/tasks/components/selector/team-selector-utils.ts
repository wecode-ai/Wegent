// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Team, TaskType } from '@/types/api'
import { buildChatCodeHref } from '@/config/coding-route'

export type TeamModeFilter = 'all' | TaskType
export type TeamTargetPage = 'chat' | 'code' | 'knowledge' | 'devices/chat' | 'generate'

export type SelectableTeam = Team & {
  display_name?: string | null
  is_system?: boolean
}

export function getTeamDisplayName(team: SelectableTeam): string {
  return team.display_name?.trim() || team.displayName?.trim() || team.name
}

export function filterTeamsByMode(teams: Team[], currentMode: TeamModeFilter): Team[] {
  const teamsWithValidBindMode = teams.filter(
    team => !(Array.isArray(team.bind_mode) && team.bind_mode.length === 0)
  )

  if (currentMode === 'all') {
    return teamsWithValidBindMode
  }

  return teamsWithValidBindMode.filter(
    team => !team.bind_mode || team.bind_mode.includes(currentMode)
  )
}

export function getRecentTeams(teams: Team[], recentTeamIds: number[], limit = 5): Team[] {
  const teamById = new Map(teams.map(team => [team.id, team]))
  const selected: Team[] = []
  const selectedIds = new Set<number>()
  const selectedIdentities = new Set<string>()

  const addTeam = (team: Team) => {
    const identity = `${team.namespace || 'default'}\u0000${team.name}`
    if (selectedIds.has(team.id) || selectedIdentities.has(identity)) return false
    selected.push(team)
    selectedIds.add(team.id)
    selectedIdentities.add(identity)
    return true
  }

  for (const teamId of recentTeamIds) {
    const team = teamById.get(teamId)
    if (!team || !addTeam(team)) continue
    if (selected.length === limit) return selected
  }

  const latestTeams = [...teams].sort((left, right) => {
    const updatedResult = right.updated_at.localeCompare(left.updated_at)
    return updatedResult || right.id - left.id
  })
  for (const team of latestTeams) {
    if (!addTeam(team)) continue
    if (selected.length === limit) break
  }

  return selected
}

export function getTeamTargetPage(team: Team, currentMode: TeamModeFilter): TeamTargetPage {
  const bindMode = team.bind_mode || ['chat', 'code']
  const targetMode =
    bindMode.length === 1 ? bindMode[0] : currentMode === 'all' ? 'chat' : currentMode

  if (targetMode === 'task') {
    return 'devices/chat'
  }

  if (targetMode === 'video' || targetMode === 'image') {
    return 'generate'
  }

  if (targetMode === 'knowledge') {
    return 'knowledge'
  }

  return targetMode
}

export function buildTeamTargetHref(targetPage: TeamTargetPage, params?: URLSearchParams): string {
  if (targetPage === 'code') {
    return buildChatCodeHref(params)
  }

  const query = params?.toString()
  return query ? `/${targetPage}?${query}` : `/${targetPage}`
}
