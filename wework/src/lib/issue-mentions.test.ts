import { describe, expect, test } from 'vitest'
import {
  buildIssueMentionRoute,
  issueMentionProjectStore,
  parseIssueMentionHref,
} from './issue-mentions'

describe('issue mentions', () => {
  test('parses encoded project and issue ids', () => {
    expect(parseIssueMentionHref('wework-issue://2753648597973755964/WEWORK2D8526%2D113')).toEqual({
      projectId: '2753648597973755964',
      issueId: 'WEWORK2D8526-113',
    })
    expect(parseIssueMentionHref('https://example.com')).toBeNull()
    expect(parseIssueMentionHref('wework-issue://project-only')).toBeNull()
  })

  test('builds a board route for the referenced issue', () => {
    expect(
      buildIssueMentionRoute({
        projectId: '2753648597973755964',
        issueId: 'WEWORK2D8526-113',
      })
    ).toBe('/todo?projectStore=backend&projectId=2753648597973755964&itemId=WEWORK2D8526-113')
  })

  test('keeps local board context only for the matching project', () => {
    const address = {
      projectId: 'local-project',
      issueId: 'issue-1',
    }

    expect(
      issueMentionProjectStore(address, '/todo?projectStore=local&projectId=local-project')
    ).toBe('local')
    expect(
      issueMentionProjectStore(address, '/todo?projectStore=local&projectId=another-project')
    ).toBe('backend')
  })
})
