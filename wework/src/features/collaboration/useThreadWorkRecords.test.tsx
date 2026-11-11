import { act, renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type {
  CollaborationIssue,
  CollaborationProject,
  SharedWorkspaceApi,
  WorkspaceTaskBinding,
} from '@wegent/collaboration'
import { ApiError } from '@/api/http'
import type { ThreadActionContext } from './threadActions'
import { useThreadWorkRecords } from './useThreadWorkRecords'

vi.mock('@/lib/blobDownload', () => ({ saveBlobToDownloads: vi.fn() }))

const timestamp = '2026-11-11T00:00:00Z'
function binding(id: string, patch: Partial<WorkspaceTaskBinding> = {}): WorkspaceTaskBinding {
  return {
    id,
    projectId: 'group',
    issueId: 'thread',
    taskUserId: 0,
    deviceId: 'device',
    taskId: id,
    taskTitle: id,
    backendTaskId: null,
    linkedAt: timestamp,
    ...patch,
  }
}

function records(name: string, group = 'group', thread = 'thread') {
  return {
    bindings: [binding(name, { projectId: group, issueId: thread })],
    assignments: [{ id: name, issue_id: thread }],
    deliveries: [
      {
        id: name,
        issueId: thread,
        createdByUserId: 0,
        assets: [],
        createdAt: timestamp,
        deliveredAt: timestamp,
        status: 'delivered',
      },
    ],
  }
}

function setup(value = records('record')) {
  const bindings = vi.fn().mockResolvedValue(value.bindings)
  const assignments = vi.fn().mockResolvedValue(value.assignments)
  const deliveries = vi.fn().mockResolvedValue(value.deliveries)
  const api = {
    issues: {},
    attachments: {},
    collaborators: {},
    members: {},
    agents: {},
    taskBindings: { list: bindings },
    assignments: { list: assignments },
    deliveries: { list: deliveries },
  } as unknown as SharedWorkspaceApi
  const context: ThreadActionContext = {
    accountScope: 'account',
    sourceStore: 'local',
    api,
    group: {
      id: 'group',
      project_key: 'G',
      name: 'Group',
      description: '',
      status: 'active',
      role: 'Developer',
      version: 1,
      created_by_user_id: 0,
      created_at: timestamp,
      updated_at: timestamp,
    },
    project: {
      id: 'group',
      project_store: 'local',
      resource_type: 'chat_group',
    } as CollaborationProject,
    item: {
      id: 'thread',
      group_id: 'group',
      cloud_project_id: 'group',
      version: 1,
    } as CollaborationIssue,
    participation: {
      current_user_id: 0,
      joined: true,
      can_comment: true,
      participants: [],
      show_in_sidebar: true,
    },
    requestLeave: vi.fn(),
  }
  return {
    context,
    bindings,
    assignments,
    deliveries,
    methods: [bindings, assignments, deliveries],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(done => {
    resolve = done
  })
  return { promise, resolve }
}

type WorkRecords = ReturnType<typeof useThreadWorkRecords>
function all(result: WorkRecords) {
  return [result.bindings, result.assignments, result.deliveries]
}
async function expectRecords(current: () => WorkRecords, name: string) {
  await waitFor(() => {
    for (const record of all(current())) {
      expect(record.loading).toBe(false)
      expect(record.error).toBe(false)
      expect(record.items.map(item => item.id)).toEqual([name])
    }
  })
}

describe('Thread work records use the real hook and shared Issue detail adapter', () => {
  it('loads canonical zero but exposes only that actor’s bindings in the exact group and Thread', async () => {
    const source = setup()
    source.bindings.mockResolvedValue([
      binding('own-zero'),
      binding('another-user', { taskUserId: 8 }),
      binding('other-group', { projectId: 'other' }),
      binding('other-thread', { issueId: 'other' }),
      binding('project-only', { issueId: null }),
    ])
    const { result } = renderHook(() => useThreadWorkRecords(source.context))
    await waitFor(() => expect(result.current.bindings.loading).toBe(false))
    expect(result.current.actor).toBe(0)
    expect(result.current.bindings.items.map(item => item.id)).toEqual(['own-zero'])
    expect(source.bindings).toHaveBeenCalledExactlyOnceWith('thread', 'group')
    expect(source.assignments).toHaveBeenCalledExactlyOnceWith('thread')
    expect(source.deliveries).toHaveBeenCalledExactlyOnceWith('thread')
  })

  it('does not request any records while the current actor is unknown', async () => {
    const source = setup()
    source.context.participation = null
    const { result } = renderHook(() => useThreadWorkRecords(source.context))
    await act(async () => {
      await Promise.resolve()
    })
    expect(result.current.actor).toBeUndefined()
    for (const record of all(result.current)) expect(record.items).toEqual([])
    for (const method of source.methods) expect(method).not.toHaveBeenCalled()
    act(() => result.current.refresh())
    await act(async () => {
      await Promise.resolve()
    })
    for (const method of source.methods) expect(method).not.toHaveBeenCalled()
  })

  it.each(['account', 'store', 'group', 'thread', 'api'] as const)(
    'discards every late result after changing %s',
    async dimension => {
      const source = setup()
      const old = records('old-private')
      const pending = [
        deferred<typeof old.bindings>(),
        deferred<typeof old.assignments>(),
        deferred<typeof old.deliveries>(),
      ] as const
      source.bindings.mockReturnValueOnce(pending[0].promise)
      source.assignments.mockReturnValueOnce(pending[1].promise)
      source.deliveries.mockReturnValueOnce(pending[2].promise)
      const next: ThreadActionContext = { ...source.context }
      if (dimension === 'account') next.accountScope = 'other-account'
      if (dimension === 'store') next.sourceStore = 'cloud'
      if (dimension === 'group') next.group = { ...next.group, id: 'other-group' }
      if (dimension === 'thread') next.item = { ...next.item, id: 'other-thread' }
      const fresh = records('current', next.group.id, next.item.id)
      const currentSource = dimension === 'api' ? setup(fresh) : source
      currentSource.bindings.mockResolvedValue(fresh.bindings)
      currentSource.assignments.mockResolvedValue(fresh.assignments)
      currentSource.deliveries.mockResolvedValue(fresh.deliveries)
      next.api = currentSource.context.api
      const view = renderHook(({ context }) => useThreadWorkRecords(context), {
        initialProps: { context: source.context },
      })
      await waitFor(() => {
        for (const method of source.methods) expect(method).toHaveBeenCalledOnce()
      })
      view.rerender({ context: next })
      for (const record of all(view.result.current)) expect(record.items).toEqual([])
      await expectRecords(() => view.result.current, 'current')
      await act(async () => {
        pending[0].resolve(old.bindings)
        pending[1].resolve(old.assignments)
        pending[2].resolve(old.deliveries)
      })
      await expectRecords(() => view.result.current, 'current')
    }
  )

  it('hides previously loaded records immediately when the account changes and the new read is pending', async () => {
    const source = setup(records('old-private'))
    const view = renderHook(({ context }) => useThreadWorkRecords(context), {
      initialProps: { context: source.context },
    })
    await expectRecords(() => view.result.current, 'old-private')
    const pending = deferred<never[]>()
    for (const method of source.methods) method.mockReturnValueOnce(pending.promise)
    view.rerender({ context: { ...source.context, accountScope: 'other-account' } })
    for (const record of all(view.result.current)) expect(record.items).toEqual([])
    await act(async () => pending.resolve([]))
    await waitFor(() => {
      for (const record of all(view.result.current)) expect(record.loading).toBe(false)
    })
    for (const record of all(view.result.current)) expect(record.items).toEqual([])
  })

  it.each([
    new Error('Network unavailable'),
    new ApiError('Server unavailable', 500),
    ...[401, 403, 404].map(status => new ApiError('Access unavailable', status)),
  ])(
    'retains only transient-failure records and recovers on explicit refresh (%s)',
    async error => {
      const source = setup(records('saved'))
      const { result } = renderHook(() => useThreadWorkRecords(source.context))
      await expectRecords(() => result.current, 'saved')
      for (const method of source.methods) method.mockRejectedValueOnce(error)
      act(() => result.current.refresh())
      await waitFor(() => {
        for (const record of all(result.current)) expect(record.error).toBe(true)
      })
      const denied = error instanceof ApiError && [401, 403, 404].includes(error.status)
      for (const record of all(result.current)) {
        expect(record.loading).toBe(false)
        expect(record.items.map(item => item.id)).toEqual(denied ? [] : ['saved'])
      }
      act(() => result.current.refresh())
      await expectRecords(() => result.current, 'saved')
      for (const method of source.methods) expect(method).toHaveBeenCalledTimes(3)
    }
  )
})
