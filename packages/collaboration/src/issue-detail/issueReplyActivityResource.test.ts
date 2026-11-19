import { expect, test, vi } from 'vitest'
import type { RuntimeTaskAddress } from '@wegent/chat-core/runtime'
import type { RuntimeConversationHandlers } from '@wegent/chat-core/runtime-conversation-client'
import type { SharedWorkspaceRuntimeApi } from '../ports/SharedWorkspaceApi'
import { createIssueReplyActivityResource, replyActivityKey } from './issueReplyActivityResource'

const first: RuntimeTaskAddress = { deviceId: 'device-1', taskId: 'task-1' }
const second: RuntimeTaskAddress = { deviceId: 'device-2', taskId: 'task-2' }
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (cause: unknown) => void
  const promise = new Promise<T>((accept, refuse) => {
    resolve = accept
    reject = refuse
  })
  return { promise, resolve, reject }
}
function fixture(addresses = [first]) {
  const connections: {
    address: RuntimeTaskAddress
    handlers: RuntimeConversationHandlers
    stop: ReturnType<typeof vi.fn>
  }[] = []
  const subscribe = vi
    .fn<SharedWorkspaceRuntimeApi['subscribe']>()
    .mockImplementation(async (address, handlers) => {
      const stop = vi.fn()
      connections.push({ address, handlers, stop })
      return stop
    })
  const refresh = vi.fn()
  const resource = createIssueReplyActivityResource({ subscribe }, addresses, refresh)
  return { resource, subscribe, connections, refresh }
}

test('shares one connection group and releases it only after the final subscriber detaches', async () => {
  const f = fixture([first, second])
  expect(f.subscribe).not.toHaveBeenCalled()
  const one = f.resource.subscribe(vi.fn()),
    two = f.resource.subscribe(vi.fn())
  await vi.waitFor(() => expect(f.resource.getSnapshot().ready).toBe(true))
  expect(f.subscribe).toHaveBeenCalledTimes(2)
  expect(f.refresh).toHaveBeenCalledTimes(1)
  one()
  expect(f.connections[0].stop).not.toHaveBeenCalled()
  two()
  expect(f.connections.every(connection => connection.stop.mock.calls.length === 1)).toBe(true)
  expect(f.resource.getSnapshot()).toEqual({
    activity: {},
    ready: false,
    error: null,
  })
  f.resource.reload()
  expect(f.subscribe).toHaveBeenCalledTimes(2)
})

test('keeps the scheduler gate closed until every requested subscription is established', async () => {
  const f = fixture([first, second]),
    pending = deferred<() => void>()
  f.subscribe.mockReturnValueOnce(pending.promise)
  const stop = f.resource.subscribe(vi.fn())
  await vi.waitFor(() => expect(f.connections).toHaveLength(1))
  f.connections[0].handlers.onAssistantStart?.('turn')
  expect(f.resource.getSnapshot()).toMatchObject({
    ready: false,
    activity: { [replyActivityKey(second)]: true },
  })
  expect(f.refresh).not.toHaveBeenCalled()
  const delayedStop = vi.fn()
  pending.resolve(delayedStop)
  await vi.waitFor(() => expect(f.resource.getSnapshot().ready).toBe(true))
  expect(f.refresh).toHaveBeenCalledTimes(1)
  stop()
  expect(delayedStop).toHaveBeenCalledTimes(1)
})

test('closes both established and late-arriving subscriptions when one connection fails', async () => {
  const third = { deviceId: 'device-3', taskId: 'task-3' }
  const f = fixture([first, second, third]),
    pending = deferred<() => void>()
  f.subscribe
    .mockImplementationOnce(async (address, handlers) => {
      const stop = vi.fn()
      f.connections.push({ address, handlers, stop })
      return stop
    })
    .mockRejectedValueOnce(new Error('Subscription denied'))
    .mockReturnValueOnce(pending.promise)
  const stop = f.resource.subscribe(vi.fn())
  await vi.waitFor(() => expect(f.resource.getSnapshot().error).toBe('Subscription denied'))
  expect(f.resource.getSnapshot().ready).toBe(false)
  expect(f.connections[0].stop).toHaveBeenCalledTimes(1)
  const snapshot = f.resource.getSnapshot()
  f.connections[0].handlers.onAssistantSettled?.('turn', 'succeeded')
  expect(f.resource.getSnapshot()).toBe(snapshot)
  const delayedStop = vi.fn()
  pending.resolve(delayedStop)
  await vi.waitFor(() => expect(delayedStop).toHaveBeenCalledTimes(1))
  expect(f.refresh).not.toHaveBeenCalled()
  stop()
  expect(f.connections[0].stop).toHaveBeenCalledTimes(1)
})

test('reports synchronous connection failures and retries only when explicitly requested', async () => {
  const f = fixture()
  f.subscribe.mockImplementationOnce(() => {
    throw new Error('Runtime unavailable')
  })
  const stop = f.resource.subscribe(vi.fn())
  await vi.waitFor(() => expect(f.resource.getSnapshot().error).toBe('Runtime unavailable'))
  expect(f.subscribe).toHaveBeenCalledTimes(1)
  f.resource.reload()
  expect(f.resource.getSnapshot()).toMatchObject({ ready: false, error: null })
  await vi.waitFor(() => expect(f.resource.getSnapshot().ready).toBe(true))
  expect(f.subscribe).toHaveBeenCalledTimes(2)
  stop()
})

test('closes the scheduler gate immediately and coalesces history invalidations before reconnecting', async () => {
  const f = fixture()
  const stop = f.resource.subscribe(vi.fn())
  await vi.waitFor(() => expect(f.resource.getSnapshot().ready).toBe(true))
  const old = f.connections[0]
  old.handlers.onAssistantStart?.('turn')
  expect(f.resource.getSnapshot().activity[replyActivityKey(first)]).toBe(true)
  old.handlers.onHistoryInvalidated?.()
  old.handlers.onHistoryInvalidated?.()
  expect(f.resource.getSnapshot().ready).toBe(false)
  await vi.waitFor(() => expect(f.subscribe).toHaveBeenCalledTimes(2))
  await vi.waitFor(() => expect(f.resource.getSnapshot().ready).toBe(true))
  expect(f.resource.getSnapshot().activity).toEqual({})
  expect(old.stop).toHaveBeenCalledTimes(1)
  expect(f.refresh).toHaveBeenCalledTimes(2)
  const snapshot = f.resource.getSnapshot()
  old.handlers.onAssistantStart?.('late turn')
  old.handlers.onHistoryInvalidated?.()
  expect(f.resource.getSnapshot()).toBe(snapshot)
  expect(f.subscribe).toHaveBeenCalledTimes(2)
  stop()
})

test('disposes a connection that completes after its owner has detached', async () => {
  const f = fixture(),
    pending = deferred<() => void>(),
    delayedStop = vi.fn()
  f.subscribe.mockReturnValueOnce(pending.promise)
  const stop = f.resource.subscribe(vi.fn())
  stop()
  pending.resolve(delayedStop)
  await vi.waitFor(() => expect(delayedStop).toHaveBeenCalledTimes(1))
  expect(f.refresh).not.toHaveBeenCalled()
  expect(f.resource.getSnapshot()).toEqual({
    ready: false,
    activity: {},
    error: null,
  })
})

test('does not carry activity from a previous owner into another runtime with the same address', async () => {
  const old = fixture(),
    current = fixture()
  const stopOld = old.resource.subscribe(vi.fn())
  await vi.waitFor(() => expect(old.resource.getSnapshot().ready).toBe(true))
  old.connections[0].handlers.onAssistantStart?.('old turn')
  stopOld()
  const stopCurrent = current.resource.subscribe(vi.fn())
  await vi.waitFor(() => expect(current.resource.getSnapshot().ready).toBe(true))
  old.connections[0].handlers.onAssistantSettled?.('old turn', 'succeeded')
  expect(current.resource.getSnapshot().activity).toEqual({})
  current.connections[0].handlers.onAssistantStart?.('current turn')
  expect(current.resource.getSnapshot().activity[replyActivityKey(first)]).toBe(true)
  stopCurrent()
})

test('has no stream prerequisite for a reply without a bound session', async () => {
  const f = fixture([])
  const stop = f.resource.subscribe(vi.fn())
  await vi.waitFor(() => expect(f.resource.getSnapshot().ready).toBe(true))
  expect(f.subscribe).not.toHaveBeenCalled()
  expect(f.refresh).toHaveBeenCalledTimes(1)
  stop()
})
