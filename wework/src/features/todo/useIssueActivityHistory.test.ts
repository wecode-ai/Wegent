import type { CloudLoopItem } from '@/api/deliveries'
import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useIssueActivityHistory } from './useIssueActivityHistory'

const assignment = {
  by_user_id: 1,
  to_type: 'user' as const,
  to_id: '2',
  to_name: 'Grace',
  action: 'assign' as const,
  at: '2026-10-10T01:00:00Z',
}
const status = {
  from_status: '',
  to_status: 'inbox',
  trigger: 'create',
  by_user_id: 1,
  at: '2026-10-10T01:00:00Z',
}
const task = { id: 'ISSUE-1', version: 1 } as CloudLoopItem

describe('useIssueActivityHistory', () => {
  it('uses complete saved history without requesting the Issue again', () => {
    const api = { getLoopItem: vi.fn() }
    const { result } = renderHook(() =>
      useIssueActivityHistory({ ...task, assignment_history: [assignment] }, [status], true, api)
    )
    expect(result.current).toEqual({
      loading: false,
      statusHistory: [status],
      assignmentHistory: [assignment],
    })
    expect(api.getLoopItem).not.toHaveBeenCalled()
  })

  it('loads assignments even when the board already supplies status history', async () => {
    const api = {
      getLoopItem: vi.fn().mockResolvedValue({ ...task, assignment_history: [assignment] }),
    }
    const { result } = renderHook(() => useIssueActivityHistory(task, [status], true, api))
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.assignmentHistory).toEqual([assignment]))
    expect(result.current.loading).toBe(false)
    expect(result.current.statusHistory).toEqual([status])
    expect(api.getLoopItem).toHaveBeenCalledExactlyOnceWith(task.id)
  })

  it('refreshes missing history on a version change without hiding the previous revision', async () => {
    const next = { ...assignment, action: 'unassign' as const, to_type: null, to_id: null }
    let finish!: (item: CloudLoopItem) => void
    const api = {
      getLoopItem: vi
        .fn()
        .mockResolvedValueOnce({ ...task, assignment_history: [assignment] })
        .mockImplementationOnce(
          () =>
            new Promise<CloudLoopItem>(resolve => {
              finish = resolve
            })
        ),
    }
    const { result, rerender } = renderHook(
      ({ version }) => useIssueActivityHistory({ ...task, version }, [status], true, api),
      { initialProps: { version: 1 } }
    )
    await waitFor(() => expect(result.current.assignmentHistory).toEqual([assignment]))
    rerender({ version: 2 })
    expect(result.current.loading).toBe(true)
    expect(result.current.assignmentHistory).toEqual([assignment])
    await act(async () => finish({ ...task, version: 2, assignment_history: [assignment, next] }))
    expect(result.current.assignmentHistory).toEqual([assignment, next])
    expect(result.current.loading).toBe(false)
  })

  it('does not expose a late response from a different Issue', async () => {
    let finish!: (item: CloudLoopItem) => void
    const api = {
      getLoopItem: vi
        .fn()
        .mockImplementationOnce(
          () =>
            new Promise<CloudLoopItem>(resolve => {
              finish = resolve
            })
        )
        .mockResolvedValueOnce({ ...task, id: 'ISSUE-2', assignment_history: [] }),
    }
    const { result, rerender } = renderHook(
      ({ id }) => useIssueActivityHistory({ ...task, id }, [status], true, api),
      { initialProps: { id: task.id } }
    )
    rerender({ id: 'ISSUE-2' })
    await act(async () => finish({ ...task, assignment_history: [assignment] }))
    expect(result.current.assignmentHistory).toEqual([])
  })

  it('leaves ordinary chat views free of Issue history requests', () => {
    const api = { getLoopItem: vi.fn() }
    const { result } = renderHook(() => useIssueActivityHistory(task, [], false, api))
    expect(result.current.loading).toBe(false)
    expect(api.getLoopItem).not.toHaveBeenCalled()
  })

  it('settles a failed history request so existing comments remain readable', async () => {
    const api = { getLoopItem: vi.fn().mockRejectedValue(new Error('History unavailable')) }
    const { result } = renderHook(() => useIssueActivityHistory(task, [], true, api))
    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.assignmentHistory).toEqual([])
  })

  it('does not use another API source to mark the same Issue history ready', async () => {
    const first = {
      getLoopItem: vi.fn().mockResolvedValue({ ...task, assignment_history: [assignment] }),
    }
    let finish!: (item: CloudLoopItem) => void
    const second = {
      getLoopItem: vi.fn(
        () =>
          new Promise<CloudLoopItem>(resolve => {
            finish = resolve
          })
      ),
    }
    const { result, rerender } = renderHook(
      ({ api }) => useIssueActivityHistory(task, [], true, api),
      { initialProps: { api: first } }
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    rerender({ api: second })
    expect(result.current.loading).toBe(true)
    expect(result.current.assignmentHistory).toEqual([])
    await act(async () => finish({ ...task, assignment_history: [] }))
    expect(result.current.loading).toBe(false)
  })

  it('preserves already displayed history when a later revision fails to load', async () => {
    const api = {
      getLoopItem: vi
        .fn()
        .mockResolvedValueOnce({ ...task, assignment_history: [assignment] })
        .mockRejectedValueOnce(new Error('Refresh unavailable')),
    }
    const { result, rerender } = renderHook(
      ({ version }) => useIssueActivityHistory({ ...task, version }, [], true, api),
      { initialProps: { version: 1 } }
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    rerender({ version: 2 })
    expect(result.current.assignmentHistory).toEqual([assignment])
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.assignmentHistory).toEqual([assignment])
  })
})
