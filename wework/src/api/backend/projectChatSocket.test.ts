import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createProjectChatClient, type ProjectChatMessage } from './projectChatSocket'

const socket = {
  emit: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
}
const ensureConnected = vi.fn().mockResolvedValue(undefined)
const dispose = vi.fn()

vi.mock('@wegent/chat-core', () => ({
  createSocketClient: () => ({ socket, ensureConnected, dispose }),
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
  })

  it('subscribes through the authenticated runtime socket and returns history', async () => {
    socket.emit.mockImplementationOnce((event, payload, ack) => {
      expect(event).toBe('wework:project_chat:subscribe')
      expect(payload).toEqual({ projectId: 'project-1', taskId: undefined, afterSequence: 3 })
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

    const subscription = await client.subscribe('project-1', undefined, 3, vi.fn())

    expect(subscription.snapshot.messages).toEqual([message])
    expect(socket.on).toHaveBeenCalledWith(
      'wework:project_chat:message:created',
      expect.any(Function)
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
      })
    ).resolves.toEqual(message)
  })

  it('refreshes the newest message window after reconnecting', async () => {
    const refreshed = { ...message, content: 'completed content', status: 'completed' as const }
    socket.emit
      .mockImplementationOnce((_event, _payload, ack) =>
        ack({
          ok: true,
          result: { messages: [message], latestSequence: 7, currentUserId: '1' },
        })
      )
      .mockImplementationOnce((event, payload, ack) => {
        expect(event).toBe('wework:project_chat:subscribe')
        expect(payload.afterSequence).toBe(0)
        ack({
          ok: true,
          result: { messages: [refreshed], latestSequence: 7, currentUserId: '1' },
        })
      })
    const onMessage = vi.fn()
    const client = createProjectChatClient({
      socketBaseUrl: 'https://cloud.example.com',
      socketPath: '/socket.io',
      getToken: () => 'token',
    })
    await client.subscribe('project-1', undefined, 0, onMessage)
    const connectHandler = socket.on.mock.calls.find(([event]) => event === 'connect')?.[1]

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
      expect.anything()
    )

    second.unsubscribe()
    expect(socket.emit).toHaveBeenCalledWith('wework:project_chat:unsubscribe', {
      projectId: 'project-1',
      taskId: 'task-1',
    })
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
      })
    ).resolves.toEqual(message)
  })
})
