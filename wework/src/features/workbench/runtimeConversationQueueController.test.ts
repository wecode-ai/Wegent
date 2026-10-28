import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { RuntimeTaskAddress } from '@/types/api'
import type { RuntimePaneQueuedMessage } from '@/types/workbench'
import {
  applyRuntimeConversationAction,
  cacheRuntimeConversationQueuedMessages,
  cacheRuntimeConversationQueuePaused,
  clearRuntimeConversationCacheForTests,
  evictRuntimeConversation,
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

function deferredAcceptance() {
  let resolve!: (accepted: boolean) => void
  let reject!: (error: Error) => void
  const promise = new Promise<boolean>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

function manualResumeFixture() {
  const store = idleStore(taskA)
  const send = acceptingTransport(store)
  const item = message('waiting-for-manual-turn')
  cacheRuntimeConversationQueuedMessages(taskA, [item])
  cacheRuntimeConversationQueuePaused(taskA, true)
  const attachment = attach(taskA, store, send)
  attachment.controller.resumeAfterTurn(store.getTask(taskA))
  store.sendRequested(taskA)
  store.sendAccepted(taskA)
  store.turnStarted(taskA, 'manual-turn')
  return { ...attachment, store, send, item }
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

  test('sends the next message despite a late running snapshot from a completed predecessor', async () => {
    const store = idleStore(taskA)
    const staleRunningTask = {
      ...store.getTask(taskA)!.task!,
      status: 'running',
      running: true,
      turnStatus: 'inProgress',
      completedAt: null,
      runtimeHandle: { lastTurnId: 'first-turn' },
    }
    store.syncRuntimeTask(taskA, staleRunningTask)
    store.turnStarted(taskA, 'first-turn')
    store.turnSettled(taskA, 'first-turn', 'succeeded')
    store.executorSettled(taskA)
    store.sendRequested(taskA)
    store.sendAccepted(taskA)
    store.turnStarted(taskA, 'second-turn')
    const item = message('third-message')
    const send = acceptingTransport(store)
    cacheRuntimeConversationQueuedMessages(taskA, [item])
    attach(taskA, store, send)
    await flushQueue()
    expect(send).not.toHaveBeenCalled()

    store.turnSettled(taskA, 'second-turn', 'succeeded')
    store.syncTranscript(taskA, {
      messages: [],
      running: false,
      turns: [
        { id: 'first-turn', status: 'done', items: [] },
        { id: 'second-turn', status: 'done', items: [] },
      ],
    })
    // The list response arrives before the scheduled queue pump reads lifecycle state.
    store.syncRuntimeTask(taskA, staleRunningTask)
    await flushQueue()

    expect(send).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ address: taskA, clientUserMessageId: item.id }),
      expect.any(Object)
    )
    expect(getRuntimeConversationQueuedMessages(taskA)[0]).toMatchObject({
      id: item.id,
      status: 'sending',
      awaitingTurnStart: true,
    })
  })

  test('shares the send claim across pane attachments and manual sends while acceptance is pending', async () => {
    const store = idleStore(taskA)
    const queue = [message('pending-1'), message('pending-2')]
    const acceptance = deferredAcceptance()
    const send = vi.fn<SendRuntimePaneMessage>(async request => {
      store.sendRequested(request.address)
      const accepted = await acceptance.promise
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

    acceptance.resolve(true)
    await sending
    await flushQueue()
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[1][0].clientUserMessageId).toBe(queue[1].id)
  })

  test.each(['accepted', 'queued', 'rejected', 'thrown'] as const)(
    'does not recreate an archived detached task after a late %s response',
    async response => {
      const store = idleStore(taskA)
      const acceptance = deferredAcceptance()
      const queue = [message('archived-in-flight'), message('archived-next')]
      const send = vi.fn<SendRuntimePaneMessage>(async (request, options) => {
        store.sendRequested(request.address)
        const accepted = await acceptance.promise
        if (response === 'queued') {
          options?.onQueued?.({
            accepted: true,
            taskId: request.address.taskId,
            status: 'queued',
            queuePosition: 1,
          })
        }
        if (!accepted) options?.onError?.('Transport unavailable')
        return accepted
      })
      cacheRuntimeConversationQueuedMessages(taskA, queue)
      const { controller, detach } = attach(taskA, store, send)
      const sending = controller.send(queue[0])
      detach()
      await flushQueue()
      expect(send).toHaveBeenCalledTimes(1)

      evictRuntimeConversation(taskA)
      store.remove(taskA)
      await flushQueue()
      expect(getRuntimeConversationMessages(taskA)).toEqual([])
      expect(getRuntimeConversationQueuedMessages(taskA)).toEqual([])
      expect(store.getTask(taskA)).toBeNull()

      if (response === 'thrown') acceptance.reject(new Error('Transport unavailable'))
      else acceptance.resolve(response !== 'rejected')
      await sending
      await flushQueue()

      expect(getRuntimeConversationMessages(taskA)).toEqual([])
      expect(getRuntimeConversationQueuedMessages(taskA)).toEqual([])
      expect(getRuntimeConversationQueuePaused(taskA)).toBe(false)
      expect(store.getTask(taskA)).toBeNull()
      expect(send).toHaveBeenCalledTimes(1)
    }
  )

  test.each(['accepted', 'queued'] as const)(
    'keeps a new generation of the same task independent of a late %s response',
    async response => {
      const store = idleStore(taskA)
      const acceptance = deferredAcceptance()
      const archivedQueue = [message('old-generation-in-flight'), message('old-generation-next')]
      const archivedSend = vi.fn<SendRuntimePaneMessage>(async (request, options) => {
        store.sendRequested(request.address)
        const accepted = await acceptance.promise
        if (response === 'queued') {
          options?.onQueued?.({
            accepted: true,
            taskId: request.address.taskId,
            status: 'queued',
            queuePosition: 1,
          })
        }
        return accepted
      })
      cacheRuntimeConversationQueuedMessages(taskA, archivedQueue)
      const archived = attach(taskA, store, archivedSend)
      const archivedSending = archived.controller.send(archivedQueue[0])
      archived.detach()
      await flushQueue()
      expect(archivedSend).toHaveBeenCalledTimes(1)

      evictRuntimeConversation(taskA)
      store.remove(taskA)
      await flushQueue()
      store.syncRuntimeTask(taskA, {
        taskId: taskA.taskId,
        workspacePath: '/workspace/queue-tests',
        title: 'New task generation',
        runtime: 'codex',
        running: false,
        continuable: true,
      })
      const currentMessage = message('new-generation')
      const currentSend = acceptingTransport(store)
      cacheRuntimeConversationQueuedMessages(taskA, [currentMessage])
      attach(taskA, store, currentSend)
      await flushQueue()

      expect(currentSend).toHaveBeenCalledTimes(1)
      expect(currentSend).toHaveBeenCalledWith(
        expect.objectContaining({ clientUserMessageId: currentMessage.id }),
        expect.any(Object)
      )
      const currentMessages = getRuntimeConversationMessages(taskA)
      const currentQueue = getRuntimeConversationQueuedMessages(taskA)
      const currentLifecycle = store.getTask(taskA)
      const currentRevision = store.getTaskRevision(taskA)
      expect(currentMessages.filter(item => item.role === 'user').map(item => item.id)).toEqual([
        currentMessage.id,
      ])
      expect(currentQueue).toEqual([
        expect.objectContaining({
          id: currentMessage.id,
          status: 'sending',
          awaitingTurnStart: true,
        }),
      ])

      acceptance.resolve(true)
      await archivedSending
      await flushQueue()

      expect(getRuntimeConversationMessages(taskA)).toEqual(currentMessages)
      expect(getRuntimeConversationQueuedMessages(taskA)).toEqual(currentQueue)
      expect(store.getTask(taskA)).toEqual(currentLifecycle)
      expect(store.getTaskRevision(taskA)).toBe(currentRevision)
      expect(currentSend).toHaveBeenCalledTimes(1)
      expect(archivedSend).toHaveBeenCalledTimes(1)
    }
  )

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

  test.each(['before', 'after'] as const)(
    'restores a pending manual-turn resume when cancellation fails %s the turn settles',
    async rollbackTiming => {
      const { controller, detach, store, send, item } = manualResumeFixture()
      await flushQueue()
      const rollback = controller.pauseForCancellation()
      detach()
      await flushQueue()
      expect(send).not.toHaveBeenCalled()

      if (rollbackTiming === 'before') rollback()
      settleTurn(store, taskA, 'manual-turn')
      store.executorSettled(taskA)
      await flushQueue()
      if (rollbackTiming === 'after') {
        expect(getRuntimeConversationQueuePaused(taskA)).toBe(true)
        expect(send).not.toHaveBeenCalled()
        rollback()
        await flushQueue()
      }

      expect(getRuntimeConversationQueuePaused(taskA)).toBe(false)
      expect(send).toHaveBeenCalledTimes(1)
      expect(send).toHaveBeenCalledWith(
        expect.objectContaining({ clientUserMessageId: item.id }),
        expect.any(Object)
      )
    }
  )

  test('keeps a successful cancellation paused after the manual turn and later turns settle', async () => {
    const { controller, detach, store, send, item } = manualResumeFixture()
    await flushQueue()
    controller.pauseForCancellation()
    store.stopRequested(taskA)
    detach()
    store.turnSettled(taskA, 'manual-turn', 'cancelled')
    store.executorSettled(taskA)
    await flushQueue()
    expect(getRuntimeConversationQueuePaused(taskA)).toBe(true)
    expect(getRuntimeConversationQueuedMessages(taskA)).toEqual([item])
    expect(send).not.toHaveBeenCalled()

    store.turnStarted(taskA, 'later-manual-turn')
    settleTurn(store, taskA, 'later-manual-turn')
    store.executorSettled(taskA)
    await flushQueue()
    expect(getRuntimeConversationQueuePaused(taskA)).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })

  test('ignores an older cancellation rollback after a new manual-turn resume', async () => {
    const { controller, detach, store, send } = manualResumeFixture()
    await flushQueue()
    const rollback = controller.pauseForCancellation()
    detach()
    settleTurn(store, taskA, 'manual-turn')
    store.executorSettled(taskA)
    await flushQueue()

    controller.resumeAfterTurn(store.getTask(taskA))
    rollback()
    await flushQueue()
    expect(getRuntimeConversationQueuePaused(taskA)).toBe(true)
    expect(send).not.toHaveBeenCalled()

    store.sendRequested(taskA)
    store.sendAccepted(taskA)
    store.turnStarted(taskA, 'new-manual-turn')
    await flushQueue()
    expect(send).not.toHaveBeenCalled()
    settleTurn(store, taskA, 'new-manual-turn')
    store.executorSettled(taskA)
    await flushQueue()
    expect(getRuntimeConversationQueuePaused(taskA)).toBe(false)
    expect(send).toHaveBeenCalledTimes(1)
  })

  test('ignores an older rollback after a second cancellation pause', async () => {
    const { controller, detach, store, send } = manualResumeFixture()
    await flushQueue()
    const rollback = controller.pauseForCancellation()
    controller.pauseForCancellation()
    rollback()
    detach()
    settleTurn(store, taskA, 'manual-turn')
    store.executorSettled(taskA)
    await flushQueue()

    expect(getRuntimeConversationQueuePaused(taskA)).toBe(true)
    expect(send).not.toHaveBeenCalled()
  })

  test('does not restore a cancelled pending resume after the task is archived', async () => {
    const { controller, detach, store, send } = manualResumeFixture()
    await flushQueue()
    const rollback = controller.pauseForCancellation()
    detach()
    evictRuntimeConversation(taskA)
    store.remove(taskA)
    await flushQueue()
    rollback()
    await flushQueue()

    expect(getRuntimeConversationMessages(taskA)).toEqual([])
    expect(getRuntimeConversationQueuedMessages(taskA)).toEqual([])
    expect(getRuntimeConversationQueuePaused(taskA)).toBe(false)
    expect(store.getTask(taskA)).toBeNull()
    expect(send).not.toHaveBeenCalled()
  })

  test.each([
    ['empty', false],
    ['empty', true],
    ['executor-queued', false],
    ['executor-queued', true],
  ] as const)(
    'does not add a pause to an %s queue (previously paused=%s)',
    async (queueKind, previouslyPaused) => {
      const store = idleStore(taskA)
      const send = acceptingTransport(store)
      const queue =
        queueKind === 'empty' ? [] : [{ ...message('executor-only'), runtimeQueued: true }]
      cacheRuntimeConversationQueuedMessages(taskA, queue)
      cacheRuntimeConversationQueuePaused(taskA, previouslyPaused)
      const { controller, detach } = attach(taskA, store, send)
      const rollback = controller.pauseForCancellation()
      detach()
      await flushQueue()

      expect(getRuntimeConversationQueuePaused(taskA)).toBe(previouslyPaused)
      expect(send).not.toHaveBeenCalled()
      rollback()
      await flushQueue()
      expect(getRuntimeConversationQueuePaused(taskA)).toBe(previouslyPaused)
      expect(getRuntimeConversationQueuedMessages(taskA)).toEqual(queue)
      expect(send).not.toHaveBeenCalled()
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
