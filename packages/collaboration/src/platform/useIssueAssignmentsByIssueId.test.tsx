// @vitest-environment jsdom

// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { SharedWorkspaceAssignmentsApi } from '../ports/SharedWorkspaceApi'
import type { CollaborationAssignment, CollaborationIssue } from '../types'
import { useIssueAssignmentsByIssueId } from './useIssueAssignmentsByIssueId'

const issue = {
  id: 'issue-1',
} as CollaborationIssue
const issues = [issue]

const assignment = {
  id: 'comment-assignment-1',
  issue_id: issue.id,
} as CollaborationAssignment

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(resolvePromise => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

describe('useIssueAssignmentsByIssueId', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)
  })

  afterEach(() => {
    act(() => root.unmount())
    container.remove()
  })

  it('loads on demand and ignores a pending response after leaving the table', async () => {
    const pending = deferred<CollaborationAssignment[]>()
    const assignmentsApi = {
      list: vi.fn().mockReturnValue(pending.promise),
    } as unknown as SharedWorkspaceAssignmentsApi
    let current: ReturnType<typeof useIssueAssignmentsByIssueId> | undefined
    function Harness({ enabled }: { enabled: boolean }) {
      current = useIssueAssignmentsByIssueId({
        assignmentsApi,
        issues,
        enabled,
      })
      return null
    }

    await act(async () => root.render(<Harness enabled={false} />))
    expect(assignmentsApi.list).not.toHaveBeenCalled()
    await act(async () => root.render(<Harness enabled />))
    expect(assignmentsApi.list).toHaveBeenCalledExactlyOnceWith(issue.id)
    await act(async () => root.render(<Harness enabled={false} />))
    await act(async () => pending.resolve([assignment]))
    expect(current?.assignmentsByIssueId).toEqual({})
  })

  it('does not let an older load overwrite a committed assignment mutation', async () => {
    const pending = deferred<CollaborationAssignment[]>()
    const assignmentsApi = {
      list: vi.fn().mockReturnValue(pending.promise),
    } as unknown as SharedWorkspaceAssignmentsApi
    let current: ReturnType<typeof useIssueAssignmentsByIssueId> | undefined

    function Harness() {
      current = useIssueAssignmentsByIssueId({
        assignmentsApi,
        issues,
      })
      return null
    }

    await act(async () => {
      root.render(<Harness />)
    })
    expect(assignmentsApi.list).toHaveBeenCalledWith(issue.id)

    act(() => {
      current?.replaceIssueAssignments(issue.id, [assignment])
    })
    await act(async () => {
      pending.resolve([])
      await pending.promise
    })

    expect(current?.assignmentsByIssueId[issue.id]).toEqual([assignment])
  })
  it("keeps another issue's pending read when one issue is updated", async () => {
    const first = deferred<CollaborationAssignment[]>()
    const second = deferred<CollaborationAssignment[]>()
    const otherIssue = { id: 'issue-2' } as CollaborationIssue
    const otherAssignment = {
      ...assignment,
      id: 'assignment-2',
      issue_id: otherIssue.id,
    }
    const assignmentsApi = {
      list: vi.fn((id: string) => (id === issue.id ? first.promise : second.promise)),
    } as unknown as SharedWorkspaceAssignmentsApi
    let current: ReturnType<typeof useIssueAssignmentsByIssueId> | undefined
    const pair = [issue, otherIssue]
    function Harness() {
      current = useIssueAssignmentsByIssueId({ assignmentsApi, issues: pair })
      return null
    }
    await act(async () => root.render(<Harness />))
    act(() => current?.replaceIssueAssignments(issue.id, [assignment]))
    await act(async () => {
      first.resolve([])
      second.resolve([otherAssignment])
    })
    expect(current?.assignmentsByIssueId).toEqual({
      [issue.id]: [assignment],
      [otherIssue.id]: [otherAssignment],
    })
  })

  it('isolates the same issue ID across API owners and ignores detached responses', async () => {
    const oldRead = deferred<CollaborationAssignment[]>()
    const nextRead = deferred<CollaborationAssignment[]>()
    const oldApi = {
      list: vi.fn(() => oldRead.promise),
    } as unknown as SharedWorkspaceAssignmentsApi
    const nextApi = {
      list: vi.fn(() => nextRead.promise),
    } as unknown as SharedWorkspaceAssignmentsApi
    let current: ReturnType<typeof useIssueAssignmentsByIssueId> | undefined
    function Harness({ api }: { api: SharedWorkspaceAssignmentsApi }) {
      current = useIssueAssignmentsByIssueId({ assignmentsApi: api, issues })
      return null
    }
    await act(async () => root.render(<Harness api={oldApi} />))
    await act(async () => root.render(<Harness api={nextApi} />))
    await act(async () => oldRead.resolve([assignment]))
    expect(current?.assignmentsByIssueId[issue.id]).toEqual([])
    const nextAssignment = { ...assignment, id: 'new-owner-assignment' }
    await act(async () => nextRead.resolve([nextAssignment]))
    expect(current?.assignmentsByIssueId[issue.id]).toEqual([nextAssignment])
  })

  it('retains settled assignments on refresh failure and drops removed issues', async () => {
    const assignmentsApi = {
      list: vi.fn().mockResolvedValueOnce([assignment]).mockRejectedValueOnce(new Error('offline')),
    } as unknown as SharedWorkspaceAssignmentsApi
    let current: ReturnType<typeof useIssueAssignmentsByIssueId> | undefined
    function Harness({ entries }: { entries: CollaborationIssue[] }) {
      current = useIssueAssignmentsByIssueId({
        assignmentsApi,
        issues: entries,
      })
      return null
    }
    await act(async () => root.render(<Harness entries={issues} />))
    expect(current?.assignmentsByIssueId[issue.id]).toEqual([assignment])
    await act(async () => root.render(<Harness entries={[...issues]} />))
    expect(assignmentsApi.list).toHaveBeenCalledTimes(2)
    expect(current?.assignmentsByIssueId[issue.id]).toEqual([assignment])
    await act(async () => root.render(<Harness entries={[]} />))
    expect(current?.assignmentsByIssueId).toEqual({})
  })

  it('allows committed local assignment updates without an assignments API', async () => {
    let current: ReturnType<typeof useIssueAssignmentsByIssueId> | undefined
    function Harness() {
      current = useIssueAssignmentsByIssueId({
        assignmentsApi: undefined,
        issues,
      })
      return null
    }
    await act(async () => root.render(<Harness />))
    expect(current?.assignmentsByIssueId).toEqual({ [issue.id]: [] })
    act(() => current?.replaceIssueAssignments(issue.id, [assignment]))
    expect(current?.assignmentsByIssueId[issue.id]).toEqual([assignment])
  })
})
