import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CollaborationIssue, SharedWorkspaceApi } from '@wegent/collaboration'
import { useLegacyThreadDestination } from './useLegacyThreadDestination'

const thread = {
  id: 'OLD-1',
  group_id: 'group-1',
  cloud_project_id: 'group-1',
} as CollaborationIssue
function api(get = vi.fn(async () => thread)) {
  return { issues: { get }, projects: { get: vi.fn() } } as unknown as SharedWorkspaceApi
}
const options = {
  itemId: 'OLD-1',
  store: 'local' as const,
  commentId: 'comment-1',
  focusRequest: 'focus-1',
}

describe('retained Thread destinations', () => {
  it('opens the authoritative group without loading or requiring the old project', async () => {
    const source = api()
    const navigate = vi.fn()
    renderHook(() => useLegacyThreadDestination({ ...options, api: source, onNavigate: navigate }))
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce())
    const params = new URLSearchParams(navigate.mock.calls[0]![0])
    expect(Object.fromEntries(params)).toMatchObject({
      groupId: 'group-1',
      threadId: 'OLD-1',
      groupStore: 'local',
      commentId: 'comment-1',
      focusRequest: 'focus-1',
    })
    expect(params.has('projectId')).toBe(false)
    expect(source.projects.get).not.toHaveBeenCalled()
  })

  it('keeps a retained project Issue in the project flow', async () => {
    const navigate = vi.fn()
    const source = api(
      vi.fn(async () => ({ id: 'OLD-1', cloud_project_id: 'original' }) as CollaborationIssue)
    )
    const { result } = renderHook(() =>
      useLegacyThreadDestination({ ...options, api: source, onNavigate: navigate })
    )
    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.failed).toBe(false)
    expect(navigate).not.toHaveBeenCalled()
  })

  it('stops after denied access and retries the same source only on request', async () => {
    const get = vi.fn(async () => thread).mockRejectedValueOnce(new Error('Forbidden'))
    const source = api(get)
    const navigate = vi.fn()
    const { result } = renderHook(() =>
      useLegacyThreadDestination({ ...options, api: source, onNavigate: navigate })
    )
    await waitFor(() => expect(result.current.failed).toBe(true))
    expect(navigate).not.toHaveBeenCalled()
    expect(source.projects.get).not.toHaveBeenCalled()
    act(() => result.current.retry())
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce())
    expect(get).toHaveBeenCalledTimes(2)
  })

  it('discards a result from an earlier source identity', async () => {
    let complete: (issue: CollaborationIssue) => void = () => {}
    const old = api(
      vi.fn(
        () =>
          new Promise<CollaborationIssue>(resolve => {
            complete = resolve
          })
      )
    )
    const current = api(vi.fn(async () => ({ ...thread, group_id: 'current-group' })))
    const navigate = vi.fn()
    const view = renderHook(
      ({ source }) => useLegacyThreadDestination({ ...options, api: source, onNavigate: navigate }),
      { initialProps: { source: old } }
    )
    view.rerender({ source: current })
    await waitFor(() => expect(navigate).toHaveBeenCalledOnce())
    await act(async () => {
      complete(thread)
    })
    expect(navigate).toHaveBeenCalledOnce()
    expect(navigate.mock.calls[0]![0]).toContain('groupId=current-group')
  })
})
