// @vitest-environment node
import { expect, it, vi } from 'vitest'
import type { CloudMyWorkItem } from '@/api/deliveries'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { createPendingProjectIssuesStore } from './pendingProjectIssuesStore'

const item = (id: string) => ({ id, cloud_project_id: 'project' }) as CloudMyWorkItem

it('publishes local pages while the backend is pending and keeps them after backend failure', async () => {
  let fail!: (error: Error) => void
  const local = { listMyWork: vi.fn().mockResolvedValue({ items: [item('local')] }) }
  const cloud = {
    listMyWork: vi.fn(
      () =>
        new Promise<{ items: CloudMyWorkItem[] }>((_resolve, reject) => {
          fail = reject
        })
    ),
  }
  const store = createPendingProjectIssuesStore({ local, cloud, userId: 7, localViewer: [0, 7] })
  const stop = store.subscribe(vi.fn())
  await Promise.resolve()
  await Promise.resolve()
  expect(store.getSnapshot().items.map(row => row.item.id)).toEqual(['local'])
  expect(store.getSnapshot().loading).toEqual({ local: false, backend: true })
  fail(new Error('offline'))
  await Promise.resolve()
  await Promise.resolve()
  expect(store.getSnapshot().errors.backend).toBe('offline')
  expect(store.getSnapshot().items.map(row => row.item.id)).toEqual(['local'])
  stop()
})

it('debounces each live source and stops timers and reads after the last subscriber', async () => {
  vi.useFakeTimers()
  try {
    let changed!: () => void
    const release = vi.fn()
    const localClient = {
      subscribeLoopItemChanges: vi.fn(async (receive: () => void) => {
        changed = receive
        return release
      }),
    } as unknown as WorkbenchServices['projectChatClient']
    const local = { listMyWork: vi.fn().mockResolvedValue({ items: [item('local')] }) }
    const cloud = { listMyWork: vi.fn().mockResolvedValue({ items: [] }) }
    const store = createPendingProjectIssuesStore({
      local,
      cloud,
      localClient,
      userId: 7,
      localViewer: 0,
    })
    const first = store.subscribe(vi.fn())
    const second = store.subscribe(vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    expect(local.listMyWork).toHaveBeenCalledTimes(1)
    expect(localClient!.subscribeLoopItemChanges).toHaveBeenCalledTimes(1)
    changed()
    await vi.advanceTimersByTimeAsync(100)
    changed()
    await vi.advanceTimersByTimeAsync(199)
    expect(local.listMyWork).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(local.listMyWork).toHaveBeenCalledTimes(2)
    expect(cloud.listMyWork).toHaveBeenCalledTimes(1)
    first()
    expect(release).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)
    changed()
    second()
    expect(release).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    changed()
    await vi.advanceTimersByTimeAsync(30_000)
    await store.refresh()
    expect(local.listMyWork).toHaveBeenCalledTimes(2)
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})

it('releases a late subscription without publishing its detached read', async () => {
  vi.useFakeTimers()
  try {
    let changed!: () => void
    let connect!: (release: () => void) => void
    let finish!: (result: { items: CloudMyWorkItem[] }) => void
    const release = vi.fn()
    const localClient = {
      subscribeLoopItemChanges: vi.fn((receive: () => void) => {
        changed = receive
        return new Promise(resolve => {
          connect = resolve
        })
      }),
    } as unknown as WorkbenchServices['projectChatClient']
    const local = {
      listMyWork: vi.fn(
        () =>
          new Promise<{ items: CloudMyWorkItem[] }>(resolve => {
            finish = resolve
          })
      ),
    }
    const store = createPendingProjectIssuesStore({ local, localClient, localViewer: 0 })
    const stop = store.subscribe(vi.fn())
    await vi.advanceTimersByTimeAsync(0)
    stop()
    connect(release)
    finish({ items: [item('detached')] })
    await vi.advanceTimersByTimeAsync(0)
    expect(release).toHaveBeenCalledOnce()
    changed()
    expect(store.getSnapshot().items).toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  } finally {
    vi.useRealTimers()
  }
})
