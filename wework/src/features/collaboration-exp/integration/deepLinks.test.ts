// @vitest-environment node
import { describe, expect, test } from 'vitest'
import {
  buildCollaborationExpRoute,
  buildCollaborationExpScheme,
  parseCollaborationExpDeepLink,
} from './deepLinks'

describe('collaboration experiment deep links', () => {
  test('retains project source, issue, tree identity, discussion and unrelated query state', () => {
    const params = new URLSearchParams({
      view: 'tasks',
      projectStore: 'local',
      projectId: 'project/#1',
      issueId: 'ISSUE/#1',
      nodeId: 'task:1',
      discussion: 'private:user:1',
      search: 'release + docs',
      status: 'in_progress',
      relevance: 'related',
      projectView: 'plan',
      future: 'keep',
    })
    const scheme = buildCollaborationExpScheme(params)
    const route = parseCollaborationExpDeepLink(scheme)!
    expect(new URL(route, 'https://local').searchParams).toEqual(params)
    expect(parseCollaborationExpDeepLink(route)).toBe(route)
  })

  test('updates only selected fields without mutating the caller or losing other scope', () => {
    const params = new URLSearchParams({
      view: 'tasks',
      projectStore: 'backend',
      projectId: '12',
      issueId: 'old',
      discussion: 'draft',
      future: 'keep',
    })
    const route = buildCollaborationExpRoute(params, { issueId: 'new', discussion: null })
    const result = new URL(route, 'https://local').searchParams
    expect(Object.fromEntries(result)).toEqual({
      view: 'tasks',
      projectStore: 'backend',
      projectId: '12',
      issueId: 'new',
      future: 'keep',
    })
    expect(params.get('issueId')).toBe('old')
    expect(params.get('discussion')).toBe('draft')
  })

  test.each([
    '/todo?projectId=12',
    '//collaboration-exp',
    'https://evil.test/collaboration-exp',
    'wework://collaboration-exp/other',
    'wework://user@collaboration-exp',
    'wework://collaboration-exp:8000',
    'wework://collaboration-exp?projectStore=guess',
    'wework://collaboration-exp#other',
    ' wework://collaboration-exp',
    'wework://collaboration-exp\n',
  ])('rejects a foreign or malformed destination: %s', input => {
    expect(parseCollaborationExpDeepLink(input)).toBeNull()
  })
})
