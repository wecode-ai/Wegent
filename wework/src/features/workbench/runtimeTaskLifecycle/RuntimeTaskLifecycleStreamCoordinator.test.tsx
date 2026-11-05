import { act, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
import type { ChatStreamHandlers } from '@/stream/chatStream'
import type { WorkbenchServices } from '../workbenchServices'
import {
  applyRuntimeConversationAction,
  clearRuntimeConversationCacheForTests,
  getRuntimeConversationMessages,
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

  test('reconciles a provider-renamed terminal turn from the authoritative transcript', async () => {
    const store = new RuntimeTaskLifecycleStore('test')
    const address = runtimeTaskAddress()
    store.syncRuntimeWork(runtimeWork(true))
    store.turnStarted(address, 'provisional-turn')
    applyRuntimeConversationAction(address, {
      type: 'user_added',
      message: {
        id: 'optimistic-user',
        role: 'user',
        content: 'continue',
        status: 'done',
        createdAt: '2026-08-21T14:39:00.000Z',
      },
    })
    applyRuntimeConversationAction(address, {
      type: 'assistant_started',
      subtaskId: 'provisional-turn',
    })
    let streamHandlers: ChatStreamHandlers = {}
    const listRuntimeWork = vi.fn()
    const getRuntimeTranscript = vi.fn().mockResolvedValue({
      taskId: address.taskId,
      workspacePath: address.workspacePath,
      runtime: address.runtime,
      running: false,
      supersededTurnIds: ['provisional-turn'],
      fullContent: true,
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
              id: 'native-user',
              type: 'user_message',
              message: {
                id: 'native-user',
                clientUserMessageId: 'optimistic-user',
                role: 'user',
                content: 'continue',
                status: 'done',
              },
            },
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
      expect(getRuntimeTranscript).toHaveBeenCalledWith(
        {
          ...address,
          limit: 5,
        },
        { signal: expect.any(AbortSignal) }
      )
    )
    await waitFor(() => expect(store.getTask(address)?.turn.outcome).toBe('succeeded'))
    expect(store.getTask(address)?.execution.phase).toBe('idle')
    expect(store.getTask(address)?.derived.shouldShowSidebarRunning).toBe(false)
    expect(getRuntimeConversationMessages(address).map(message => message.content)).toEqual([
      'continue',
      'fast completed answer',
    ])
  })

  test('replaces an optimistic turn after the executor projection settles during transcript refresh', async () => {
    const store = new RuntimeTaskLifecycleStore('test')
    const address = runtimeTaskAddress()
    store.syncRuntimeWork(runtimeWork(true))
    store.turnStarted(address, 'provisional-turn')
    applyRuntimeConversationAction(address, {
      type: 'user_added',
      message: {
        id: 'optimistic-user',
        role: 'user',
        content: 'continue',
        status: 'done',
        createdAt: '2026-08-21T14:39:00.000Z',
      },
    })
    applyRuntimeConversationAction(address, {
      type: 'assistant_started',
      subtaskId: 'provisional-turn',
    })
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
        subtaskId: 'provider-renamed-turn',
        result: {},
      } as never)
    })
    await waitFor(() => expect(getRuntimeTranscript).toHaveBeenCalledTimes(1))

    act(() => store.syncRuntimeWork(runtimeWork(false)))
    await act(async () => {
      resolveTranscript?.({
        taskId: address.taskId,
        workspacePath: address.workspacePath,
        runtime: address.runtime,
        running: false,
        supersededTurnIds: ['provisional-turn'],
        fullContent: true,
        messages: [],
        turns: [
          {
            id: 'provider-renamed-turn',
            status: 'completed',
            completedAt: 1_786_692_066_192,
            items: [
              {
                id: 'native-user',
                type: 'user_message',
                message: {
                  id: 'native-user',
                  clientUserMessageId: 'optimistic-user',
                  role: 'user',
                  content: 'continue',
                  status: 'done',
                },
              },
              {
                id: 'assistant-item-1',
                type: 'assistant_text',
                content: 'authoritative completed answer',
                createdAt: 1_786_692_066_192,
              },
            ],
          },
        ],
      })
    })

    expect(store.getTask(address)?.execution.phase).toBe('idle')
    expect(store.getTask(address)?.turn.phase).toBe('idle')
    expect(getRuntimeConversationMessages(address).map(message => message.content)).toEqual([
      'continue',
      'authoritative completed answer',
    ])
  })

  test.each([true, false])(
    'does not settle a newer turn from an old terminal event (current turn in history: %s)',
    async currentTurnInHistory => {
      const store = new RuntimeTaskLifecycleStore('test')
      const address = runtimeTaskAddress()
      store.syncRuntimeWork(runtimeWork(true))
      store.turnStarted(address, 'turn-1')
      store.turnSettled(address, 'turn-1', 'succeeded')
      let streamHandlers: ChatStreamHandlers = {}
      const getRuntimeTranscript = vi.fn().mockResolvedValue({
        ...runtimeTranscript(currentTurnInHistory),
        turns: [
          {
            id: 'turn-1',
            status: 'completed',
            completedAt: 1_786_692_066_192,
            items: [],
          },
          ...(currentTurnInHistory
            ? [
                {
                  id: 'turn-2',
                  status: 'streaming',
                  items: [],
                },
              ]
            : []),
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
        expect(getRuntimeTranscript).toHaveBeenCalledWith(
          {
            ...address,
            limit: 5,
          },
          { signal: expect.any(AbortSignal) }
        )
      )
      expect(store.getTask(address)?.turn.id).toBe('turn-2')
      expect(store.getTask(address)?.turn.outcome).toBeNull()
      expect(store.getTask(address)?.execution.phase).toBe('running')
      expect(store.getTask(address)?.derived.shouldShowSidebarRunning).toBe(true)
    }
  )

  test('reconciles terminal messages without settling a newer turn', async () => {
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
    expect(getRuntimeConversationMessages(address).map(message => message.content)).toEqual([
      '之前的请求',
      '已恢复的 AI 输出',
    ])
  })

  test.each(['submitting', 'awaiting'] as const)(
    'preserves a %s compaction when the previous terminal transcript returns',
    async phase => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-08-21T00:00:01.000Z'))
      const store = new RuntimeTaskLifecycleStore('test')
      const address = runtimeTaskAddress()
      store.syncRuntimeWork(runtimeWork(true))
      store.turnStarted(address, 'turn-1')
      let streamHandlers: ChatStreamHandlers = {}
      let resolveTranscript!: (value: RuntimeTranscriptResponse) => void
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
        executorClient: { runtime: { getRuntimeTranscript } },
      } as unknown as WorkbenchServices
      render(<RuntimeTaskLifecycleStreamCoordinator services={services} store={store} />)
      await act(async () => {
        streamHandlers.onChatDone?.({
          taskId: address.taskId,
          deviceId: address.deviceId,
          subtaskId: 'turn-1',
          result: {},
        } as never)
      })
      expect(getRuntimeTranscript).toHaveBeenCalledTimes(1)
      const subtaskId = `${address.taskId}-context-compact`
      act(() => {
        store.sendRequested(address)
        if (phase === 'awaiting') store.sendAccepted(address)
        applyRuntimeConversationAction(address, { type: 'assistant_started', subtaskId })
        applyRuntimeConversationAction(address, {
          type: 'block_created',
          subtaskId,
          block: {
            id: 'compact-pending',
            type: 'tool',
            toolName: 'context_compaction',
            status: 'pending',
            createdAt: Date.now(),
          },
        })
      })
      await act(async () => {
        vi.setSystemTime(new Date('2026-08-21T00:00:02.000Z'))
        resolveTranscript({ ...runtimeTranscript(false), fullContent: true })
      })
      expect(store.getTask(address)?.turn.phase).toBe(phase)
      expect(store.getTask(address)?.derived.isBusy).toBe(true)
      expect(getRuntimeConversationMessages(address).at(-1)?.blocks).toEqual([
        expect.objectContaining({ id: 'compact-pending', status: 'pending' }),
      ])
    }
  )

  test('settles a terminal turn recovered by an older transcript request', async () => {
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

    act(() => {
      store.syncTranscript(address, {
        ...runtimeTranscript(true),
        turns: [{ id: 'turn-1', status: 'streaming', items: [] }],
      })
    })
    expect(store.getTask(address)?.turn).toMatchObject({
      id: 'turn-1',
      phase: 'streaming',
    })

    await act(async () => {
      resolveTranscript?.(runtimeTranscript(false))
    })

    expect(store.getTask(address)?.execution.phase).toBe('idle')
    expect(store.getTask(address)?.turn.phase).toBe('idle')
    expect(store.getTask(address)?.turn.outcome).toBe('succeeded')
    expect(store.getTask(address)?.derived.shouldShowSidebarRunning).toBe(false)
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
      expect(getRuntimeTranscript).toHaveBeenCalledWith(
        {
          ...address,
          limit: 5,
        },
        { signal: expect.any(AbortSignal) }
      )
    )
    await waitFor(() => expect(store.getTask(address)?.execution.phase).toBe('idle'))
    expect(store.getTask(address)?.turn.outcome).toBe('succeeded')
    expect(store.getTask(address)?.derived.shouldShowSidebarRunning).toBe(false)
  })

  test('reconciles an app binding into the canonical runtime conversation', async () => {
    const store = new RuntimeTaskLifecycleStore('test')
    const runtimeAddress = {
      ...runtimeTaskAddress(),
      deviceId: 'electron-runtime-device',
    }
    const appAddress = {
      ...runtimeAddress,
      deviceId: 'app-record-65',
    }
    store.syncDevices([
      {
        id: 65,
        device_id: runtimeAddress.deviceId,
        name: 'Local Executor',
        status: 'online',
        is_default: true,
        device_type: 'app',
        bind_shell: 'claudecode',
        socket_device_id: appAddress.deviceId,
        runtime_routes: [
          {
            kind: 'local-ipc',
            device_id: appAddress.deviceId,
            runtime_device_id: runtimeAddress.deviceId,
            status: 'online',
          },
        ],
      },
    ])
    const canonicalRuntimeWork = runtimeWork(true)
    canonicalRuntimeWork.chats[0]!.deviceId = runtimeAddress.deviceId
    store.syncRuntimeWork(canonicalRuntimeWork)
    store.turnStarted(appAddress, 'turn-1')
    let streamHandlers: ChatStreamHandlers = {}
    const completedTranscript = runtimeTranscript(false)
    const getRuntimeTranscript = vi.fn().mockResolvedValue(completedTranscript)
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
        taskId: runtimeAddress.taskId,
        deviceId: runtimeAddress.deviceId,
        subtaskId: 'turn-1',
        result: { value: 'canonical app reply' },
      } as never)
    })

    await waitFor(() =>
      expect(getRuntimeTranscript).toHaveBeenCalledWith(
        expect.objectContaining({
          ...runtimeAddress,
          limit: 5,
        }),
        { signal: expect.any(AbortSignal) }
      )
    )
    await waitFor(() =>
      expect(getRuntimeConversationMessages(runtimeAddress)).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'assistant',
            content: '已恢复的 AI 输出',
          }),
        ])
      )
    )
    expect(getRuntimeConversationMessages(appAddress)).toEqual([])
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

  test('reconciles a matching failed turn so its composer becomes idle', async () => {
    const store = new RuntimeTaskLifecycleStore('failed-turn-reconciliation')
    const address = runtimeTaskAddress()
    store.syncRuntimeWork(runtimeWork(true))
    store.turnStarted(address, 'turn-1')
    let streamHandlers: ChatStreamHandlers = {}
    const getRuntimeTranscript = vi.fn().mockResolvedValue({
      ...runtimeTranscript(false),
      turns: [{ id: 'turn-1', status: 'failed', completedAt: 1791779519416, items: [] }],
    })
    const services = {
      chatStream: {
        subscribe: vi.fn((handlers: ChatStreamHandlers) => {
          streamHandlers = handlers
          return vi.fn()
        }),
      },
      executorClient: {
        runtime: { listRuntimeWork: vi.fn(), getRuntimeTranscript },
      },
    } as unknown as WorkbenchServices
    render(<RuntimeTaskLifecycleStreamCoordinator services={services} store={store} />)
    await act(async () => {
      streamHandlers.onChatError?.({
        taskId: address.taskId,
        deviceId: address.deviceId,
        subtaskId: 'turn-1',
        error: 'context window exceeded',
      } as never)
    })
    await waitFor(() => expect(store.getTask(address)?.derived.isBusy).toBe(false))
    expect(getRuntimeTranscript).toHaveBeenCalledTimes(1)
    expect(store.getTask(address)?.turn.outcome).toBe('failed')
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
