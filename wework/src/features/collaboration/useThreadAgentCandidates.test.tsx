import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { SharedWorkspaceApi, WorkspaceProjectAgent } from '@wegent/collaboration'
import type { ChatGroupApi, ThreadProjectLink } from '@/api/chatGroups'
import { useThreadAgentCandidates } from './useThreadAgentCandidates'

const agent = (id: string, patch: Record<string, unknown> = {}) =>
  ({ id, name: 'Reviewer', status: 'active', ...patch }) as WorkspaceProjectAgent
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}
function setup() {
  const list = vi.fn(async (id: string) => [agent(id)])
  const projectLink = vi.fn(
    async () => ({ project: null, restricted: false, thread_version: 1 }) as ThreadProjectLink
  )
  const api = { list } as unknown as SharedWorkspaceApi['agents']
  const groups = { projectLink } as unknown as ChatGroupApi
  const props = {
    api,
    groups,
    groupId: 'group',
    threadId: 'thread' as string | null,
    accountScope: 'account',
    enabled: true,
    ownerRevision: {},
    threadRevision: 1,
  }
  const view = renderHook(values => useThreadAgentCandidates(values), { initialProps: props })
  return { ...view, props, list, projectLink }
}

describe('Thread Agent mention candidates follow actual resource sources', () => {
  it('uses group agents without requiring any project or global resource fallback', async () => {
    const { result, list } = setup()
    await waitFor(() => expect(result.current.pending).toBe(false))
    expect(result.current.agents.map(agent => agent.id)).toEqual(['group'])
    expect(list.mock.calls).toEqual([['group', { forceRefresh: true }]])
  })

  it('retains working group agents while the optional project source fails', async () => {
    const view = setup()
    const link = deferred<ThreadProjectLink>()
    view.projectLink.mockReturnValue(link.promise)
    act(() => view.result.current.retry())
    await waitFor(() => expect(view.result.current.agents).toHaveLength(1))
    expect(view.result.current.pending).toBe(true)
    await act(async () =>
      link.resolve({
        project: { id: 'project', name: 'Plan' },
        restricted: false,
        thread_version: 1,
      })
    )
    view.list.mockImplementation(async id => {
      if (id === 'project') throw new Error('Revoked project source')
      return [agent(id)]
    })
    act(() => view.result.current.retry())
    await waitFor(() => expect(view.result.current.failed).toBe(true))
    expect(view.result.current.agents.map(agent => agent.id)).toEqual(['group'])
  })

  it('keeps same-name group/project bindings distinct and excludes revoked or archived agents', async () => {
    const view = setup()
    view.projectLink.mockResolvedValue({
      project: { id: 'project', name: 'Plan' },
      restricted: false,
      thread_version: 2,
    })
    view.list.mockImplementation(async id => [
      agent(id),
      agent(`${id}-revoked`, { can_use: false }),
      agent(`${id}-archived`, { status: 'archived' }),
    ])
    act(() => view.result.current.retry())
    await waitFor(() => expect(view.result.current.pending).toBe(false))
    expect(view.result.current.agents.map(agent => [agent.id, agent.source])).toEqual([
      ['group', { kind: 'group' }],
      ['project', { kind: 'project', name: 'Plan' }],
    ])
  })

  it('discards old account results while the new identity loads', async () => {
    const view = setup()
    await waitFor(() => expect(view.result.current.pending).toBe(false))
    const pending = deferred<WorkspaceProjectAgent[]>()
    view.list.mockReturnValueOnce(pending.promise)
    view.rerender({ ...view.props, accountScope: 'another-account' })
    expect(view.result.current.agents).toEqual([])
    await act(async () => pending.resolve([agent('new-account')]))
    await waitFor(() => expect(view.result.current.agents[0]?.id).toBe('new-account'))
  })

  it('reloads the current project link after reclassification without retaining old candidates', async () => {
    const view = setup()
    view.projectLink.mockResolvedValue({
      project: { id: 'old-project', name: 'Old' },
      restricted: false,
      thread_version: 1,
    })
    act(() => view.result.current.retry())
    await waitFor(() =>
      expect(view.result.current.agents.some(agent => agent.id === 'old-project')).toBe(true)
    )
    view.projectLink.mockResolvedValue({
      project: { id: 'new-project', name: 'New' },
      restricted: false,
      thread_version: 2,
    })
    view.rerender({ ...view.props, threadRevision: 2 })
    expect(view.result.current.agents).toEqual([])
    await waitFor(() =>
      expect(view.result.current.agents.some(agent => agent.id === 'new-project')).toBe(true)
    )
    expect(view.result.current.agents.some(agent => agent.id === 'old-project')).toBe(false)
  })

  it.each(['main-group', 'observer'] as const)(
    'does not offer an ineffective execution entry for %s',
    async kind => {
      const view = setup()
      await waitFor(() => expect(view.result.current.pending).toBe(false))
      view.list.mockClear()
      view.projectLink.mockClear()
      view.rerender({
        ...view.props,
        ...(kind === 'main-group' ? { threadId: null } : { enabled: false }),
      })
      expect(view.result.current.agents).toEqual([])
      await act(async () => {
        await Promise.resolve()
      })
      expect(view.list).not.toHaveBeenCalled()
      expect(view.projectLink).not.toHaveBeenCalled()
    }
  )
})
