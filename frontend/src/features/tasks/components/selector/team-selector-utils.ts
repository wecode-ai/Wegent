// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Team, TaskType } from '@/types/api'
import { buildChatCodeHref } from '@/config/coding-route'

export type TeamModeFilter = 'all' | TaskType
export type TeamTargetPage = 'chat' | 'code' | 'knowledge' | 'devices/chat' | 'video' | 'image'
export type GenerateTaskMode = Extract<TaskType, 'video' | 'image'>

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

export function findDefaultTeamForMode(teams: Team[], mode: TaskType): Team | null {
  const matchedTeams = teams.filter(team => team.default_for_modes?.includes(mode))
  if (matchedTeams.length === 0) return null
  return matchedTeams.find(team => team.user_id === 0) ?? matchedTeams[0]
}

export function getTeamGenerateMode(
  team: Team | null,
  currentMode: GenerateTaskMode
): GenerateTaskMode | null {
  const bindMode = team?.bind_mode
  if (!bindMode) return currentMode
  if (bindMode.includes(currentMode)) return currentMode
  if (bindMode.includes('video')) return 'video'
  if (bindMode.includes('image')) return 'image'
  return null
}

export function teamSupportsBothGenerationModes(team: Team | null): boolean {
  return Boolean(team?.bind_mode?.includes('video') && team.bind_mode.includes('image'))
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

export function getBindModesTargetPage(
  bindMode: readonly string[] | undefined,
  currentMode: TeamModeFilter
): TeamTargetPage {
  const effectiveBindMode = bindMode || ['chat', 'code']
  const targetMode =
    effectiveBindMode.length === 1
      ? effectiveBindMode[0]
      : currentMode === 'all'
        ? 'chat'
        : currentMode

  switch (targetMode) {
    case 'task':
      return 'devices/chat'
    case 'code':
    case 'knowledge':
    case 'video':
    case 'image':
      return targetMode
    default:
      return 'chat'
  }
}

export function getTeamTargetPage(team: Team, currentMode: TeamModeFilter): TeamTargetPage {
  return getBindModesTargetPage(team.bind_mode, currentMode)
}

export function buildTeamTargetHref(targetPage: TeamTargetPage, params?: URLSearchParams): string {
  if (targetPage === 'code') {
    return buildChatCodeHref(params)
  }

  const targetParams = new URLSearchParams(params?.toString())
  if (targetPage === 'video' || targetPage === 'image') {
    targetParams.set('mode', targetPage)
    const query = targetParams.toString()
    return query ? `/chat?${query}` : '/chat'
  }

  const query = targetParams.toString()
  return query ? `/${targetPage}?${query}` : `/${targetPage}`
}
