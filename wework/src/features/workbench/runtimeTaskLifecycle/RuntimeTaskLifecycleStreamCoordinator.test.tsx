import { act, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { RuntimeWorkListResponse } from '@/types/api'
import type { ChatStreamHandlers } from '@/stream/chatStream'
import type { WorkbenchServices } from '../workbenchServices'
import { RuntimeTaskLifecycleStore } from './RuntimeTaskLifecycleStore'
import { RuntimeTaskLifecycleStreamCoordinator } from './RuntimeTaskLifecycleStreamCoordinator'

describe('RuntimeTaskLifecycleStreamCoordinator', () => {
  afterEach(() => {
    vi.useRealTimers()
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

  test('serializes terminal and lag recovery with one trailing reconciliation', async () => {
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
      streamHandlers.onChatDone?.({} as never)
      streamHandlers.onRuntimeEventLagged?.({ skipped: 3 })
      streamHandlers.onChatError?.({} as never)
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

  test('reconciles a terminal event when the matching task remains running', async () => {
    const store = new RuntimeTaskLifecycleStore('test')
    const address = runtimeTaskAddress()
    store.syncRuntimeWork(runtimeWork(true))
    let streamHandlers: ChatStreamHandlers = {}
    const listRuntimeWork = vi.fn(async () => runtimeWork(false))
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
        taskId: address.taskId,
        deviceId: address.deviceId,
      } as never)
      await Promise.resolve()
    })

    await waitFor(() => expect(listRuntimeWork).toHaveBeenCalledTimes(1))
    expect(store.getTask(address)?.execution.phase).toBe('idle')
    expect(store.getTask(address)?.derived.shouldShowSidebarRunning).toBe(false)
  })

  test('does not duplicate reconciliation after the pane settles the terminal event', async () => {
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
      streamHandlers.onChatDone?.({
        taskId: address.taskId,
        deviceId: address.deviceId,
      } as never)
      store.turnSettled(address, 'turn-1', 'succeeded')
      await Promise.resolve()
    })

    expect(listRuntimeWork).not.toHaveBeenCalled()
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

function runtimeWork(running: boolean): RuntimeWorkListResponse {
  const address = runtimeTaskAddress()
  return {
    projects: [],
    chats: [
      {
        deviceId: address.deviceId,
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
