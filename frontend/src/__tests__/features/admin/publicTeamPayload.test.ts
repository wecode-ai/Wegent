// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { AdminPublicTeam } from '@/apis/admin'
import {
  buildPublicTeamJson,
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

  it('preserves marketplace metadata while making spec.icon canonical', () => {
    const teamJson = buildPublicTeamJson({
      baseJson: {
        metadata: { name: 'old-agent', labels: { source: 'system' } },
        spec: {
          capability: {
            tags: ['technical_development'],
            icon: '/legacy-market-icon.png',
          },
          customField: 'keep-me',
        },
      },
      name: 'new-agent',
      displayName: 'New Agent',
      description: 'Build software',
      bindMode: ['chat'],
      icon: '/api/resource-library/assets/team-icons/12',
      requiresWorkspace: true,
      mode: 'solo',
      members: [{ botName: 'coder', botPrompt: '' }],
    })

    expect(teamJson).toMatchObject({
      metadata: {
        name: 'new-agent',
        labels: { source: 'system' },
      },
      spec: {
        icon: '/api/resource-library/assets/team-icons/12',
        customField: 'keep-me',
        capability: {
          tags: ['technical_development'],
          icon: undefined,
        },
      },
    })
  })
})
