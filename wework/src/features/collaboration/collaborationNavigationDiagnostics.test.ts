import { afterEach, describe, expect, it, vi } from 'vitest'
import { reportCollaborationNavigation } from './collaborationNavigationDiagnostics'

afterEach(() => vi.restoreAllMocks())

describe('collaboration navigation diagnostics', () => {
  it('retains navigation gates but excludes private route and account data', () => {
    const output = vi.spyOn(console, 'debug').mockImplementation(() => {})
    reportCollaborationNavigation(
      'publish-requested',
      '?collaborationView=projects&groupId=private-group&threadId=private-thread&token=private-token',
      {
        allowed: false,
        mounted: true,
        boundTab: true,
        ownedTab: false,
        accountId: 'private-account',
      } as Parameters<typeof reportCollaborationNavigation>[2]
    )
    const entry = JSON.parse(output.mock.calls[0][1])
    expect(entry).toMatchObject({
      phase: 'publish-requested',
      targetView: 'projects',
      allowed: false,
      mounted: true,
      boundTab: true,
      ownedTab: false,
    })
    expect(JSON.stringify(output.mock.calls)).not.toMatch(
      /private-|groupId|threadId|token|accountId/
    )
  })

  it('classifies unrecognized view values rather than logging arbitrary query text', () => {
    const output = vi.spyOn(console, 'debug').mockImplementation(() => {})
    reportCollaborationNavigation('view-rendered', '?collaborationView=private-mode', {
      renderedView: 'private-rendered-mode',
    })
    expect(JSON.parse(output.mock.calls[0][1])).toMatchObject({
      targetView: 'unspecified',
      renderedView: 'unspecified',
    })
    expect(JSON.stringify(output.mock.calls)).not.toContain('private-')
  })
})
