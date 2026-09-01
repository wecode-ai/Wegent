// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { TaskType, Team } from '@/types/api'

export interface VideoParamVisibility {
  showModel: boolean
  showRatio: boolean
  showDuration: boolean
  showResolution: boolean
  showSettings: boolean
}

/** Resolve video control visibility from workflow ownership and caller constraints. */
export function getVideoParamVisibility(
  hiddenVideoParams: readonly string[] | undefined,
  allowDuration = true
): VideoParamVisibility {
  const showRatio = !hiddenVideoParams?.includes('ratio')
  const showDuration = allowDuration && !hiddenVideoParams?.includes('duration')
  const showResolution = !hiddenVideoParams?.includes('resolution')

  return {
    showModel: !hiddenVideoParams?.includes('model'),
    showRatio,
    showDuration,
    showResolution,
    showSettings: showRatio || showDuration || showResolution,
  }
}

export function teamUsesModeSpecCategory(team: Team | null | undefined, category: string): boolean {
  return Boolean(team?.mode_spec?.allowedModelCategories?.includes(category))
}

export function teamHidesVideoParam(
  team: Team | null | undefined,
  param: 'duration' | 'generation_mode' | 'model' | 'ratio' | 'resolution'
): boolean {
  return team?.mode_spec?.hiddenVideoParams?.includes(param) === true
}

export function usesVideoReferenceStorage(
  taskType: TaskType,
  team: Team | null | undefined
): boolean {
  return taskType === 'video' || teamUsesModeSpecCategory(team, 'video')
}
