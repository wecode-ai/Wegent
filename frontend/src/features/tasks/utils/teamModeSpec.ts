// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Team } from '@/types/api'

export function teamUsesModeSpecCategory(team: Team | null | undefined, category: string): boolean {
  return Boolean(team?.mode_spec?.allowedModelCategories?.includes(category))
}

export function teamUsesWorkflowManagedVideo(team: Team | null | undefined): boolean {
  return team?.mode_spec?.workflowManagedVideo === true
}

export function resolveBotRuntimeModel<T>(
  team: Team | null | undefined,
  frontendModel: T | null
): T | null {
  return teamUsesWorkflowManagedVideo(team) ? null : frontendModel
}
