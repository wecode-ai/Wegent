// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createProjectChatClient,
  type LoopItemChangedEvent,
  type ProjectChatMessage,
} from './project-chat'

const socket = {
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}
const ensureConnected = vi.fn().mockResolvedValue(undefined)
const dispose = vi.fn()
const onReconnect = vi.fn()

vi.mock('./socket', () => ({
  createSocketClient: () => ({ socket, ensureConnected, dispose, onReconnect }),
}))

const message: ProjectChatMessage = {
  sequenceNumber: 7,
  messageId: 'message-7',
  projectId: 'project-1',
  taskId: null,
  sender: { type: 'user', id: '42', name: 'Ada' },
  type: 'text',
  content: 'hello',
  metadata: {},
  status: 'completed',
  createdAt: '2026-08-03T00:00:00Z',
  updatedAt: '2026-08-03T00:00:00Z',
}

describe('createProjectChatClient', () => {
  beforeEach(() => {
    socket.emit.mockReset()
    socket.on.mockReset()
    socket.off.mockReset()
    ensureConnected.mockClear()
    onReconnect.mockReset()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exposes authenticated reconnect notifications for failed subscriptions', () => {
    const callback = vi.fn()
    const stop = vi.fn()
    onReconnect.mockReturnValue(stop)
    const client = createProjectChatClient({
      socketBaseUrl: 'https://cloud.example.com',
      socketPath: '/socket.io',
      getToken: () => 'token',
    })
    expect(client.onReconnect!(callback)).toBe(stop)
    expect(onReconnect).toHaveBeenCalledWith(callback)
  })

  it('resolves missing runner choices and replays the saved comment once', async () => {
    const request = {
      runtime: 'codex',
      execution_policy: { mode: 'user_select' },
    }
    const selection = {
      execution_policy: { mode: 'fixed', environment_id: '41' },
    }
    socket.emit
      .mockImplementationOnce((_event, _payload, ack) =>
        ack({
          ok: false,
          error: {
            code: 'RUNNER_SELECTION_REQUIRED',
            message: 'Choose a runner',
            detail: { runner_selection_request: request },
          },
        }),
      )
      .mockImplementationOnce((_event, _payload, ack) =>
        ack({ ok: true, result: [message] }),
      )
    const requestRunnerSelection = vi.fn(async () => selection)
    const client = createProjectChatClient({
      socketBaseUrl: 'https://cloud.example.com',
      socketPath: '/socket.io',
      getToken: () => 'token',
      requestRunnerSelection,
    })
    const input = {
      projectId: 'project-1',
      taskId: 'issue-1',
      triggerMessageId: 'saved-comment',
      attachmentIds: [],
    }
    await expect(client.executeTaskComment!(input)).resolves.toEqual([message])
    expect(requestRunnerSelection).toHaveBeenCalledWith(request)
    expect(socket.emit).toHaveBeenCalledTimes(2)
    expect(socket.emit).toHaveBeenLastCalledWith(
      'wework:project_chat:comment:execute',
      { ...input, runnerSelection: selection },
      expect.any(Function),
    )
  })

  it('subscribes through the authenticated runtime socket and returns history', async () => {
    socket.emit.mockImplementationOnce((event, payload, ack) => {
      expect(event).toBe('wework:project_chat:subscribe')
      expect(payload).toEqual({
        projectId: 'project-1',
        taskId: undefined,
        afterSequence: 3,
      })
      ack({
        ok: true,
        result: { messages: [message], latestSequence: 7, currentUserId: '1' },
      })
    })
    const client = createProjectChatClient({
      socketBaseUrl: 'https://cloud.example.com',
      socketPath: '/socket.io',
      getToken: () => 'token',
    })

    const subscription = await client.subscribe(
      'project-1',
      undefined,
      3,
      vi.fn(),
    )

    expect(subscription.snapshot.messages).toEqual([message])
    expect(socket.on).toHaveBeenCalledWith(
      'wework:project_chat:message:created',
      expect.any(Function),
    )
    subscription.unsubscribe()
    expect(socket.off).toHaveBeenCalledTimes(3)
  })

  it('sends text over the socket with an idempotency key', async () => {
    socket.emit.mockImplementation((event, payload, ack) => {
      expect(event).toBe('wework:project_chat:message:send')
      expect(payload).toMatchObject({
        projectId: 'project-1',
        taskId: 'task-1',
        clientMessageId: 'client-1',
        content: 'hello',
      })
      ack({ ok: true, result: message })
    })
    const client = createProjectChatClient({
      socketBaseUrl: 'https://cloud.example.com',
      socketPath: '/socket.io',
      getToken: () => 'token',
    })

    await expect(
      client.send({
        projectId: 'project-1',
        taskId: 'task-1',
        clientMessageId: 'client-1',
        text: 'hello',
      }),
    ).resolves.toEqual(message)
  })

  it('subscribes to loop-item invalidation events on the authenticated user socket', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const onChange = vi.fn()
    const client = createProjectChatClient({
      socketBaseUrl: 'https://cloud.example.com',
      socketPath: '/socket.io',
      getToken: () => 'token',
    })

    const unsubscribe = await client.subscribeLoopItemChanges!(onChange)

    expect(ensureConnected).toHaveBeenCalled()
    const handler = socket.on.mock.calls.find(
      ([event]) => event === 'wework:loop_item:changed',
    )?.[1]
    expect(handler).toBeTypeOf('function')
    const event = {
      projectId: 'project-1',
      itemId: 'issue-1',
      version: 3,
      reason: 'user_update',
      ignoredPayload: 'unrecorded secret',
    }
    handler(event)
    expect(onChange).toHaveBeenCalledWith(event)
    expect(debug).toHaveBeenCalledOnce()
    expect(debug.mock.calls[0]?.[1]).toEqual({
      projectId: event.projectId,
      itemId: event.itemId,
      version: event.version,
      reason: event.reason,
    })
    expect(JSON.stringify(debug.mock.calls)).not.toContain(event.ignoredPayload)
    unsubscribe()
    expect(socket.off).toHaveBeenCalledWith('wework:loop_item:changed', handler)
  })

  it('receives buffered invalidations delivered before connection readiness resolves', async () => {
    vi.spyOn(console, 'debug').mockImplementation(() => undefined)
    const listeners = new Map<string, (event: LoopItemChangedEvent) => void>()
    socket.on.mockImplementation((event, handler) =>
      listeners.set(event, handler),
    )
    let finishConnection!: () => void
    ensureConnected.mockReturnValueOnce(
      new Promise<void>((resolve) => {
        finishConnection = resolve
      }),
    )
    const onChange = vi.fn()
    const client = createProjectChatClient({
      socketBaseUrl: 'https://cloud.example.com',
      socketPath: '/socket.io',
      getToken: () => 'token',
    })
    const event: LoopItemChangedEvent = {
      projectId: 'project-1',
      itemId: 'issue-1',
      version: 3,
      reason: 'user_update',
    }

    const pending = client.subscribeLoopItemChanges!(onChange)
    listeners.get('wework:loop_item:changed')?.(event)
    finishConnection()
    const unsubscribe = await pending
    unsubscribe()

    expect(onChange).toHaveBeenCalledExactlyOnceWith(event)
  })

  it('removes the invalidation listener when connection readiness rejects', async () => {
    const listeners = new Map<string, (event: LoopItemChangedEvent) => void>()
    socket.on.mockImplementation((event, handler) =>
      listeners.set(event, handler),
    )
    socket.off.mockImplementation((event, handler) => {
      if (listeners.get(event) === handler) listeners.delete(event)
    })
    const connectionError = new Error('Connection failed')
    ensureConnected.mockRejectedValueOnce(connectionError)
    const client = createProjectChatClient({
      socketBaseUrl: 'https://cloud.example.com',
      socketPath: '/socket.io',
      getToken: () => 'token',
    })

    await expect(client.subscribeLoopItemChanges!(vi.fn())).rejects.toBe(
      connectionError,
    )

    expect(listeners.has('wework:loop_item:changed')).toBe(false)
    expect(socket.off).toHaveBeenCalledWith(
      'wework:loop_item:changed',
      expect.any(Function),
    )
  })

  it('refreshes the newest message window after reconnecting', async () => {
    const refreshed = {
      ...message,
      content: 'completed content',
      status: 'completed' as const,
    }
    socket.emit
      .mockImplementationOnce((_event, _payload, ack) =>
        ack({
          ok: true,
          result: {
            messages: [message],
            latestSequence: 7,
            currentUserId: '1',
          },
        }),
      )
      .mockImplementationOnce((event, payload, ack) => {
        expect(event).toBe('wework:project_chat:subscribe')
        expect(payload.afterSequence).toBe(0)
        ack({
          ok: true,
          result: {
            messages: [refreshed],
            latestSequence: 7,
            currentUserId: '1',
          },
        })
      })
    const onMessage = vi.fn()
    const client = createProjectChatClient({
      socketBaseUrl: 'https://cloud.example.com',
      socketPath: '/socket.io',
      getToken: () => 'token',
    })
    await client.subscribe('project-1', undefined, 0, onMessage)
    const connectHandler = socket.on.mock.calls.find(
      ([event]) => event === 'connect',
    )?.[1]

    connectHandler()

    await vi.waitFor(() => expect(onMessage).toHaveBeenCalledWith(refreshed))
  })

  it('keeps the server room while a newer overlapping subscription is active', async () => {
    socket.emit.mockImplementation((event, _payload, ack) => {
      if (event === 'wework:project_chat:subscribe') {
        ack({
          ok: true,
          result: { messages: [], latestSequence: 0, currentUserId: '1' },
        })
      }
    })
    const client = createProjectChatClient({
      socketBaseUrl: 'https://cloud.example.com',
      socketPath: '/socket.io',
      getToken: () => 'token',
    })

    const first = await client.subscribe('project-1', 'task-1', 0, vi.fn())
    const second = await client.subscribe('project-1', 'task-1', 0, vi.fn())

    first.unsubscribe()
    expect(socket.emit).not.toHaveBeenCalledWith(
      'wework:project_chat:unsubscribe',
      expect.anything(),
    )

    second.unsubscribe()
    expect(socket.emit).toHaveBeenCalledWith(
      'wework:project_chat:unsubscribe',
      {
        projectId: 'project-1',
        taskId: 'task-1',
      },
    )
  })

  it('starts a server-owned streaming AI response', async () => {
    socket.emit.mockImplementation((event, payload, ack) => {
      expect(event).toBe('wework:project_chat:agent:start')
      expect(payload).toMatchObject({
        projectId: 'project-1',
        triggerMessageId: 'message-7',
        agentId: '12',
        runtimeTaskId: 'runtime-task-1',
      })
      ack({ ok: true, result: message })
    })
    const client = createProjectChatClient({
      socketBaseUrl: 'https://cloud.example.com',
      socketPath: '/socket.io',
      getToken: () => 'token',
    })

    await expect(
      client.startAgentResponse({
        projectId: 'project-1',
        triggerMessageId: 'message-7',
        agentId: '12',
        runtimeDeviceId: 'device-1',
        runtimeTaskId: 'runtime-task-1',
      }),
    ).resolves.toEqual(message)
  })

  it('continues the native Wegent Task bound to a board reply', async () => {
    socket.emit.mockImplementation((event, payload, ack) => {
      expect(event).toBe('wework:project_chat:wegent:continue')
      expect(payload).toEqual({
        projectId: 'project-1',
        taskId: 'task-1',
        triggerMessageId: 'message-7',
        agentId: '12',
        attachmentIds: [9],
      })
      ack({ ok: true, result: message })
    })
    const client = createProjectChatClient({
      socketBaseUrl: 'https://cloud.example.com',
      socketPath: '/socket.io',
      getToken: () => 'token',
    })

    await expect(
      client.continueWegentTask!({
        projectId: 'project-1',
        taskId: 'task-1',
        triggerMessageId: 'message-7',
        agentId: '12',
        attachmentIds: [9],
      }),
    ).resolves.toEqual(message)
  })
})

it('requests comment execution using only the saved project comment identity', async () => {
  socket.emit.mockImplementation((event, payload, ack) => {
    expect(event).toBe('wework:project_chat:comment:execute')
    expect(payload).toEqual({
      projectId: 'p',
      taskId: 't',
      triggerMessageId: 'm',
      attachmentIds: [9],
    })
    ack({ ok: true, result: [message] })
  })
  const client = createProjectChatClient({
    socketBaseUrl: 'https://cloud.example.com',
    socketPath: '/socket.io',
    getToken: () => 'token',
  })
  await expect(
    client.executeTaskComment!({
      projectId: 'p',
      taskId: 't',
      triggerMessageId: 'm',
      attachmentIds: [9],
    }),
  ).resolves.toEqual([message])
})
