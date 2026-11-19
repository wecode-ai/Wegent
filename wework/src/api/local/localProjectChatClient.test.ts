import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { LocalCommentRecord } from './localProjectChatClient'
import { createLocalProjectChatClient } from './localProjectChatClient'
import { timelineMessageKind } from '@/features/collaboration-exp/model/messageLayer'

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
  it('publishes an assistant conclusion through native source verification', async () => {
    request.mockResolvedValue(
      commentRecord({
        generation_source: 'ai',
        publication_source: 'human',
        confirmation_state: 'authorized',
      })
    )
    const client = createLocalProjectChatClient(request, {
      currentUser: { id: 0, user_name: 'local' },
    })
    const result = await client.publishAssistantMessage!({
      projectId: 'p1',
      taskId: 't1',
      clientMessageId: 'cm-1',
      text: 'Approved result',
      source: { deviceId: 'mac', taskId: 'private' },
    })
    expect(request).toHaveBeenCalledExactlyOnceWith('todos.comment.publish_assistant', {
      device_id: 'mac',
      runtime_task_id: 'private',
      comment: {
        project_id: 'p1',
        task_id: 't1',
        client_message_id: 'cm-1',
        sender_type: 'user',
        sender_id: '0',
        sender_name: 'local',
        content: 'Approved result',
        metadata: {},
        reply_to_message_id: null,
      },
    })
    expect(result).toMatchObject({
      generationSource: 'ai',
      publicationSource: 'human',
      confirmationState: 'authorized',
    })
  })
  it('keeps process chunks in the execution layer and follows runtime owner instead of trigger author', async () => {
    request.mockResolvedValue([
      commentRecord({
        sender_type: 'agent',
        actor_user_id: '8',
        runtime_owner_user_id: '7',
        message_type: 'agent_chunk',
        content: 'private output',
        metadata: { runtime_address: { deviceId: 'mac', taskId: 'private' } },
      }),
    ])
    for (const id of [7, 8]) {
      const client = createLocalProjectChatClient(request, {
        currentUser: { id, user_name: 'viewer' },
      })
      const subscription = await client.subscribe('p1', 't1', 0, vi.fn())
      const message = subscription.snapshot.messages[0]
      expect(timelineMessageKind(message)).toBe('execution')
      expect(message.actorUserId).toBe('8')
      expect(message.content).toBe(id === 7 ? 'private output' : '')
      expect(message.runtimeAddress).toEqual(
        id === 7 ? { deviceId: 'mac', taskId: 'private' } : undefined
      )
      subscription.unsubscribe()
    }
  })
  it('preserves native-owner sources across cloud identity without exposing another participant', async () => {
    request.mockResolvedValue([
      commentRecord({
        actor_user_id: '0',
        runtime_owner_user_id: '0',
        metadata: {
          runtime_address: { deviceId: 'mac', taskId: 'private' },
          runtime_turn_id: 'turn',
        },
      }),
      commentRecord({
        message_id: 'foreign',
        sender_id: '42',
        actor_user_id: '42',
        metadata: { runtime_address: { deviceId: 'mac', taskId: 'foreign' } },
      }),
      commentRecord({
        message_id: 'reply',
        sender_type: 'agent',
        actor_user_id: '0',
        trigger_message_id: 'm-1',
      }),
    ])
    const client = createLocalProjectChatClient(request, {
      currentUser: { id: 86, user_name: 'cloud' },
      viewerUserIds: [0, 86],
    })
    const subscription = await client.subscribe('p1', 't1', 0, vi.fn())
    const [own, foreign, reply] = subscription.snapshot.messages
    expect(own.runtimeAddress).toEqual({ deviceId: 'mac', taskId: 'private' })
    expect(own.metadata.runtime_turn_id).toBe('turn')
    expect(foreign.runtimeAddress).toBeUndefined()
    expect(foreign.metadata.runtime_address).toBeUndefined()
    expect(reply.triggerMessageId).toBe('m-1')
    subscription.unsubscribe()
  })
  beforeEach(() => {
    request.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('persists a comment before explicitly preparing and enqueueing its run', async () => {
    request.mockImplementation(async (method: string) => {
      if (method === 'todos.comment.create') {
        return commentRecord({
          content: '@Bot 跑一下',
          metadata: { mentions: [{ type: 'agent', id: 'a1', label: 'Bot' }] },
        })
      }
      if (method === 'todos.comment.list')
        return [
          commentRecord({
            content: '@Bot 跑一下',
            metadata: { mentions: [{ type: 'agent', id: 'a1' }] },
          }),
        ]
      return {}
    })
    const client = createLocalProjectChatClient(request, {
      currentUser: { id: 0, user_name: 'local' },
      prepareExecution: vi.fn(async ({ text }) => ({
        message: text,
        runnerRouting: { environment_id: 'local-device' },
      })),
    })

    const message = await client.send({
      projectId: 'p1',
      taskId: 't1',
      clientMessageId: 'cm-1',
      text: '@Bot 跑一下',
      mentions: [{ type: 'agent', id: 'a1', label: 'Bot' }],
    })

    expect(request).not.toHaveBeenCalledWith('executions.enqueue', expect.anything())
    await client.executeTaskComment!({
      projectId: 'p1',
      taskId: 't1',
      triggerMessageId: message.messageId,
      attachmentIds: [],
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
        payload: expect.objectContaining({
          message: '@Bot 跑一下',
          runnerRouting: { environment_id: 'local-device' },
        }),
      })
    )
  })

  it.each([undefined, 7])(
    'queues replies using the persisted thread format (execution %s)',
    async executionId => {
      const root = commentRecord({
        message_id: 'root',
        sender_type: 'agent',
        sender_id: 'a1',
        thread_root_message_id: 'root',
        metadata: {
          runtime_address: { deviceId: 'runner-a', taskId: 'session' },
          ...(executionId ? { execution_id: executionId } : {}),
        },
      })
      const reply = commentRecord({
        message_id: 'reply',
        reply_to_message_id: 'root',
        thread_root_message_id: 'root',
      })
      request.mockImplementation(async method =>
        method === 'todos.comment.list' ? [root, reply] : {}
      )
      const prepareExecution = vi.fn(async () => ({
        runnerRouting: { environment_id: 'runner-a' },
      }))
      const client = createLocalProjectChatClient(request, {
        currentUser: { id: 0, user_name: 'local' },
        prepareExecution,
      })
      await client.executeTaskComment!({
        projectId: 'p1',
        taskId: 't1',
        triggerMessageId: 'reply',
        attachmentIds: [],
      })
      expect(prepareExecution).toHaveBeenCalledTimes(executionId ? 0 : 1)
      expect(request).toHaveBeenCalledWith(
        'executions.enqueue',
        expect.objectContaining({ agent_id: 'a1', trigger_message_id: 'reply' })
      )
    }
  )

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

  it.each(['agent_status', 'agent_chunk'])(
    'does not reveal another owner private %s source',
    async messageType => {
      request.mockResolvedValue([
        commentRecord({
          sender_type: 'agent',
          actor_user_id: '8',
          message_type: messageType,
          content: 'PRIVATE TOOL OUTPUT',
          metadata: {
            private_prompt: 'secret',
            runtime_address: { deviceId: 'private-device', taskId: 'private-task' },
          },
        }),
      ])
      const client = createLocalProjectChatClient(request, {
        currentUser: { id: 7, user_name: 'owner' },
      })
      const subscription = await client.subscribe('p1', 't1', 0, vi.fn())
      const message = subscription.snapshot.messages[0]
      expect(message.content).toBe('')
      expect(message.runtimeAddress).toBeUndefined()
      expect(message.metadata).toEqual({})
      expect(message.traceState).toBe('history-unavailable')
      subscription.unsubscribe()
    }
  )

  it('keeps a shared agent Runtime source available to its trigger reader', async () => {
    request.mockResolvedValue([
      commentRecord({
        sender_type: 'agent',
        actor_user_id: '8',
        sender_id: 'agent-1',
        message_type: 'agent_chunk',
        content: 'PRIVATE TOOL OUTPUT',
        runtime_owner_user_id: '7',
        runtime_shared: true,
        trace_ref: 'trace',
        metadata: {
          private_prompt: 'not shared',
          run_status: 'running',
          execution_id: 42,
          workflow_task_title: 'Assigned task',
          runtime_address: { deviceId: 'shared-device', taskId: 'shared-task' },
        },
      }),
    ])
    const client = createLocalProjectChatClient(request, {
      currentUser: { id: 8, user_name: 'member' },
    })
    const subscription = await client.subscribe('p1', 't1', 0, vi.fn())
    expect(subscription.snapshot.messages[0]).toMatchObject({
      actorUserId: '8',
      content: '',
      runtimeAddress: { deviceId: 'shared-device', taskId: 'shared-task' },
      traceState: 'available',
      metadata: {
        run_status: 'running',
        execution_id: 42,
        workflow_task_title: 'Assigned task',
      },
    })
    subscription.unsubscribe()
  })

  it('hides a private agent Runtime source from the trigger author', async () => {
    request.mockResolvedValue([
      commentRecord({
        sender_type: 'agent',
        actor_user_id: '8',
        sender_id: 'private-agent',
        runtime_owner_user_id: '7',
        runtime_shared: false,
        trace_ref: 'trace',
        metadata: {
          private_prompt: 'not shared',
          execution_id: 99,
          workflow_task_title: 'Private task',
          runtime_address: { deviceId: 'private-device', taskId: 'private-task' },
        },
      }),
    ])
    const client = createLocalProjectChatClient(request, {
      currentUser: { id: 8, user_name: 'member' },
    })
    const subscription = await client.subscribe('p1', 't1', 0, vi.fn())
    expect(subscription.snapshot.messages[0]).toMatchObject({
      actorUserId: '8',
      runtimeAddress: undefined,
      traceState: 'restricted',
      metadata: {},
    })
    subscription.unsubscribe()
  })

  it('keeps the native local owner read model and execution classification', async () => {
    request.mockResolvedValue([
      commentRecord({
        sender_type: 'agent',
        actor_user_id: '0',
        runtime_owner_user_id: '0',
        sender_id: 'agent-1',
        message_type: 'agent_chunk',
        content: 'Owned execution output',
        trace_ref: 'trace',
        metadata: {
          member_assistant_result: { summary: 'Owned result' },
          runtime_address: { deviceId: 'local-device', taskId: 'local-task' },
        },
      }),
    ])
    const client = createLocalProjectChatClient(request, {
      currentUser: { id: 7, user_name: 'cloud owner' },
      viewerUserIds: [0, 7],
    })
    const subscription = await client.subscribe('p1', 't1', 0, vi.fn())
    expect(subscription.snapshot.messages[0]).toMatchObject({
      type: 'agent_chunk',
      content: 'Owned execution output',
      runtimeAddress: { deviceId: 'local-device', taskId: 'local-task' },
      traceState: 'available',
      metadata: { member_assistant_result: { summary: 'Owned result' } },
    })
    subscription.unsubscribe()
  })

  it('fails closed when a local agent message has no resolved actor', async () => {
    request.mockResolvedValue([
      commentRecord({
        sender_type: 'agent',
        sender_id: 'agent-1',
        content: 'Public result',
        metadata: {
          private_prompt: 'must remain private',
          runtime_address: { deviceId: 'private-device', taskId: 'private-task' },
        },
      }),
    ])
    const client = createLocalProjectChatClient(request, {
      currentUser: { id: 7, user_name: 'owner' },
    })
    const subscription = await client.subscribe('p1', 't1', 0, vi.fn())
    expect(subscription.snapshot.messages[0]).toMatchObject({
      content: 'Public result',
      metadata: {},
      runtimeAddress: undefined,
    })
    subscription.unsubscribe()
  })

  it('persists a continued turn on the existing runtime session', async () => {
    request.mockResolvedValue(
      commentRecord({
        message_id: 'agent-turn-2',
        sender_type: 'agent',
        actor_user_id: '0',
        runtime_owner_user_id: '0',
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

  it('keeps the composer code project on the saved comment', async () => {
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
    expect(request).not.toHaveBeenCalledWith('executions.enqueue', expect.anything())
  })

  it('forwards the assistant source claim for local store verification', async () => {
    request.mockResolvedValue(commentRecord())
    const client = createLocalProjectChatClient(request, {
      currentUser: { id: 0, user_name: 'local' },
    })

    await client.send({
      projectId: 'p1',
      taskId: 't1',
      clientMessageId: 'publication-1',
      text: 'Public conclusion',
      assistantSource: { deviceId: 'local-device', taskId: 'session-1' },
    })

    expect(request).toHaveBeenCalledWith(
      'todos.comment.create',
      expect.objectContaining({
        comment: expect.objectContaining({
          metadata: {
            mentions: [],
            assistant_source: { deviceId: 'local-device', taskId: 'session-1' },
          },
        }),
      })
    )
  })

  it('delivers initial comments and polls for status updates', async () => {
    vi.useFakeTimers()
    const streaming = commentRecord({
      id: 2,
      message_id: 'm-2',
      sender_type: 'agent',
      actor_user_id: '0',
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
  it('preserves queued activity and its persisted runtime task link', async () => {
    request.mockResolvedValue([
      commentRecord({
        sender_type: 'agent',
        actor_user_id: '0',
        runtime_owner_user_id: '0',
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
