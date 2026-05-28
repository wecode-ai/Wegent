// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Team } from '@/types/api'
import {
  filterTeamsByMode,
  getTeamTargetPage,
} from '@/features/tasks/components/selector/team-selector-utils'

function makeTeam(id: number, bindMode?: Team['bind_mode']): Team {
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
  }
}

describe('team selector utils', () => {
  it('filters teams by chat, code, and device task modes', () => {
    const teams = [
      makeTeam(1, ['chat']),
      makeTeam(2, ['code']),
      makeTeam(3, ['task']),
      makeTeam(4, ['chat', 'task']),
      makeTeam(5),
      makeTeam(6, []),
    ]

    expect(filterTeamsByMode(teams, 'chat').map(team => team.id)).toEqual([1, 4, 5])
    expect(filterTeamsByMode(teams, 'code').map(team => team.id)).toEqual([2, 5])
    expect(filterTeamsByMode(teams, 'task').map(team => team.id)).toEqual([3, 4, 5])
    expect(filterTeamsByMode(teams, 'all').map(team => team.id)).toEqual([1, 2, 3, 4, 5])
  })

  it('resolves target pages from bind mode and current filter', () => {
    expect(getTeamTargetPage(makeTeam(1, ['task']), 'all')).toBe('devices/chat')
    expect(getTeamTargetPage(makeTeam(2, ['chat', 'task']), 'task')).toBe('devices/chat')
    expect(getTeamTargetPage(makeTeam(3, ['chat', 'code']), 'code')).toBe('code')
    expect(getTeamTargetPage(makeTeam(4, ['chat', 'code']), 'all')).toBe('chat')
  })
})
