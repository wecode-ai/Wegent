import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { IssueAssignmentHistoryList } from './IssueHistoryLists'

it('labels system assignments without exposing the reserved user identifier', () => {
  const html = renderToStaticMarkup(createElement(IssueAssignmentHistoryList, {
    entries: [{ by_user_id: 0, to_type: 'agent', to_id: 'worker', to_name: 'Worker', action: 'assign', at: '2026-10-31T00:00:00Z' }],
    memberName: () => null,
    labels: { team: 'Agent', agent: 'Bot', group: 'Group', system: 'System', unassigned: 'Unassigned', actions: { assign: 'Assign', reassign: 'Reassign', unassign: 'Unassign' } },
  }))
  expect(html).toContain('System')
  expect(html).toContain('Worker')
  expect(html).not.toContain('#0')
})
