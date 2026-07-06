// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Team } from '@/types/api'
import {
  filterSubscriptionTeamsByExecutionTarget,
  getSubscriptionTeamDisplayName,
} from '@/features/feed/components/subscription-form/team-selection'

function makeTeam(id: number, bindMode?: Team['bind_mode'], overrides: Partial<Team> = {}): Team {
  return {
    id,
    name: `team-${id}`,
    description: '',
    bots: [],
    workflow: {},
    is_active: true,
    user_id: 1,
    created_at: '',
    updated_at: '',
    bind_mode: bindMode,
    ...overrides,
  }
}

describe('subscription team selection', () => {
  it('shows device-capable teams when execution target is a device', () => {
    const teams = [
      makeTeam(1, ['chat']),
      makeTeam(2, ['code']),
      makeTeam(3, ['task']),
      makeTeam(4, ['chat', 'task']),
      makeTeam(5),
      makeTeam(6, []),
    ]

    const filteredTeams = filterSubscriptionTeamsByExecutionTarget(teams, {
      type: 'local',
      device_id: 'device-1',
    })

    expect(filteredTeams.map(team => team.id)).toEqual([3, 4, 5])
  })

  it('shows chat and code teams when execution target is managed', () => {
    const teams = [
      makeTeam(1, ['chat']),
      makeTeam(2, ['code']),
      makeTeam(3, ['task']),
      makeTeam(4, ['chat', 'task']),
      makeTeam(5),
      makeTeam(6, []),
    ]

    const filteredTeams = filterSubscriptionTeamsByExecutionTarget(teams, {
      type: 'managed',
    })

    expect(filteredTeams.map(team => team.id)).toEqual([1, 2, 4, 5])
  })

  it('prefers team display names in subscription selectors', () => {
    expect(
      getSubscriptionTeamDisplayName(makeTeam(1, ['task'], { displayName: '设备智能体' }))
    ).toBe('设备智能体')
    expect(
      getSubscriptionTeamDisplayName({
        ...makeTeam(2, ['task']),
        display_name: '旧接口显示名',
      } as Team & { display_name: string })
    ).toBe('旧接口显示名')
    expect(getSubscriptionTeamDisplayName(makeTeam(3, ['task']))).toBe('team-3')
  })
})
