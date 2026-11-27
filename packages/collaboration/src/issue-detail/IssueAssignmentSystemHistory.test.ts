import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import { createCollaborationTranslator } from '../i18n'
import { assignmentHistoryLabels, IssueAssignmentHistoryList } from './IssueHistoryLists'

it('labels system assignments without exposing the reserved user identifier', () => {
  const html = renderToStaticMarkup(createElement(IssueAssignmentHistoryList, {
    entries: [{ by_user_id: 0, to_type: 'agent', to_id: 'worker', to_name: 'Worker', action: 'assign', at: '2026-10-31T00:00:00Z' }],
    memberName: () => null,
    labels: assignmentHistoryLabels(createCollaborationTranslator('en')),
  }))
  expect(html).toContain('System')
  expect(html).toContain('Worker')
  expect(html).not.toContain('#0')
})

it.each([false, true])('labels legacy and explicit redelivery history (marked=%s)', marked => {
  const html = renderToStaticMarkup(
    createElement(IssueAssignmentHistoryList, {
      entries: [
        {
          by_user_id: 1,
          to_type: 'user',
          to_id: '2',
          action: 'reassign',
          ...(marked ? { redeliver: true } : {}),
          at: '2026-10-31T00:00:00Z',
        },
      ],
      memberName: userId => `User ${userId}`,
      labels: assignmentHistoryLabels(createCollaborationTranslator('en')),
    })
  )
  expect(html).toContain(marked ? 'Redeliver' : 'Reassign')
})
