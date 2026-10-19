import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { RuntimeTaskAddress } from '@/types/api'
import type { RuntimePaneQueuedMessage } from '@/types/workbench'
import {
  applyRuntimeConversationAction,
  cacheRuntimeConversationQueuedMessages,
  cacheRuntimeConversationQueuePaused,
  clearRuntimeConversationCacheForTests,
  getRuntimeConversationMessages,
  getRuntimeConversationQueuedMessages,
  getRuntimeConversationQueuePaused,
} from './runtimeConversationCache'
import {
  getRuntimeConversationQueueController,
  resetRuntimeConversationQueueControllersForTests,
} from './runtimeConversationQueueController'
import type { RuntimeQueuedMessageSenderDependencies } from './runtimeQueuedMessageSender'
import { RuntimeTaskLifecycleStore } from './runtimeTaskLifecycle/RuntimeTaskLifecycleStore'

type SendRuntimePaneMessage = RuntimeQueuedMessageSenderDependencies['sendRuntimePaneMessage']

const taskA: RuntimeTaskAddress = { deviceId: 'queue-test-device', taskId: 'task-a' }
const taskB: RuntimeTaskAddress = { deviceId: 'queue-test-device', taskId: 'task-b' }
const detaches: Array<() => void> = []

function message(id: string): RuntimePaneQueuedMessage {
  return { id, content: `Message ${id}`, status: 'queued', createdAt: '2026-10-15T00:00:00Z' }
}

function idleStore(...addresses: RuntimeTaskAddress[]): RuntimeTaskLifecycleStore {
  const store = new RuntimeTaskLifecycleStore('queue-controller-test')
  for (const address of addresses) {
    store.syncRuntimeTask(address, {
      taskId: address.taskId,
      workspacePath: '/workspace/queue-tests',
      title: address.taskId,
      runtime: 'codex',
      running: false,
      continuable: true,
    })
  }
  return store
}

function acceptingTransport(store: RuntimeTaskLifecycleStore) {
  return vi.fn<SendRuntimePaneMessage>(async request => {
    store.sendRequested(request.address)
    store.sendAccepted(request.address)
    return true
  })
}

function attach(
  address: RuntimeTaskAddress,
  lifecycleStore: RuntimeTaskLifecycleStore,
  sendRuntimePaneMessage: SendRuntimePaneMessage
) {
  const controller = getRuntimeConversationQueueController(address)
  const detach = controller.attach({ lifecycleStore, sendRuntimePaneMessage })
  detaches.push(detach)
  return { controller, detach }
}

function flushQueue(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0))
}

function startTurn(
  store: RuntimeTaskLifecycleStore,
  address: RuntimeTaskAddress,
  queuedMessage: RuntimePaneQueuedMessage
): string {
  const turnId = `turn-${queuedMessage.id}`
  store.turnStarted(address, turnId)
  applyRuntimeConversationAction(address, {
    type: 'assistant_started',
    taskId: address.taskId,
    subtaskId: turnId,
    clientUserMessageId: queuedMessage.id,
  })
  return turnId
}

function settleTurn(
  store: RuntimeTaskLifecycleStore,
  address: RuntimeTaskAddress,
  turnId: string
): void {
  applyRuntimeConversationAction(address, { type: 'assistant_done', subtaskId: turnId })
  store.turnSettled(address, turnId, 'succeeded')
}

describe('RuntimeConversationQueueController', () => {
  beforeEach(() => {
    vi.spyOn(console, 'info').mockImplementation(() => {})
  })

  afterEach(async () => {
    for (const address of [taskA, taskB]) cacheRuntimeConversationQueuedMessages(address, [])
    detaches.splice(0).forEach(detach => detach())
    await flushQueue()
    resetRuntimeConversationQueueControllersForTests()
    clearRuntimeConversationCacheForTests()
    vi.restoreAllMocks()
  })

  test('preserves one controller before attachment and through an empty Activity detach and restore', async () => {
    const firstPane = getRuntimeConversationQueueController(taskA)
    const secondPane = getRuntimeConversationQueueController({ ...taskA })
    expect(secondPane).toBe(firstPane)

    const store = idleStore(taskA)
    const send = acceptingTransport(store)
    const detachHiddenPane = firstPane.attach({
      lifecycleStore: store,
      sendRuntimePaneMessage: send,
    })
    detaches.push(detachHiddenPane)
    await flushQueue()
    detachHiddenPane()
    await flushQueue()

    const newPane = getRuntimeConversationQueueController({ ...taskA })
    expect(newPane).toBe(firstPane)
    detaches.push(newPane.attach({ lifecycleStore: store, sendRuntimePaneMessage: send }))
    detaches.push(firstPane.attach({ lifecycleStore: store, sendRuntimePaneMessage: send }))
    const item = message('shared-before-attach')
    cacheRuntimeConversationQueuedMessages(taskA, [item])

    await Promise.all([firstPane.send(item), newPane.send(item)])
    await flushQueue()

    expect(send).toHaveBeenCalledTimes(1)
    expect(getRuntimeConversationQueuedMessages(taskA)).toEqual([
      expect.objectContaining({ id: item.id, status: 'sending', awaitingTurnStart: true }),
    ])
  })

  test('drains a detached task in FIFO order after each real turn while another task stays active', async () => {
    const store = idleStore(taskA, taskB)
    const send = acceptingTransport(store)
    const queue = [message('a-1'), message('a-2'), message('a-3')]
    store.turnStarted(taskA, 'initial-a')
    store.turnStarted(taskB, 'initial-b')
    cacheRuntimeConversationQueuedMessages(taskA, queue)
    cacheRuntimeConversationQueuedMessages(taskB, [message('b-1')])
    const { detach } = attach(taskA, store, send)
    attach(taskB, store, send)
    detach()
    await flushQueue()
    expect(send).not.toHaveBeenCalled()

    store.turnSettled(taskA, 'initial-a', 'succeeded')
    store.executorSettled(taskA)
    await flushQueue()

    for (const [index, item] of queue.entries()) {
      expect(send).toHaveBeenCalledTimes(index + 1)
      expect(send).toHaveBeenNthCalledWith(
        index + 1,
        expect.objectContaining({ address: taskA, clientUserMessageId: item.id }),
        expect.any(Object)
      )
      expect(getRuntimeConversationQueuedMessages(taskA)[0]).toMatchObject({
        id: item.id,
        status: 'sending',
        awaitingTurnStart: true,
      })
      const turnId = startTurn(store, taskA, item)
      await flushQueue()
      expect(send).toHaveBeenCalledTimes(index + 1)
      settleTurn(store, taskA, turnId)
      await flushQueue()
      expect(send).toHaveBeenCalledTimes(index + 1)
      store.executorSettled(taskA)
      await flushQueue()
    }

    expect(getRuntimeConversationQueuedMessages(taskA)).toEqual([])
    expect(getRuntimeConversationQueuedMessages(taskB).map(item => item.id)).toEqual(['b-1'])
    expect(
      getRuntimeConversationMessages(taskA)
        .filter(item => item.role === 'user')
        .map(item => item.id)
    ).toEqual(queue.map(item => item.id))
  })

  test('shares the send claim across pane attachments and manual sends while acceptance is pending', async () => {
    const store = idleStore(taskA)
    const queue = [message('pending-1'), message('pending-2')]
    let resolveAcceptance!: (accepted: boolean) => void
    const acceptance = new Promise<boolean>(resolve => {
      resolveAcceptance = resolve
    })
    const send = vi.fn<SendRuntimePaneMessage>(async request => {
      store.sendRequested(request.address)
      const accepted = await acceptance
      if (accepted) store.sendAccepted(request.address)
      return accepted
    })
    cacheRuntimeConversationQueuedMessages(taskA, queue)
    const { controller } = attach(taskA, store, send)
    const secondPane = attach(taskA, store, send)
    expect(secondPane.controller).toBe(controller)
    const sending = controller.send(queue[0])
    await controller.send(queue[0])
    await controller.send(queue[1])
    await flushQueue()
    expect(send).toHaveBeenCalledTimes(1)

    const turnId = startTurn(store, taskA, queue[0])
    settleTurn(store, taskA, turnId)
    store.executorSettled(taskA)
    await flushQueue()
    expect(send).toHaveBeenCalledTimes(1)

    resolveAcceptance(true)
    await sending
    await flushQueue()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][0].clientUserMessageId).toBe(queue[1].id)
  })

  test.each([false, true])(
    'preserves a paused queue after detach and honors manual-turn resume cancellation=%s',
    async cancelResume => {
      const store = idleStore(taskA)
      const send = acceptingTransport(store)
      cacheRuntimeConversationQueuedMessages(taskA, [message('paused')])
      cacheRuntimeConversationQueuePaused(taskA, true)
      const { controller, detach } = attach(taskA, store, send)
      detach()
      await flushQueue()
      expect(send).not.toHaveBeenCalled()

      controller.resumeAfterTurn(store.getTask(taskA))
      store.sendRequested(taskA)
      store.sendAccepted(taskA)
      await flushQueue()
      expect(getRuntimeConversationQueuePaused(taskA)).toBe(true)
      store.turnStarted(taskA, 'manual-turn')
      await flushQueue()
      expect(send).not.toHaveBeenCalled()
      expect(getRuntimeConversationQueuePaused(taskA)).toBe(true)

      if (cancelResume) {
        controller.cancelResumeAfterTurn()
        store.stopRequested(taskA)
      }
      store.turnSettled(taskA, 'manual-turn', cancelResume ? 'cancelled' : 'succeeded')
      await flushQueue()
      expect(send).not.toHaveBeenCalled()
      expect(getRuntimeConversationQueuePaused(taskA)).toBe(cancelResume)
      store.executorSettled(taskA)
      await flushQueue()
      expect(send).toHaveBeenCalledTimes(cancelResume ? 0 : 1)
    }
  )

  test('retries busy messages only after meaningful lifecycle changes and leaves failed messages alone', async () => {
    const store = idleStore(taskA)
    const send = vi
      .fn<SendRuntimePaneMessage>()
      .mockImplementationOnce(async (_request, options) => {
        options?.onError?.('Runtime task is already running')
        return false
      })
      .mockImplementation(async (_request, options) => {
        options?.onError?.('Transport unavailable')
        return false
      })
    const item = message('busy')
    cacheRuntimeConversationQueuedMessages(taskA, [item])
    const { controller, detach } = attach(taskA, store, send)
    detach()
    await flushQueue()
    expect(send).toHaveBeenCalledTimes(1)
    expect(controller.busyBlocks.has(item.id)).toBe(true)
    expect(getRuntimeConversationQueuedMessages(taskA)[0].status).toBe('queued')

    store.syncRuntimeTask(taskA, {
      taskId: taskA.taskId,
      workspacePath: '/workspace/queue-tests',
      title: 'Updated title only',
      runtime: 'codex',
      running: false,
      continuable: true,
    })
    cacheRuntimeConversationQueuedMessages(taskA, [...getRuntimeConversationQueuedMessages(taskA)])
    await flushQueue()
    expect(send).toHaveBeenCalledTimes(1)

    store.turnStarted(taskA, 'external-turn')
    await flushQueue()
    expect(send).toHaveBeenCalledTimes(1)
    store.turnSettled(taskA, 'external-turn', 'succeeded')
    store.executorSettled(taskA)
    await flushQueue()
    expect(send).toHaveBeenCalledTimes(2)
    expect(getRuntimeConversationQueuedMessages(taskA)[0].status).toBe('failed')
    expect(controller.busyBlocks.has(item.id)).toBe(false)

    store.turnStarted(taskA, 'later-turn')
    store.turnSettled(taskA, 'later-turn', 'succeeded')
    store.executorSettled(taskA)
    await flushQueue()
    expect(send).toHaveBeenCalledTimes(2)
  })

  test('does not resubmit executor-queued messages and reconciles their real turn start after detach', async () => {
    const store = idleStore(taskA)
    const item = message('executor-queued')
    const send = vi.fn<SendRuntimePaneMessage>(async (request, options) => {
      store.sendRequested(request.address)
      store.sendQueued(request.address, 2)
      options?.onQueued?.({
        accepted: true,
        taskId: taskA.taskId,
        status: 'queued',
        queuePosition: 2,
      })
      return true
    })
    cacheRuntimeConversationQueuedMessages(taskA, [item])
    const { detach } = attach(taskA, store, send)
    detach()
    await flushQueue()
    expect(send).toHaveBeenCalledTimes(1)
    expect(getRuntimeConversationQueuedMessages(taskA)[0]).toMatchObject({
      id: item.id,
      runtimeQueued: true,
      runtimeQueuePosition: 2,
    })
    expect(getRuntimeConversationMessages(taskA)).toEqual([])

    store.executorSettled(taskA)
    await flushQueue()
    expect(send).toHaveBeenCalledTimes(1)
    startTurn(store, taskA, item)
    await flushQueue()
    expect(send).toHaveBeenCalledTimes(1)
    expect(getRuntimeConversationQueuedMessages(taskA)).toEqual([])
    expect(getRuntimeConversationMessages(taskA).filter(entry => entry.role === 'user')).toEqual([
      expect.objectContaining({ id: item.id, turnId: `turn-${item.id}` }),
    ])
  })

  test('starts a queued initial goal between turns even when the task execution remains running', async () => {
    const store = idleStore(taskA)
    const send = acceptingTransport(store)
    const initialGoal = { objective: 'Continue until complete', tokenBudget: 2000 }
    store.executorStarted(taskA)
    const item = { ...message('initial-goal'), initialGoal }
    cacheRuntimeConversationQueuedMessages(taskA, [item])
    const { detach } = attach(taskA, store, send)
    detach()
    await flushQueue()

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ address: taskA, clientUserMessageId: item.id, initialGoal }),
      expect.any(Object)
    )
  })
})
