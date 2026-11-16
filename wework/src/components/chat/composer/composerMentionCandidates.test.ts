// @vitest-environment node

import type { CloudProject } from '@/api/deliveries'
import { describe, expect, test } from 'vitest'
import { parseCloudProjectScopeQuery } from './composerAutocomplete'
import type { ComposerCloudMentionCandidate } from './composerMentionCandidates'
import { matchesMentionQuery } from './composerMentionCandidates'

const CLOUD_PROJECT: CloudProject = {
  id: '7',
  public_id: 'pub-7',
  project_key: 'GW',
  name: '官网改版',
  description: '',
  created_by_user_id: 1,
  status: 'active',
  version: 1,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
}

function cloudCandidate(overrides: Partial<ComposerCloudMentionCandidate> = {}) {
  const candidate: ComposerCloudMentionCandidate = {
    kind: 'cloud',
    key: 'cloud-project-space:7',
    title: '官网改版',
    description: 'GW',
    metaLabel: '云空间',
    testId: 'cloud-project-space-7',
    enabled: true,
    reference: '[$项目空间:官网改版](cloud://projects/7)',
    searchAliases: ['官网改版', 'GW', '项目空间', 'project space'],
    project: CLOUD_PROJECT,
    ...overrides,
  }
  return candidate
}

describe('matchesMentionQuery', () => {
  test('matches against the title, description, and aliases case-insensitively', () => {
    const candidate = cloudCandidate()
    expect(matchesMentionQuery(candidate, '官')).toBe(true)
    expect(matchesMentionQuery(candidate, 'gw')).toBe(true)
    expect(matchesMentionQuery(candidate, 'PROJECT SPACE')).toBe(true)
    expect(matchesMentionQuery(candidate, '移动端')).toBe(false)
  })
})

describe('parseCloudProjectScopeQuery', () => {
  const labels = ['项目空间', 'project space', 'project-space']

  test('matches scope labels case-insensitively', () => {
    expect(parseCloudProjectScopeQuery('Project-Space:web', labels)).toBe('web')
  })

  test('returns null for a bare scope label without a separator', () => {
    expect(parseCloudProjectScopeQuery('项目空间', labels)).toBeNull()
    expect(parseCloudProjectScopeQuery('项目空间abc', labels)).toBeNull()
  })
})
