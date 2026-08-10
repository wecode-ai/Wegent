// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Team } from '@/types/api'
import {
  buildTeamTargetHref,
  findDefaultTeamForMode,
  filterTeamsByMode,
  getRecentTeams,
  getTeamGenerateMode,
  getTeamTargetPage,
  teamSupportsBothGenerationModes,
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

  it('finds the configured default team for a mode and prioritizes the public team', () => {
    const personalDefault = {
      ...makeTeam(1, ['chat']),
      default_for_modes: ['chat'] as Team['default_for_modes'],
    }
    const publicDefault = {
      ...makeTeam(2, ['chat']),
      user_id: 0,
      default_for_modes: ['chat'] as Team['default_for_modes'],
    }

    expect(findDefaultTeamForMode([personalDefault, publicDefault], 'chat')).toBe(publicDefault)
    expect(findDefaultTeamForMode([personalDefault], 'video')).toBeNull()
  })

  it('resolves target pages from bind mode and current filter', () => {
    expect(getTeamTargetPage(makeTeam(1, ['task']), 'all')).toBe('devices/chat')
    expect(getTeamTargetPage(makeTeam(2, ['chat', 'task']), 'task')).toBe('devices/chat')
    expect(getTeamTargetPage(makeTeam(3, ['chat', 'code']), 'code')).toBe('code')
    expect(getTeamTargetPage(makeTeam(4, ['chat', 'code']), 'all')).toBe('chat')
    expect(getTeamTargetPage(makeTeam(5, ['video']), 'all')).toBe('video')
    expect(getTeamTargetPage(makeTeam(6, ['image']), 'all')).toBe('image')
  })

  it('derives generation mode from the selected agent', () => {
    expect(getTeamGenerateMode(makeTeam(1, ['video']), 'image')).toBe('video')
    expect(getTeamGenerateMode(makeTeam(2, ['image']), 'video')).toBe('image')
    expect(getTeamGenerateMode(makeTeam(3, ['video', 'image']), 'video')).toBe('video')
    expect(getTeamGenerateMode(makeTeam(4, ['chat']), 'video')).toBeNull()
  })

  it('only keeps the generation mode selector for dual-mode agents', () => {
    expect(teamSupportsBothGenerationModes(makeTeam(1, ['video', 'image']))).toBe(true)
    expect(teamSupportsBothGenerationModes(makeTeam(2, ['video']))).toBe(false)
    expect(teamSupportsBothGenerationModes(makeTeam(3, ['image']))).toBe(false)
  })

  it('keeps recent-use order and fills to five with latest updated teams', () => {
    const teams = [1, 2, 3, 4, 5, 6].map(id => ({
      ...makeTeam(id, ['chat']),
      updated_at: `2026-07-0${id}T00:00:00Z`,
    }))

    expect(getRecentTeams(teams, [3, 1]).map(team => team.id)).toEqual([3, 1, 6, 5, 4])
  })

  it('deduplicates system and personal copies by namespace and name', () => {
    const teams = [1, 2, 3, 4, 5, 6].map(id => ({
      ...makeTeam(id, ['chat']),
      name: id <= 2 ? 'wegent-chat' : `team-${id}`,
      user_id: id === 1 ? 0 : 7,
      updated_at: `2026-07-0${id}T00:00:00Z`,
    }))

    expect(getRecentTeams(teams, [1, 2]).map(team => team.id)).toEqual([1, 6, 5, 4, 3])
  })

  it('builds code target hrefs through chat agent mode', () => {
    const params = new URLSearchParams({ teamId: '42' })

    expect(buildTeamTargetHref('code', params)).toBe('/chat?teamId=42&agent=code')
    expect(buildTeamTargetHref('devices/chat', params)).toBe('/devices/chat?teamId=42')
    expect(buildTeamTargetHref('video', params)).toBe('/chat?teamId=42&mode=video')
    expect(buildTeamTargetHref('image', params)).toBe('/chat?teamId=42&mode=image')
  })
})
