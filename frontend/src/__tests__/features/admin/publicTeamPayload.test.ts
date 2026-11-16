// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { AdminPublicTeam } from '@/apis/admin'
import {
  buildPublicTeamJson,
  buildPublicTeamUpdateData,
  resolvePublicTeamBaseJson,
  resolvePublicTeamName,
  syncPublicTeamVideoModeSpec,
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

  it('uses the advanced editor JSON as the base when it holds a team object', () => {
    const opened = { spec: { members: [{ botRef: { name: 'writer' }, role: 'writer' }] } }
    const edited = { spec: { members: [] } }

    expect(resolvePublicTeamBaseJson(JSON.stringify(edited), opened)).toEqual(edited)
  })

  it('falls back to the opened team when the advanced editor is empty or invalid', () => {
    const opened = { spec: { members: [{ botRef: { name: 'writer' }, role: 'writer' }] } }

    expect(resolvePublicTeamBaseJson('', opened)).toBe(opened)
    expect(resolvePublicTeamBaseJson('{}', opened)).toBe(opened)
    expect(resolvePublicTeamBaseJson('{', opened)).toBe(opened)
    expect(resolvePublicTeamBaseJson('[]', opened)).toBe(opened)
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
      inputPlaceholder: {
        zh: '描述要生成的视频',
        mobile: { zh: '描述你想创作的内容' },
      },
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
        inputPlaceholder: {
          zh: '描述要生成的视频',
          mobile: { zh: '描述你想创作的内容' },
        },
        customField: 'keep-me',
        capability: {
          tags: ['technical_development'],
          icon: undefined,
        },
      },
    })
  })

  it('keeps roles the basic editor never rendered when it rebuilds members', () => {
    const teamJson = buildPublicTeamJson({
      baseJson: {
        spec: {
          members: [
            { botRef: { name: 'code-wiki-bot', namespace: 'default' }, role: 'leader' },
            { botRef: { name: 'code-wiki-reviewer', namespace: 'default' }, role: 'reviewer' },
            {
              botRef: { name: 'code-wiki-section-writer', namespace: 'default' },
              role: 'writer',
            },
          ],
        },
      },
      name: 'code-wiki-team',
      displayName: 'Code Wiki',
      description: '',
      bindMode: ['chat'],
      icon: null,
      requiresWorkspace: true,
      mode: 'coordinate',
      members: [
        { botName: 'code-wiki-bot', botPrompt: '', role: 'leader' },
        { botName: 'code-wiki-reviewer', botPrompt: '' },
        { botName: 'code-wiki-section-writer', botPrompt: '' },
        { botName: 'new-bot', botPrompt: '' },
      ],
    })

    const members = (teamJson.spec as { members: { botRef: { name: string }; role?: string }[] })
      .members

    expect(members.map(member => [member.botRef.name, member.role])).toEqual([
      ['code-wiki-bot', 'leader'],
      ['code-wiki-reviewer', 'reviewer'],
      ['code-wiki-section-writer', 'writer'],
      ['new-bot', undefined],
    ])
  })

  it('keeps roles from legacy string bot references', () => {
    const teamJson = buildPublicTeamJson({
      baseJson: {
        spec: {
          members: [{ botRef: 'legacy-writer', role: 'writer' }],
        },
      },
      name: 'legacy-team',
      displayName: 'Legacy Team',
      description: '',
      bindMode: ['chat'],
      icon: null,
      requiresWorkspace: true,
      mode: 'coordinate',
      members: [{ botName: 'legacy-writer', botPrompt: '' }],
    })

    const members = (teamJson.spec as { members: { role?: string }[] }).members

    expect(members.map(member => member.role)).toEqual(['writer'])
  })

  it('ignores malformed persisted members when building the role map', () => {
    const teamJson = buildPublicTeamJson({
      baseJson: {
        spec: {
          members: [null, 'not-an-object', { botRef: { name: 'writer' }, role: 'writer' }],
        },
      },
      name: 'malformed-team',
      displayName: 'Malformed Team',
      description: '',
      bindMode: ['chat'],
      icon: null,
      requiresWorkspace: true,
      mode: 'coordinate',
      members: [{ botName: 'writer', botPrompt: '' }],
    })

    const members = (teamJson.spec as { members: { role?: string }[] }).members

    expect(members.map(member => member.role)).toEqual(['writer'])
  })

  it('does not keep a stale leader role when leadership moves', () => {
    const teamJson = buildPublicTeamJson({
      baseJson: {
        spec: {
          members: [
            { botRef: { name: 'old-leader', namespace: 'default' }, role: 'leader' },
            { botRef: { name: 'writer', namespace: 'default' }, role: 'writer' },
          ],
        },
      },
      name: 'moved-leader-team',
      displayName: 'Moved Leader',
      description: '',
      bindMode: ['chat'],
      icon: null,
      requiresWorkspace: true,
      mode: 'coordinate',
      members: [
        { botName: 'new-leader', botPrompt: '', role: 'leader' },
        { botName: 'old-leader', botPrompt: '' },
        { botName: 'writer', botPrompt: '' },
      ],
    })

    const members = (teamJson.spec as { members: { botRef: { name: string }; role?: string }[] })
      .members

    expect(members.map(member => [member.botRef.name, member.role])).toEqual([
      ['new-leader', 'leader'],
      ['old-leader', undefined],
      ['writer', 'writer'],
    ])
  })

  it('stores video mode behavior without duplicating the Bot model binding', () => {
    const modeSpec = syncPublicTeamVideoModeSpec(
      {
        allowedModelCategories: ['llm'],
        defaultModelRefs: {
          video: { name: 'legacy-video-model', namespace: 'default' },
        },
      },
      true
    )

    const teamJson = buildPublicTeamJson({
      name: 'test-video-team',
      displayName: 'One-minute Video',
      description: 'Test video team',
      bindMode: ['chat'],
      icon: null,
      requiresWorkspace: true,
      mode: 'solo',
      modeSpec,
      members: [{ botName: 'test-video-bot', botPrompt: '' }],
    })

    expect(teamJson).toMatchObject({
      spec: {
        modeSpec: {
          allowedModelCategories: ['video'],
          hiddenVideoParams: ['duration'],
        },
      },
    })
    expect((teamJson.spec as Record<string, unknown>).modeSpec).not.toHaveProperty(
      'defaultModelRefs'
    )
  })

  it('removes video-only modeSpec when the Bot returns to an LLM model', () => {
    const modeSpec = syncPublicTeamVideoModeSpec(
      {
        allowedModelCategories: ['video'],
        hiddenVideoParams: ['duration'],
      },
      false
    )

    expect(modeSpec).toBeNull()
  })
})
