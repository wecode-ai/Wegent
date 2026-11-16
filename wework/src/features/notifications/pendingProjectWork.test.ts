import { expect, it } from 'vitest'
import type { IssueHumanRequest, IssueParticipationSource } from '@wegent/collaboration'
import { projectIssueNeedsInput } from './pendingProjectWork'

const question: IssueHumanRequest = {
  id: 'question',
  project_id: 'project',
  issue_id: 'issue',
  root_comment_id: 'root',
  runtime_device_id: 'device',
  runtime_task_id: 'task',
  item_id: 'question',
  question: 'Choose scope',
  recipient_user_id: 7,
  recipient_name: 'Me',
  blocks_progress: false,
  status: 'resolved',
  version: 2,
  created_at: '2026-11-10T00:00:00Z',
  updated_at: '2026-11-10T00:01:00Z',
}
const issue: IssueParticipationSource = {
  status: 'pending',
  created_by_user_id: 7,
  human_requests: [question],
}

it.each(['resolved', 'cancelled'] as const)(
  'does not recreate %s questions as owner work',
  status => {
    expect(projectIssueNeedsInput({ ...issue, human_requests: [{ ...question, status }] }, 7)).toBe(
      false
    )
  }
)

it.each(['pending', 'answering'] as const)(
  'preserves an unresolved %s request for its viewer',
  status => {
    const current = { ...issue, human_requests: [{ ...question, status }] }
    expect(projectIssueNeedsInput(current, 7)).toBe(true)
    expect(projectIssueNeedsInput(current, [0, 7])).toBe(true)
    expect(projectIssueNeedsInput(current, 8)).toBe(false)
  }
)

it('does not replace another recipient’s pending question with creator work', () => {
  expect(
    projectIssueNeedsInput(
      { ...issue, human_requests: [{ ...question, recipient_user_id: 8, status: 'pending' }] },
      7
    )
  ).toBe(false)
})

it.each(['completed', 'cancelled', 'archived'])('never revives a terminal %s Issue', status => {
  expect(
    projectIssueNeedsInput(
      { ...issue, status, human_requests: [{ ...question, status: 'pending' }] },
      7
    )
  ).toBe(false)
})

it('preserves ordinary work that has never had a structured question', () => {
  expect(projectIssueNeedsInput({ ...issue, human_requests: [] }, 7)).toBe(true)
  expect(projectIssueNeedsInput({ ...issue, human_requests: undefined }, 7)).toBe(true)
  expect(
    projectIssueNeedsInput({ ...issue, human_requests: [], execution_state: 'running' }, 7)
  ).toBe(false)
})

it.each([
  ['2026-11-10T00:00:00Z', '7', false],
  ['2026-11-10T00:01:00Z', '7', false],
  ['2026-11-10T00:02:00Z', '7', true],
  ['2026-11-10T00:02:00Z', '8', false],
  ['invalid', '7', false],
] as const)('requires an explicit later assignment (%s, %s)', (at, toId, expected) => {
  expect(
    projectIssueNeedsInput(
      { ...issue, assignment_history: [{ to_type: 'user', to_id: toId, at }] },
      7
    )
  ).toBe(expected)
})
