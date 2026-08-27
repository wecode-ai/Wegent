// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { TaskType, Team } from '@/types/api'

export function teamUsesModeSpecCategory(team: Team | null | undefined, category: string): boolean {
  return Boolean(team?.mode_spec?.allowedModelCategories?.includes(category))
}

export function teamHidesVideoParam(
  team: Team | null | undefined,
  param: 'duration' | 'ratio' | 'resolution'
): boolean {
  return team?.mode_spec?.hiddenVideoParams?.includes(param) === true
}

export function usesVideoReferenceStorage(
  taskType: TaskType,
  team: Team | null | undefined
): boolean {
  return taskType === 'video' || teamUsesModeSpecCategory(team, 'video')
}
