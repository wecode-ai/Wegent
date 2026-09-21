import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalCommentRecord } from './localProjectChatClient'
import { createLocalProjectChatClient } from './localProjectChatClient'

const request = vi.fn()

function commentRecord(overrides: Partial<LocalCommentRecord> = {}): LocalCommentRecord {
  return {
    id: 1,
    message_id: 'm-1',
    client_message_id: 'cm-1',
    project_id: 'p1',
    task_id: 't1',
    sender_type: 'user',
    sender_id: '0',
    sender_name: 'local',
    message_type: 'text',
    content: '普通评论',
    metadata: {},
    trigger_message_id: null,
    reply_to_message_id: null,
    thread_root_message_id: 'm-1',
    status: 'completed',
    sequence_number: 1,
    created_at: '2026-08-06T00:00:00Z',
    updated_at: '2026-08-06T00:00:00Z',
    ...overrides,
  }
}

describe('createLocalProjectChatClient', () => {
  beforeEach(() => {
    request.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('creates a comment and enqueues a robot run when an agent is mentioned', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'todos.comment.create') {
        return commentRecord({
          content: '@Bot 跑一下',
          metadata: { mentions: [{ type: 'agent', id: 'a1', label: 'Bot' }] },
        })
      }
      return {}
    })
    const client = createLocalProjectChatClient(request, {
      currentUser: { id: 0, user_name: 'local' },
    })

    const message = await client.send({
      projectId: 'p1',
      taskId: 't1',
      clientMessageId: 'cm-1',
      text: '@Bot 跑一下',
      mentions: [{ type: 'agent', id: 'a1', label: 'Bot' }],
    })

    expect(message.messageId).toBe('m-1')
    expect(request).toHaveBeenCalledWith(
      'todos.comment.create',
      expect.objectContaining({
        comment: expect.objectContaining({
          project_id: 'p1',
          task_id: 't1',
          content: '@Bot 跑一下',
          sender_id: '0',
          reply_to_message_id: null,
        }),
      })
    )
    expect(request).toHaveBeenCalledWith(
      'executions.enqueue',
      expect.objectContaining({
        agent_id: 'a1',
        trigger_message_id: 'm-1',
        payload: expect.objectContaining({ text: '@Bot 跑一下' }),
      })
    )
  })

  it('does not enqueue a run without an agent mention', async () => {
    request.mockResolvedValue(commentRecord())
    const client = createLocalProjectChatClient(request, {
      currentUser: { id: 0, user_name: 'local' },
    })

    await client.send({
      projectId: 'p1',
      taskId: 't1',
      clientMessageId: 'cm-2',
      text: '普通评论',
    })

    expect(request).not.toHaveBeenCalledWith('executions.enqueue', expect.anything())
  })

  it('persists a continued turn on the existing runtime session', async () => {
    request.mockResolvedValue(
      commentRecord({
        message_id: 'agent-turn-2',
        sender_type: 'agent',
        sender_id: 'a1',
        sender_name: 'Bot',
        status: 'streaming',
        reply_to_message_id: 'user-turn-2',
        thread_root_message_id: 'root-1',
        metadata: {
          runtime_address: { deviceId: 'local-device', taskId: 'session-1' },
        },
      })
    )
    const client = createLocalProjectChatClient(request, {
      currentUser: { id: 0, user_name: 'local' },
    })

    const response = await client.startAgentResponse({
      projectId: 'p1',
      taskId: 't1',
      triggerMessageId: 'user-turn-2',
      agentId: 'a1',
      runtimeDeviceId: 'local-device',
      runtimeTaskId: 'session-1',
      prompt: '我之前说了啥',
    })

    expect(request).toHaveBeenCalledWith('todos.comment.agent.start', {
      project_id: 'p1',
      task_id: 't1',
      agent_id: 'a1',
      trigger_message_id: 'user-turn-2',
      runtime_device_id: 'local-device',
      runtime_task_id: 'session-1',
      prompt: '我之前说了啥',
      model: null,
    })
    expect(response).toMatchObject({
      messageId: 'agent-turn-2',
      status: 'streaming',
      runtimeAddress: { deviceId: 'local-device', taskId: 'session-1' },
    })
    expect(request).not.toHaveBeenCalledWith('executions.enqueue', expect.anything())
  })

  it('carries the selected local code project into the comment and enqueue payload', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'todos.comment.create') {
        return commentRecord({
          content: '@Bot 跑一下',
          metadata: {
            mentions: [{ type: 'agent', id: 'a1', label: 'Bot' }],
            local_project_id: 91,
          },
        })
      }
      return {}
    })
    const client = createLocalProjectChatClient(request, {
      currentUser: { id: 0, user_name: 'local' },
    })

    await client.send({
      projectId: 'p1',
      taskId: 't1',
      clientMessageId: 'cm-1',
      text: '@Bot 跑一下',
      mentions: [{ type: 'agent', id: 'a1', label: 'Bot' }],
      localProjectId: 91,
    })

    expect(request).toHaveBeenCalledWith(
      'todos.comment.create',
      expect.objectContaining({
        comment: expect.objectContaining({
          metadata: expect.objectContaining({ local_project_id: 91 }),
        }),
      })
    )
    expect(request).toHaveBeenCalledWith(
      'executions.enqueue',
      expect.objectContaining({
        payload: expect.objectContaining({ local_project_id: 91 }),
      })
    )
  })

  it('delivers initial comments and polls for status updates', async () => {
    vi.useFakeTimers()
    const streaming = commentRecord({
      id: 2,
      message_id: 'm-2',
      sender_type: 'agent',
      sender_id: 'a1',
      sender_name: 'Bot',
      content: '',
      status: 'streaming',
      sequence_number: 2,
      metadata: { execution_id: 7 },
      reply_to_message_id: 'm-1',
      thread_root_message_id: 'm-1',
    })
    const completed = {
      ...streaming,
      status: 'completed',
      content: '搞定',
      updated_at: '2026-08-06T00:01:00Z',
    }
    request.mockResolvedValueOnce([streaming]).mockResolvedValueOnce([streaming, completed])

    const client = createLocalProjectChatClient(request, {
      currentUser: { id: 0, user_name: 'local' },
    })
    const onMessage = vi.fn()
    const subscription = await client.subscribe('p1', 't1', 0, onMessage)

    expect(subscription.snapshot.messages).toHaveLength(1)
    expect(subscription.snapshot.currentUserId).toBe('0')
    expect(subscription.snapshot.latestSequence).toBe(2)
    onMessage.mockClear()

    await vi.advanceTimersByTimeAsync(3000)

    expect(onMessage).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: 'm-2', status: 'completed', content: '搞定' })
    )
    subscription.unsubscribe()
  })

  it('maps runtime_address metadata onto agent messages', async () => {
    vi.useFakeTimers()
    request.mockResolvedValue([
      commentRecord({
        id: 2,
        message_id: 'm-2',
        sender_type: 'agent',
        sender_id: 'a1',
        sender_name: 'Bot',
        content: '搞定',
        status: 'completed',
        sequence_number: 2,
        metadata: {
          execution_id: 7,
          runtime_address: { deviceId: 'local-device', taskId: 'codex-queue-7-123' },
        },
      }),
    ])
    const client = createLocalProjectChatClient(request, {
      currentUser: { id: 0, user_name: 'local' },
    })

    const subscription = await client.subscribe('p1', 't1', 0, () => {})

    expect(subscription.snapshot.messages[0].runtimeAddress).toEqual({
      deviceId: 'local-device',
      taskId: 'codex-queue-7-123',
    })
    subscription.unsubscribe()
  })
  it('preserves queued activity and its persisted runtime task link', async () => {
    request.mockResolvedValue([
      commentRecord({
        sender_type: 'agent',
        status: 'pending',
        metadata: {
          execution_id: 4,
          runtime_address: { deviceId: 'local', taskId: 'codex-queue-4' },
        },
      }),
    ])
    const client = createLocalProjectChatClient(request, {
      currentUser: { id: 0, user_name: 'local' },
    })
    const subscription = await client.subscribe('p1', 't1', 0, vi.fn())
    expect(subscription.snapshot.messages[0]).toMatchObject({
      status: 'pending',
      runtimeAddress: { deviceId: 'local', taskId: 'codex-queue-4' },
    })
    subscription.unsubscribe()
  })

  it('reports an initial read failure instead of returning an empty activity list', async () => {
    request.mockRejectedValue(new Error('Local activity database unavailable'))
    const client = createLocalProjectChatClient(request, {
      currentUser: { id: 0, user_name: 'local' },
    })
    await expect(client.subscribe('p1', 't1', 0, vi.fn())).rejects.toThrow(
      'Local activity database unavailable'
    )
    client.dispose()
  })
})
