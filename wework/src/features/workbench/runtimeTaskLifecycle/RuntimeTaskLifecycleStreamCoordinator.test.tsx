import { act, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { RuntimeTranscriptResponse, RuntimeWorkListResponse } from '@/types/api'
import type { ChatStreamHandlers } from '@/stream/chatStream'
import type { WorkbenchServices } from '../workbenchServices'
import {
  applyRuntimeConversationAction,
  cacheRuntimeConversationQueuedMessages,
  clearRuntimeConversationCacheForTests,
  getRuntimeConversationMessages,
  getRuntimeConversationQueuedMessages,
} from '../runtimeConversationCache'
import { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'
import { RuntimeTaskLifecycleStreamCoordinator } from './RuntimeTaskLifecycleStreamCoordinator'

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
      expect(getRuntimeTranscript).toHaveBeenCalledWith({
        ...address,
        limit: 50,
        refresh: true,
      })
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

  test('refreshes the transcript and requeues an interrupted send after runtime replacement', async () => {
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
      expect(getRuntimeTranscript).toHaveBeenCalledWith({
        ...address,
        limit: 50,
        refresh: true,
      })
    })
    await waitFor(() => {
      expect(getRuntimeConversationQueuedMessages(address)).toEqual([
        expect.objectContaining({
          id: 'queued-follow-up',
          status: 'queued',
          awaitingTurnStart: undefined,
        }),
      ])
    })
    expect(store.getTask(address)?.derived.isRunning).toBe(false)
  })

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
      expect(getRuntimeTranscript).toHaveBeenCalledWith({
        ...address,
        limit: 50,
        refresh: true,
      })
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

  test('reconciles a provider-renamed terminal turn from the authoritative transcript', async () => {
    const store = new RuntimeTaskLifecycleStore('test')
    const address = runtimeTaskAddress()
    store.syncRuntimeWork(runtimeWork(true))
    store.turnStarted(address, 'provisional-turn')
    let streamHandlers: ChatStreamHandlers = {}
    const listRuntimeWork = vi.fn()
    const getRuntimeTranscript = vi.fn().mockResolvedValue({
      taskId: address.taskId,
      workspacePath: address.workspacePath,
      runtime: address.runtime,
      running: false,
      messages: [
        {
          id: 'assistant-1',
          role: 'assistant',
          content: 'fast completed answer',
          status: 'done',
        },
      ],
      turns: [
        {
          id: 'provider-renamed-turn',
          status: 'completed',
          completedAt: 1_786_692_066_192,
          items: [
            {
              id: 'assistant-item-1',
              type: 'assistant_text',
              content: 'fast completed answer',
              createdAt: 1_786_692_066_192,
            },
          ],
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
      streamHandlers.onChatDone?.({
        taskId: address.taskId,
        deviceId: address.deviceId,
        subtaskId: 'provider-renamed-turn',
        result: {},
      } as never)
    })

    expect(listRuntimeWork).not.toHaveBeenCalled()
    await waitFor(() =>
      expect(getRuntimeTranscript).toHaveBeenCalledWith({
        ...address,
        limit: 50,
        refresh: true,
      })
    )
    await waitFor(() => expect(store.getTask(address)?.turn.outcome).toBe('succeeded'))
    expect(store.getTask(address)?.execution.phase).toBe('idle')
    expect(store.getTask(address)?.derived.shouldShowSidebarRunning).toBe(false)
  })

  test('does not settle a newer turn from a repeated old terminal event', async () => {
    const store = new RuntimeTaskLifecycleStore('test')
    const address = runtimeTaskAddress()
    store.syncRuntimeWork(runtimeWork(true))
    store.turnStarted(address, 'turn-1')
    store.turnSettled(address, 'turn-1', 'succeeded')
    let streamHandlers: ChatStreamHandlers = {}
    const getRuntimeTranscript = vi.fn().mockResolvedValue({
      ...runtimeTranscript(true),
      turns: [
        {
          id: 'turn-1',
          status: 'completed',
          completedAt: 1_786_692_066_192,
          items: [],
        },
        {
          id: 'turn-2',
          status: 'streaming',
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
          listRuntimeWork: vi.fn(),
          getRuntimeTranscript,
        },
      },
    } as unknown as WorkbenchServices

    render(<RuntimeTaskLifecycleStreamCoordinator services={services} store={store} />)
    await act(async () => {
      streamHandlers.onChatStart?.({
        taskId: address.taskId,
        deviceId: address.deviceId,
        subtaskId: 'turn-2',
      })
    })
    expect(store.getTask(address)?.turn.id).toBe('turn-2')
    expect(store.getTask(address)?.derived.shouldShowSidebarRunning).toBe(true)

    await act(async () => {
      streamHandlers.onChatDone?.({
        taskId: address.taskId,
        deviceId: address.deviceId,
        subtaskId: 'turn-1',
        result: { value: 'old answer' },
      })
    })

    await waitFor(() =>
      expect(getRuntimeTranscript).toHaveBeenCalledWith({
        ...address,
        limit: 50,
        refresh: true,
      })
    )
    expect(store.getTask(address)?.turn.id).toBe('turn-2')
    expect(store.getTask(address)?.turn.outcome).toBeNull()
    expect(store.getTask(address)?.execution.phase).toBe('running')
    expect(store.getTask(address)?.derived.shouldShowSidebarRunning).toBe(true)
  })

  test('does not apply a terminal transcript after a newer turn starts', async () => {
    const store = new RuntimeTaskLifecycleStore('test')
    const address = runtimeTaskAddress()
    store.syncRuntimeWork(runtimeWork(true))
    store.turnStarted(address, 'turn-1')
    let streamHandlers: ChatStreamHandlers = {}
    let resolveTranscript: ((value: RuntimeTranscriptResponse) => void) | undefined
    const getRuntimeTranscript = vi.fn(
      () =>
        new Promise<RuntimeTranscriptResponse>(resolve => {
          resolveTranscript = resolve
        })
    )
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
          getRuntimeTranscript,
        },
      },
    } as unknown as WorkbenchServices

    render(<RuntimeTaskLifecycleStreamCoordinator services={services} store={store} />)
    await act(async () => {
      streamHandlers.onChatDone?.({
        taskId: address.taskId,
        deviceId: address.deviceId,
        subtaskId: 'turn-1',
        result: {},
      })
    })
    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(1))

    act(() => store.turnStarted(address, 'turn-2'))
    await act(async () => {
      resolveTranscript?.(runtimeTranscript(false))
    })

    expect(store.getTask(address)?.turn.id).toBe('turn-2')
    expect(store.getTask(address)?.turn.outcome).toBeNull()
    expect(store.getTask(address)?.execution.phase).toBe('running')
    expect(store.getTask(address)?.derived.shouldShowSidebarRunning).toBe(true)
  })

  test('reconciles executor state when completion already carries content', async () => {
    const store = new RuntimeTaskLifecycleStore('test')
    const address = runtimeTaskAddress()
    store.syncRuntimeWork(runtimeWork(true, 'executor-device'))
    store.turnStarted(address, 'turn-1')
    let streamHandlers: ChatStreamHandlers = {}
    const getRuntimeTranscript = vi.fn().mockResolvedValue(runtimeTranscript(false))
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
          getRuntimeTranscript,
        },
      },
    } as unknown as WorkbenchServices

    render(<RuntimeTaskLifecycleStreamCoordinator services={services} store={store} />)
    await act(async () => {
      streamHandlers.onChatDone?.({
        taskId: address.taskId,
        deviceId: 'executor-device',
        subtaskId: 'turn-1',
        result: { value: 'streamed answer' },
      } as never)
    })

    await waitFor(() =>
      expect(getRuntimeTranscript).toHaveBeenCalledWith({
        ...address,
        limit: 50,
        refresh: true,
      })
    )
    await waitFor(() => expect(store.getTask(address)?.execution.phase).toBe('idle'))
    expect(store.getTask(address)?.turn.outcome).toBe('succeeded')
    expect(store.getTask(address)?.derived.shouldShowSidebarRunning).toBe(false)
  })

  test('settles a matching cancellation without projecting executor execution as idle', async () => {
    const store = new RuntimeTaskLifecycleStore('test')
    const address = runtimeTaskAddress()
    store.syncRuntimeWork(runtimeWork(true))
    store.turnStarted(address, 'turn-1')
    let streamHandlers: ChatStreamHandlers = {}
    const listRuntimeWork = vi.fn()
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
      streamHandlers.onChatError?.({
        taskId: address.taskId,
        deviceId: address.deviceId,
        subtaskId: 'turn-1',
        error: 'cancelled',
        type: 'cancelled',
      } as never)
    })

    expect(listRuntimeWork).not.toHaveBeenCalled()
    expect(store.getTask(address)?.turn.outcome).toBe('cancelled')
    expect(store.getTask(address)?.derived.isBusy).toBe(true)
  })

  test('ignores a terminal event for another task', async () => {
    const store = new RuntimeTaskLifecycleStore('test')
    const address = runtimeTaskAddress()
    store.syncRuntimeWork(runtimeWork(true))
    let streamHandlers: ChatStreamHandlers = {}
    const listRuntimeWork = vi.fn()
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
      streamHandlers.onChatDone?.({
        taskId: 'another-task',
        deviceId: address.deviceId,
        subtaskId: 'turn-1',
        result: {},
      } as never)
    })

    expect(listRuntimeWork).not.toHaveBeenCalled()
    expect(store.getTask(address)?.derived.isBusy).toBe(true)
  })
})

function runtimeTaskAddress() {
  return {
    deviceId: 'remote-device',
    taskId: 'claude-task',
    runtime: 'claude_code' as const,
    workspacePath: '/workspace',
  }
}

function runtimeWork(running: boolean, remoteHostId?: string): RuntimeWorkListResponse {
  const address = runtimeTaskAddress()
  return {
    projects: [],
    chats: [
      {
        deviceId: address.deviceId,
        ...(remoteHostId ? { remoteHostId } : {}),
        workspacePath: address.workspacePath,
        available: true,
        tasks: [
          {
            taskId: address.taskId,
            workspacePath: address.workspacePath,
            title: 'Claude task',
            runtime: address.runtime,
            running,
            status: running ? 'active' : 'done',
            ...(running ? {} : { completedAt: 1_786_692_066_192 }),
          },
        ],
      },
    ],
    totalTasks: 1,
  }
}

function runtimeTranscript(running: boolean): RuntimeTranscriptResponse {
  const address = runtimeTaskAddress()
  return {
    taskId: address.taskId,
    workspacePath: address.workspacePath,
    runtime: address.runtime,
    running,
    messages: [],
    turns: [
      {
        id: 'turn-1',
        status: 'completed',
        items: [
          {
            id: 'user-1',
            type: 'user_message',
            message: {
              id: 'user-1',
              role: 'user',
              content: '之前的请求',
              status: 'done',
            },
          },
          {
            id: 'assistant-1',
            type: 'assistant_text',
            content: '已恢复的 AI 输出',
          },
        ],
      },
    ],
  }
}
