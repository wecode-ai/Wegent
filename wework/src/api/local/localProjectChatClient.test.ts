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

  it('persists mentions without dispatching a second execution', async () => {
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
    expect(request).toHaveBeenCalledOnce()
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

  it('persists the selected local code project with the comment', async () => {
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
    expect(request).toHaveBeenCalledOnce()
  })

  it('persists a response and its runtime address through the local IPC store', async () => {
    request.mockResolvedValue(
      commentRecord({
        sender_type: 'agent',
        status: 'streaming',
        metadata: { runtime_address: { deviceId: 'device', taskId: 'runtime' } },
      })
    )
    const client = createLocalProjectChatClient(request, {
      currentUser: { id: 0, user_name: 'local' },
    })
    const response = await client.startAgentResponse({
      projectId: 'p1',
      taskId: 't1',
      triggerMessageId: 'root',
      runtimeDeviceId: 'device',
      runtimeTaskId: 'runtime',
    })
    expect(request).toHaveBeenCalledWith('todos.comment.start', {
      comment: expect.objectContaining({
        client_message_id: 'runtime:device:runtime:root',
        sender_type: 'agent',
        reply_to_message_id: 'root',
        metadata: expect.objectContaining({ conversation_only: true }),
      }),
    })
    expect(response.runtimeAddress).toEqual({ deviceId: 'device', taskId: 'runtime' })
    request.mockResolvedValue(commentRecord({ sender_type: 'agent', status: 'failed' }))
    await client.failAgentResponse({
      projectId: 'p1',
      taskId: 't1',
      messageId: response.messageId,
      error: 'unavailable',
    })
    expect(request).toHaveBeenLastCalledWith('todos.comment.fail', {
      project_id: 'p1',
      task_id: 't1',
      message_id: response.messageId,
      error: 'unavailable',
    })
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
})
