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
})
