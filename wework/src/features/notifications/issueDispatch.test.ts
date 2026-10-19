import { describe, expect, it, vi } from 'vitest'
import { requestIssueDispatch, subscribeIssueDispatch } from './issueDispatch'
import type { IssueDispatchPersonalTaskAction } from './NotificationTaskSourceContext'

function assignment(
  overrides: Partial<IssueDispatchPersonalTaskAction> = {}
): IssueDispatchPersonalTaskAction {
  return {
    projectId: '12',
    itemId: 'issue-1',
    issueId: 'issue-1',
    dispatchTaskId: 'human-assignment-1',
    humanAssignmentId: 'human-assignment-1',
    dispatchId: 'direct-human:assignment-1',
    roundId: 'direct',
    assignmentId: 'collect-cpu',
    taskTitle: '采集 CPU 证据',
    instructions: '只读采集 CPU 证据并提交交付。',
    idempotencyKey: 'human-assignment:human-assignment-1',
    ...overrides,
  }
}

describe('issue dispatch requests', () => {
  it('waits for the board that shows the Issue and answers it once', () => {
    const answer = vi.fn()
    requestIssueDispatch(assignment())

    const unsubscribe = subscribeIssueDispatch({ shows: () => false, answer })
    expect(answer).not.toHaveBeenCalled()

    const boards = subscribeIssueDispatch({
      shows: action => action.itemId === 'issue-1',
      answer,
    })
    expect(answer).toHaveBeenCalledTimes(1)

    // A second board for the same Issue joins later and finds nothing left.
    const late = subscribeIssueDispatch({ shows: () => true, answer })
    expect(answer).toHaveBeenCalledTimes(1)

    unsubscribe()
    boards()
    late()
  })

  it('answers a request that arrives while its board is already open', () => {
    const answer = vi.fn()
    const boards = subscribeIssueDispatch({
      shows: action => action.projectId === '12',
      answer,
    })

    requestIssueDispatch(assignment())

    expect(answer).toHaveBeenCalledTimes(1)
    boards()
  })

  it('keeps one request per assignment when the reader clicks twice', () => {
    const answer = vi.fn()
    requestIssueDispatch(assignment())
    requestIssueDispatch(assignment())

    const boards = subscribeIssueDispatch({ shows: () => true, answer })

    expect(answer).toHaveBeenCalledTimes(1)
    boards()
  })

  it('drops a click that no board reached in time', () => {
    vi.useFakeTimers()
    try {
      requestIssueDispatch(assignment())
      vi.advanceTimersByTime(10 * 60_000)

      const answer = vi.fn()
      const boards = subscribeIssueDispatch({ shows: () => true, answer })

      expect(answer).not.toHaveBeenCalled()
      boards()
    } finally {
      vi.useRealTimers()
    }
  })
})
