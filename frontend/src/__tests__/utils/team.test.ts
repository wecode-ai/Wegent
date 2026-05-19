// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Team } from '@/types/api'
import { getTeamDisplayName, sortTeamsByUpdatedAt } from '@/utils/team'

const makeTeam = (overrides: Partial<Team> = {}): Team => ({
  id: 1,
  name: 'agent-name',
  displayName: null,
  namespace: 'default',
  description: '',
  bots: [],
  workflow: {},
  is_active: true,
  user_id: 1,
  created_at: '2026-05-18T00:00:00Z',
  updated_at: '2026-05-18T00:00:00Z',
  ...overrides,
})

describe('team utils', () => {
  it('prefers displayName over name for team labels', () => {
    expect(getTeamDisplayName(makeTeam({ displayName: 'Spec Agent' }))).toBe('Spec Agent')
  })

  it('falls back to name when displayName is empty', () => {
    expect(getTeamDisplayName(makeTeam({ displayName: '   ' }))).toBe('agent-name')
    expect(getTeamDisplayName(makeTeam())).toBe('agent-name')
  })

  it('sorts teams by updated_at descending', () => {
    const teams = [
      makeTeam({ id: 1, updated_at: '2026-05-18T00:00:00Z' }),
      makeTeam({ id: 2, updated_at: '2026-05-19T00:00:00Z' }),
    ]

    expect(sortTeamsByUpdatedAt(teams).map(team => team.id)).toEqual([2, 1])
  })
})
