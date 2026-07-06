// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Team } from '@/types/api'
import type { SubscriptionExecutionTarget } from '@/types/subscription'
import {
  filterTeamsByMode,
  getTeamDisplayName,
} from '@/features/tasks/components/selector/team-selector-utils'

export function isDeviceExecutionTarget(executionTarget: SubscriptionExecutionTarget): boolean {
  return executionTarget.type !== 'managed'
}

export function filterSubscriptionTeamsByExecutionTarget(
  teams: Team[],
  executionTarget: SubscriptionExecutionTarget
): Team[] {
  if (isDeviceExecutionTarget(executionTarget)) {
    return filterTeamsByMode(teams, 'task')
  }

  return filterTeamsByMode(teams, 'all').filter(
    team => !team.bind_mode || team.bind_mode.includes('chat') || team.bind_mode.includes('code')
  )
}

export function getSubscriptionTeamDisplayName(team: Team): string {
  return getTeamDisplayName(team)
}
