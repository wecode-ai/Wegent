// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { AdminPublicTeam } from '@/apis/admin'
import {
  buildPublicTeamUpdateData,
  resolvePublicTeamName,
} from '@/features/admin/utils/publicTeamPayload'

const makeEditingTeam = (): AdminPublicTeam => ({
  id: 7,
  name: 'old-agent',
  namespace: 'default',
  display_name: 'Old Agent',
  description: 'desc',
  json: {},
  is_active: true,
  created_at: '2026-05-19T00:00:00Z',
  updated_at: '2026-05-19T00:00:00Z',
})

describe('publicTeamPayload', () => {
  it('prefers the edited name when resolving the persisted public team name', () => {
    const resolved = resolvePublicTeamName(
      '  new-agent  ',
      { metadata: { name: 'json-agent' } },
      'fallback-agent'
    )

    expect(resolved).toBe('new-agent')
  })

  it('falls back to metadata.name and then the provided fallback', () => {
    expect(resolvePublicTeamName('', { metadata: { name: 'json-agent' } }, 'fallback-agent')).toBe(
      'json-agent'
    )
    expect(resolvePublicTeamName('', {}, 'fallback-agent')).toBe('fallback-agent')
  })

  it('includes the resolved name in public team update payloads', () => {
    const updateData = buildPublicTeamUpdateData({
      editingTeam: makeEditingTeam(),
      name: 'renamed-agent',
      namespace: 'default',
      teamJson: { metadata: { name: 'ignored-json-name' } },
      isActive: false,
    })

    expect(updateData).toEqual({
      name: 'renamed-agent',
      json: { metadata: { name: 'ignored-json-name' } },
      is_active: false,
    })
  })

  it('adds namespace only when the namespace changes', () => {
    const updateData = buildPublicTeamUpdateData({
      editingTeam: makeEditingTeam(),
      name: '',
      namespace: 'community',
      teamJson: { metadata: { name: 'json-agent' } },
      isActive: true,
    })

    expect(updateData).toEqual({
      name: 'json-agent',
      namespace: 'community',
      json: { metadata: { name: 'json-agent' } },
      is_active: true,
    })
  })
})
