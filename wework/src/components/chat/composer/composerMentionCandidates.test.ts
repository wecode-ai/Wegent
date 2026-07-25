import { describe, expect, test } from 'vitest'
import type { CloudProject } from '@/api/deliveries'
import { parseCloudProjectScopeQuery } from './composerAutocomplete'
import { appReference, matchesMentionQuery } from './composerMentionCandidates'
import type { ComposerCloudMentionCandidate } from './composerMentionCandidates'

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

describe('appReference', () => {
  test('uses a generated Skill reference for Wegent connector apps', () => {
    expect(
      appReference({
        id: 'wegent:docs',
        name: 'Internal Docs',
        source: 'wegent-connector',
        skillPath: '/tmp/codex/skills/wegent-connector-docs/SKILL.md',
      })
    ).toBe('[$Internal Docs](/tmp/codex/skills/wegent-connector-docs/SKILL.md)')
  })

  test('preserves native Codex app references', () => {
    expect(appReference({ id: 'calendar', name: 'Calendar' })).toBe('[$Calendar](app://calendar)')
  })
})

describe('matchesMentionQuery', () => {
  test('matches every candidate for an empty query', () => {
    expect(matchesMentionQuery(cloudCandidate(), '')).toBe(true)
    expect(matchesMentionQuery(cloudCandidate(), '   ')).toBe(true)
  })

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

  test('returns the keyword after a half-width or full-width colon', () => {
    expect(parseCloudProjectScopeQuery('项目空间:官', labels)).toBe('官')
    expect(parseCloudProjectScopeQuery('项目空间：官', labels)).toBe('官')
    expect(parseCloudProjectScopeQuery('项目空间:', labels)).toBe('')
  })

  test('matches scope labels case-insensitively', () => {
    expect(parseCloudProjectScopeQuery('Project-Space:web', labels)).toBe('web')
  })

  test('returns null when the head is not a scope label', () => {
    expect(parseCloudProjectScopeQuery('云空间:官', labels)).toBeNull()
    expect(parseCloudProjectScopeQuery('官网', labels)).toBeNull()
    expect(parseCloudProjectScopeQuery(':官', labels)).toBeNull()
  })

  test('returns the keyword after whitespace, matching typed phrases', () => {
    expect(parseCloudProjectScopeQuery('项目空间 新建项目', labels)).toBe('新建项目')
    expect(parseCloudProjectScopeQuery('项目空间 ', labels)).toBe('')
    expect(parseCloudProjectScopeQuery('项目空间  官', labels)).toBe('官')
  })

  test('prefers the longest label so labels with spaces parse correctly', () => {
    expect(parseCloudProjectScopeQuery('project space web', labels)).toBe('web')
    expect(parseCloudProjectScopeQuery('project-space new project', labels)).toBe('new project')
  })

  test('returns null for a bare scope label without a separator', () => {
    expect(parseCloudProjectScopeQuery('项目空间', labels)).toBeNull()
    expect(parseCloudProjectScopeQuery('项目空间abc', labels)).toBeNull()
  })
})
