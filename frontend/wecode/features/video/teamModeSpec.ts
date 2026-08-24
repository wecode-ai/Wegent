// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { TaskType, Team } from '@/types/api'

type TeamModeSpec = {
  allowedModelCategories?: string[]
  hiddenVideoParams?: string[]
}

type TeamWithLegacyModeSpec = Team & {
  modeSpec?: TeamModeSpec | null
}

export function getTeamModeSpec(team: Team | null | undefined): TeamModeSpec | null {
  if (!team) return null
  const typedTeam = team as TeamWithLegacyModeSpec
  return typedTeam.mode_spec ?? typedTeam.modeSpec ?? null
}

export function teamUsesModeSpecCategory(
  team: Team | null | undefined,
  category: 'image' | 'video'
): boolean {
  const categories = getTeamModeSpec(team)?.allowedModelCategories
  return Array.isArray(categories) && categories.includes(category)
}

export function teamHidesVideoParam(
  team: Team | null | undefined,
  param: 'duration' | 'ratio' | 'resolution'
): boolean {
  return getTeamModeSpec(team)?.hiddenVideoParams?.includes(param) ?? false
}

export function usesVideoReferenceStorage(
  taskType: TaskType,
  team: Team | null | undefined
): boolean {
  return taskType === 'video' || teamUsesModeSpecCategory(team, 'video')
}
