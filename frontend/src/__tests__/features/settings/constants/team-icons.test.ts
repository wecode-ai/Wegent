// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  DEFAULT_TEAM_ICON_ID,
  TEAM_ICONS,
  getTeamIconById,
} from '@/features/settings/constants/team-icons'

describe('team icon catalog', () => {
  it('offers a broad catalog for agent icon selection', () => {
    expect(TEAM_ICONS.length).toBeGreaterThanOrEqual(80)
    expect(TEAM_ICONS.map(icon => icon.id)).toEqual(
      expect.arrayContaining([
        'message',
        'workflow',
        'briefcase',
        'graduation',
        'bug',
        'pen',
        'calendar',
        'lock',
        'server',
        'network',
        'mobile',
        'flag',
      ])
    )
  })

  it('keeps icon ids unique and preserves the default icon', () => {
    const iconIds = TEAM_ICONS.map(icon => icon.id)

    expect(new Set(iconIds).size).toBe(iconIds.length)
    expect(getTeamIconById(DEFAULT_TEAM_ICON_ID).id).toBe(DEFAULT_TEAM_ICON_ID)
  })
})
