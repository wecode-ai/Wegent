import type { RuntimeTranscriptResponse, RuntimeWorkListResponse } from '@/types/api'
import { act, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ChatStreamHandlers } from '@/stream/chatStream'
import type { WorkbenchServices } from '../workbenchServices'
import {
  applyRuntimeConversationAction,
  cacheRuntimeConversationQueuedMessages,
  clearRuntimeConversationCacheForTests,
  getRuntimeConversationMetadata,
  getRuntimeConversationMessages,
  getRuntimeConversationQueuedMessages,
  setRuntimeConversationGoal,
} from '../runtimeConversationCache'
import { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'
import { RuntimeTaskLifecycleStreamCoordinator } from './RuntimeTaskLifecycleStreamCoordinator'

import {
  runtimeTaskAddress,
  runtimeWork,
  runtimeTranscript,
} from './RuntimeTaskLifecycleStreamCoordinator.fixtures'

describe('RuntimeTaskLifecycleStreamCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers()
    clearRuntimeConversationCacheForTests()
    delete window.weworkElectronLifecycle
  })

  test('does not poll running task transcripts or work lists', async () => {
    vi.useFakeTimers()
    const store = new RuntimeTaskLifecycleStore('test')
    store.syncRuntimeWork(runtimeWork(true))
    const listRuntimeWork = vi.fn()
    const getRuntimeTranscript = vi.fn()
    const services = {
      chatStream: {
        subscribe: vi.fn(() => vi.fn()),
      },
      executorClient: {
        runtime: {
          listRuntimeWork,
          getRuntimeTranscript,
        },
      },
    } as unknown as WorkbenchServices

    render(<RuntimeTaskLifecycleStreamCoordinator services={services} store={store} />)
    await act(() => vi.advanceTimersByTimeAsync(10_000))

    expect(listRuntimeWork).not.toHaveBeenCalled()
    expect(getRuntimeTranscript).not.toHaveBeenCalled()
  })

  test.each([undefined, 'async'] as const)(
    'marks a running task as waiting when a request_user_input block is created (%s)',
    async delivery => {
      const store = new RuntimeTaskLifecycleStore('request-user-input-stream-test')
      const address = runtimeTaskAddress()
      store.syncRuntimeWork(runtimeWork(true))
      let streamHandlers: ChatStreamHandlers = {}
      const services = {
        chatStream: {
          subscribe: vi.fn((handlers: ChatStreamHandlers) => {
            streamHandlers = handlers
            return vi.fn()
          }),
        },
        executorClient: {
          runtime: {
            listRuntimeWork: vi.fn(),
            getRuntimeTranscript: vi.fn(),
          },
        },
      } as unknown as WorkbenchServices

      render(<RuntimeTaskLifecycleStreamCoordinator services={services} store={store} />)
      await act(async () => {
        streamHandlers.onBlockCreated?.({
          taskId: address.taskId,
          deviceId: address.deviceId,
          subtaskId: 'turn-1',
          block: {
            id: 'request-1',
            type: 'tool',
            tool_name: 'request_user_input',
            status: 'pending',
            render_payload: {
              kind: 'request_user_input',
              delivery,
              requestId: 'request-1',
              questions: [],
            },
          },
        })
      })

      const snapshot = store.getTask(address)
      expect(snapshot?.derived.isBusy).toBe(true)
      expect(snapshot?.derived.shouldShowSidebarRunning).toBe(false)
      expect(snapshot?.derived.shouldShowSidebarWaiting).toBe(true)
      expect(snapshot?.interactionStatus).toBe(
        delivery === 'async' ? 'awaitingUserReply' : 'waitingForUserInput'
      )
    }
  )

  test('reconnects and reconciles running tasks after system resume', async () => {
    const store = new RuntimeTaskLifecycleStore('test')
    const address = runtimeTaskAddress()
    store.syncRuntimeWork(runtimeWork(true))
    store.setCurrentTask(address)
    let resumeListener: (() => void) | null = null
    window.weworkElectronLifecycle = {
      onSystemResume(listener) {
        resumeListener = listener
        return () => {
          resumeListener = null
        }
      },
    }
    const recoverRuntimeConnections = vi.fn().mockResolvedValue(undefined)
    const listRuntimeWork = vi.fn().mockResolvedValue(runtimeWork(false))
    const getRuntimeTranscript = vi.fn().mockResolvedValue(runtimeTranscript(false))
    const services = {
      chatStream: {
        subscribe: vi.fn(() => vi.fn()),
      },
      recoverRuntimeConnections,
      executorClient: {
        runtime: {
          listRuntimeWork,
          getRuntimeTranscript,
        },
      },
    } as unknown as WorkbenchServices

    render(<RuntimeTaskLifecycleStreamCoordinator services={services} store={store} />)
    await act(async () => {
      resumeListener?.()
    })

    expect(recoverRuntimeConnections).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(listRuntimeWork).toHaveBeenCalledTimes(1))
    await waitFor(() => {
      expect(getRuntimeTranscript).toHaveBeenCalledWith(
        {
          ...address,
          limit: 5,
        },
        { signal: expect.any(AbortSignal) }
      )
    })
    expect(store.getTask(address)?.derived.isRunning).toBe(false)
  })

  test('serializes stale-projection recovery with one trailing reconciliation', async () => {
    const store = new RuntimeTaskLifecycleStore('test')
    const address = runtimeTaskAddress()
    store.syncRuntimeWork(runtimeWork(true))
    let streamHandlers: ChatStreamHandlers = {}
    const pendingRuntimeWork: Array<(value: RuntimeWorkListResponse) => void> = []
    const listRuntimeWork = vi.fn(() => {
      return new Promise<RuntimeWorkListResponse>(resolve => {
        pendingRuntimeWork.push(resolve)
      })
    })
    const services = {
      chatStream: {
        subscribe: vi.fn((handlers: ChatStreamHandlers) => {
          streamHandlers = handlers
          return vi.fn()
        }),
      },
      executorClient: {
        runtime: {
          listRuntimeWork,
          getRuntimeTranscript: vi.fn(),
        },
      },
    } as unknown as WorkbenchServices

    render(<RuntimeTaskLifecycleStreamCoordinator services={services} store={store} />)
    await act(async () => {
      streamHandlers.onRuntimeEventLagged?.({ skipped: 3 })
      streamHandlers.onRuntimeTransportReplaced?.({
        previousRuntimeInstanceId: 'runtime-1',
        runtimeInstanceId: 'runtime-2',
      })
      await Promise.resolve()
    })

    expect(listRuntimeWork).toHaveBeenCalledTimes(1)
    pendingRuntimeWork.shift()?.(runtimeWork(true))
    await waitFor(() => expect(listRuntimeWork).toHaveBeenCalledTimes(2))
    pendingRuntimeWork.shift()?.(runtimeWork(false))

    await waitFor(() => {
      expect(store.getTask(address)?.task).toMatchObject({
        status: 'done',
        running: false,
        completedAt: 1_786_692_066_192,
      })
    })
    expect(store.getTask(address)?.execution.phase).toBe('idle')
    expect(store.getTask(address)?.turn.phase).toBe('idle')
    expect(store.getTask(address)?.derived.shouldShowSidebarRunning).toBe(false)
  })

  test('refreshes the transcript and retains an unconfirmed send after runtime replacement', async () => {
    const store = new RuntimeTaskLifecycleStore('test')
    const address = runtimeTaskAddress()
    store.syncRuntimeWork(runtimeWork(true))
    store.setCurrentTask(address)
    cacheRuntimeConversationQueuedMessages(address, [
      {
        id: 'queued-follow-up',
        content: 'continue after restart',
        status: 'sending',
        deliveryMode: 'message',
        awaitingTurnStart: false,
        createdAt: '2026-08-21T00:00:00.000Z',
      },
    ])
    let streamHandlers: ChatStreamHandlers = {}
    const listRuntimeWork = vi.fn().mockResolvedValue(runtimeWork(false))
    const getRuntimeTranscript = vi.fn().mockResolvedValue({
      taskId: address.taskId,
      workspacePath: address.workspacePath,
      runtime: address.runtime,
      running: false,
      messages: [],
      acceptedClientUserMessageIds: [],
      turns: [
        {
          id: 'interrupted-turn',
          status: 'failed',
          completedAt: 1_787_296_150_000,
          items: [],
        },
      ],
    })
    const services = {
      chatStream: {
        subscribe: vi.fn((handlers: ChatStreamHandlers) => {
          streamHandlers = handlers
          return vi.fn()
        }),
      },
      executorClient: {
        runtime: {
          listRuntimeWork,
          getRuntimeTranscript,
        },
      },
    } as unknown as WorkbenchServices

    render(<RuntimeTaskLifecycleStreamCoordinator services={services} store={store} />)
    await act(async () => {
      streamHandlers.onRuntimeTransportReplaced?.({
        previousRuntimeInstanceId: 'runtime-1',
        runtimeInstanceId: 'runtime-2',
      })
    })

    await waitFor(() => {
      expect(getRuntimeTranscript).toHaveBeenCalledWith(
        {
          ...address,
          limit: 5,
          reconcileClientUserMessageIds: ['queued-follow-up'],
        },
        { signal: expect.any(AbortSignal) }
      )
    })
    await waitFor(() => {
      expect(getRuntimeConversationQueuedMessages(address)).toEqual([
        expect.objectContaining({
          id: 'queued-follow-up',
          status: 'sending',
          awaitingTurnStart: false,
        }),
      ])
    })
    expect(store.getTask(address)?.derived.isRunning).toBe(false)
  })

  test.each(['work-list', 'transcript'])(
    'finishes receipt recovery when services change during the %s read',
    async phase => {
      const store = new RuntimeTaskLifecycleStore('service-change-recovery')
      const address = runtimeTaskAddress()
      store.syncRuntimeWork(runtimeWork(true))
      store.setCurrentTask(address)
      cacheRuntimeConversationQueuedMessages(address, [
        {
          id: 'pending-recovery-send',
          content: 'continue',
          status: 'sending',
          deliveryMode: 'message',
          awaitingTurnStart: false,
          createdAt: '2026-08-21T00:00:00Z',
        },
      ])
      let streamHandlers: ChatStreamHandlers = {}
      let resolveList!: (value: RuntimeWorkListResponse) => void
      let resolveTranscript!: (value: RuntimeTranscriptResponse) => void
      const transcript = { ...runtimeTranscript(false), acceptedClientUserMessageIds: [] }
      const listRuntimeWork = vi
        .fn()
        .mockImplementationOnce(() =>
          phase === 'work-list'
            ? new Promise<RuntimeWorkListResponse>(resolve => {
                resolveList = resolve
              })
            : Promise.resolve(runtimeWork(false))
        )
        .mockResolvedValue(runtimeWork(false))
      const getRuntimeTranscript = vi
        .fn()
        .mockImplementationOnce(() =>
          phase === 'transcript'
            ? new Promise<RuntimeTranscriptResponse>(resolve => {
                resolveTranscript = resolve
              })
            : Promise.resolve(transcript)
        )
        .mockResolvedValue(transcript)
      const services = {
        chatStream: {
          subscribe: vi.fn((handlers: ChatStreamHandlers) => {
            streamHandlers = handlers
            return vi.fn()
          }),
        },
        executorClient: { runtime: { listRuntimeWork, getRuntimeTranscript } },
      } as unknown as WorkbenchServices
      const view = render(
        <RuntimeTaskLifecycleStreamCoordinator services={services} store={store} />
      )
      act(() => streamHandlers.onRuntimeEventLagged?.({ skipped: 0, reason: 'event_history_lost' }))
      if (phase === 'transcript')
        await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledOnce())
      const replacement = { ...services, executorClient: { ...services.executorClient! } }
      view.rerender(<RuntimeTaskLifecycleStreamCoordinator services={replacement} store={store} />)
      await act(async () =>
        phase === 'work-list' ? resolveList(runtimeWork(false)) : resolveTranscript(transcript)
      )
      await waitFor(() =>
        expect(getRuntimeTranscript).toHaveBeenCalledTimes(phase === 'work-list' ? 1 : 2)
      )
      await waitFor(() =>
        expect(getRuntimeTranscript).toHaveBeenCalledWith(
          { ...address, limit: 5, reconcileClientUserMessageIds: ['pending-recovery-send'] },
          { signal: expect.any(AbortSignal) }
        )
      )
      expect(getRuntimeConversationQueuedMessages(address)[0]?.status).toBe('sending')
    }
  )

  test('recovers lagged transcripts while preserving an optimistic user message', async () => {
    const store = new RuntimeTaskLifecycleStore('test')
    const address = runtimeTaskAddress()
    store.syncRuntimeWork(runtimeWork(true))
    store.setCurrentTask(address)
    applyRuntimeConversationAction(address, {
      type: 'user_added',
      message: {
        id: 'optimistic-user',
        role: 'user',
        content: '继续',
        status: 'sending',
        createdAt: '2026-08-21T14:39:00.000Z',
      },
    })
    let streamHandlers: ChatStreamHandlers = {}
    const getRuntimeTranscript = vi.fn().mockResolvedValue(runtimeTranscript(true))
    const services = {
      chatStream: {
        subscribe: vi.fn((handlers: ChatStreamHandlers) => {
          streamHandlers = handlers
          return vi.fn()
        }),
      },
      executorClient: {
        runtime: {
          listRuntimeWork: vi.fn().mockResolvedValue(runtimeWork(true)),
          getRuntimeTranscript,
        },
      },
    } as unknown as WorkbenchServices

    render(<RuntimeTaskLifecycleStreamCoordinator services={services} store={store} />)
    await act(async () => {
      streamHandlers.onRuntimeEventLagged?.({ skipped: 1_053 })
    })

    await waitFor(() => {
      expect(getRuntimeTranscript).toHaveBeenCalledWith(
        {
          ...address,
          limit: 5,
        },
        { signal: expect.any(AbortSignal) }
      )
    })
    await waitFor(() => {
      expect(getRuntimeConversationMessages(address).map(message => message.content)).toEqual([
        '之前的请求',
        '已恢复的 AI 输出',
        '继续',
      ])
    })
  })

  test('settles stale running state from a refreshed terminal transcript after event lag', async () => {
    const store = new RuntimeTaskLifecycleStore('test')
    const address = runtimeTaskAddress()
    store.syncRuntimeWork(runtimeWork(true))
    store.turnStarted(address, 'turn-1')
    let streamHandlers: ChatStreamHandlers = {}
    const services = {
      chatStream: {
        subscribe: vi.fn((handlers: ChatStreamHandlers) => {
          streamHandlers = handlers
          return vi.fn()
        }),
      },
      executorClient: {
        runtime: {
          listRuntimeWork: vi.fn().mockResolvedValue(runtimeWork(true)),
          getRuntimeTranscript: vi.fn().mockResolvedValue(runtimeTranscript(false)),
        },
      },
    } as unknown as WorkbenchServices

    render(<RuntimeTaskLifecycleStreamCoordinator services={services} store={store} />)
    await act(async () => {
      streamHandlers.onRuntimeEventLagged?.({ skipped: 1 })
    })

    await waitFor(() => {
      expect(store.getTask(address)?.execution.phase).toBe('idle')
    })
    expect(store.getTask(address)?.turn.phase).toBe('idle')
    expect(store.getTask(address)?.derived.shouldShowSidebarRunning).toBe(false)
  })

  test('clears a stale Goal from the authoritative snapshot after event lag', async () => {
    const store = new RuntimeTaskLifecycleStore('test')
    const address = runtimeTaskAddress()
    const activeWork = runtimeWork(false)
    const activeTask = activeWork.chats[0]?.tasks[0]
    if (activeTask) activeTask.goalStatus = 'active'
    store.syncRuntimeWork(activeWork)
    store.setCurrentTask(address)
    setRuntimeConversationGoal(address, {
      threadId: 'thread-1',
      objective: 'Finish the task',
      status: 'active',
      tokenBudget: null,
      tokensUsed: 100,
      timeUsedSeconds: 10,
      createdAt: 1,
      updatedAt: 2,
    })
    let streamHandlers: ChatStreamHandlers = {}
    const settledWork = runtimeWork(false)
    const settledTask = settledWork.chats[0]?.tasks[0]
    if (settledTask) settledTask.goalStatus = null
    const getRuntimeGoal = vi.fn().mockResolvedValue({
      accepted: true,
      taskId: address.taskId,
      goal: null,
    })
    const services = {
      chatStream: {
        subscribe: vi.fn((handlers: ChatStreamHandlers) => {
          streamHandlers = handlers
          return vi.fn()
        }),
      },
      executorClient: {
        runtime: {
          listRuntimeWork: vi.fn().mockResolvedValue(settledWork),
          getRuntimeTranscript: vi.fn().mockResolvedValue(runtimeTranscript(false)),
          getRuntimeGoal,
        },
      },
    } as unknown as WorkbenchServices

    render(<RuntimeTaskLifecycleStreamCoordinator services={services} store={store} />)
    await act(async () => {
      streamHandlers.onRuntimeEventLagged?.({ skipped: 1 })
    })

    await waitFor(() => expect(getRuntimeGoal).toHaveBeenCalledWith({ address }))
    await waitFor(() => expect(getRuntimeConversationMetadata(address).goal).toBeNull())
    expect(store.getTask(address)?.goalStatus).toBeNull()
  })

  test('recovers both the current task and every running task after event lag', async () => {
    const store = new RuntimeTaskLifecycleStore('test')
    const currentAddress = runtimeTaskAddress()
    const backgroundAddress = {
      ...currentAddress,
      taskId: 'background-task',
    }
    const work = runtimeWork(false)
    work.chats[0]?.tasks.push({
      taskId: backgroundAddress.taskId,
      workspacePath: backgroundAddress.workspacePath,
      title: 'Background task',
      runtime: backgroundAddress.runtime,
      running: true,
      status: 'active',
    })
    work.totalTasks = 2
    store.syncRuntimeWork(work)
    store.setCurrentTask(currentAddress)
    let streamHandlers: ChatStreamHandlers = {}
    const getRuntimeTranscript = vi.fn().mockResolvedValue(runtimeTranscript(true))
    const services = {
      chatStream: {
        subscribe: vi.fn((handlers: ChatStreamHandlers) => {
          streamHandlers = handlers
          return vi.fn()
        }),
      },
      executorClient: {
        runtime: {
          listRuntimeWork: vi.fn().mockResolvedValue(work),
          getRuntimeTranscript,
        },
      },
    } as unknown as WorkbenchServices

    render(<RuntimeTaskLifecycleStreamCoordinator services={services} store={store} />)
    await act(async () => {
      streamHandlers.onRuntimeEventLagged?.({ skipped: 2 })
    })

    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(2))
    expect(getRuntimeTranscript.mock.calls.map(([request]) => request.taskId).sort()).toEqual(
      [backgroundAddress.taskId, currentAddress.taskId].sort()
    )
  })
})
