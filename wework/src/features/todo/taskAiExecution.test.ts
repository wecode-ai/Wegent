import { describe, expect, it, vi } from 'vitest'
import type { ProjectChatClient, ProjectChatMessage } from '@/api/backend/projectChatSocket'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import {
  mergeProjectChatMessages,
  startTaskAiRun,
  type TaskAiRuntimeBridge,
} from './taskAiExecution'

const kimiModel = {
  name: 'wecode-moonshot-kimi-k2.7-code-highspeed(公网)',
  type: 'runtime',
  displayName: 'Kimi K2.7 高速（公网）',
  provider: 'wecode',
  config: {
    codexProviderId: 'wecode-moonshot',
    codexProviderName: 'wecode-moonshot',
    codexProviderType: 'openai',
    ui: { family: 'codex-provider' },
  },
}

const project = { id: '11', name: 'Wework' } as unknown as CloudProject
const task = {
  id: 'WEG-1',
  title: 'Implement feature',
  description: 'Build the flow',
} as unknown as CloudLoopItem

const agent = (model: string | null): ProjectChatAgent => ({
  id: 'agent-1',
  projectId: '11',
  name: 'Project AI',
  runtime: 'codex',
  model,
  systemPrompt: '',
  status: 'active',
  version: 1,
  createdAt: '',
  updatedAt: '',
})

const agentMessage: ProjectChatMessage = {
  sequenceNumber: 1,
  messageId: 'message-1',
  projectId: '11',
  taskId: 'WEG-1',
  sender: { type: 'agent', id: 'agent-1', name: 'Project AI' },
  type: 'agent_chunk',
  content: '',
  metadata: {},
  status: 'streaming',
  createdAt: '',
  updatedAt: '',
}

describe('project chat message ordering', () => {
  const live = {
    ...agentMessage,
    content: 'Live result',
    updatedAt: '2026-10-14T10:57:41.123456Z',
  }

  it('ignores older snapshots even when their timestamps use a different timezone', () => {
    const stale = { ...live, content: '', updatedAt: '2026-10-14T18:57:40+08:00' }
    expect(mergeProjectChatMessages([live], [stale])).toEqual([live])
  })

  it('preserves submillisecond update order', () => {
    const stale = { ...live, content: '', updatedAt: '2026-10-14T10:57:41.123455Z' }
    expect(mergeProjectChatMessages([live], [stale])).toEqual([live])
  })

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'keeps the %s result in both acknowledgement delivery orders',
    status => {
      const terminal = { ...live, status }
      const lateAck = {
        ...live,
        content: '',
        metadata: { run_status: 'running' },
        updatedAt: '2026-10-14T10:57:42Z',
      }
      expect(mergeProjectChatMessages([terminal], [lateAck])).toEqual([terminal])
      expect(mergeProjectChatMessages([lateAck], [terminal])).toEqual([terminal])
    }
  )

  it.each([live.updatedAt, '2026-10-14T10:57:42Z'])(
    'keeps streamed text when an empty acknowledgement requeues the active message at %s',
    updatedAt => {
      const queued = { ...live, content: '', status: 'pending' as const, updatedAt }
      expect(mergeProjectChatMessages([live], [queued])).toEqual([
        { ...queued, content: live.content },
      ])
    }
  )

  it('still ignores an older terminal snapshot after the terminal transition', () => {
    const completed = { ...live, status: 'completed' as const }
    const stale = {
      ...completed,
      content: 'Old result',
      updatedAt: '2026-10-14T10:57:40Z',
    }
    expect(mergeProjectChatMessages([completed], [stale])).toEqual([completed])
  })

  it('accepts a shorter nonempty streaming snapshot', () => {
    const replacement = { ...live, content: 'Live' }
    expect(mergeProjectChatMessages([live], [replacement])).toEqual([replacement])
  })

  it('accepts terminal content replacements including empty content', () => {
    for (const content of ['Final', '']) {
      const completed = { ...live, content, status: 'completed' as const }
      expect(mergeProjectChatMessages([live], [completed])).toEqual([completed])
    }
  })

  it('accepts new retry messages without changing the original terminal result', () => {
    const failed = { ...live, status: 'failed' as const }
    const retry = { ...agentMessage, messageId: 'retry-1', sequenceNumber: 2 }
    expect(mergeProjectChatMessages([failed], [retry])).toEqual([failed, retry])
  })

  it('does not prevent user message content updates', () => {
    const user = { ...live, sender: { type: 'user' as const, id: '1', name: 'Me' } }
    const edited = { ...user, content: '' }
    expect(mergeProjectChatMessages([user], [edited])).toEqual([edited])
  })
})

function createRuntime(): TaskAiRuntimeBridge {
  return {
    createProjectRuntimeTask: vi.fn(async (_prompt, options) => {
      const address = { deviceId: 'device-1', taskId: 'runtime-task-1' }
      await options.prepareRuntimeTask?.(address)
      await options.onRuntimeTaskOptimisticOpen?.(address)
      return address
    }),
    sendRuntimePaneMessage: vi.fn(async () => true),
  }
}

function createClient(): ProjectChatClient {
  return {
    subscribe: vi.fn(),
    send: vi.fn(),
    startAgentResponse: vi.fn(async () => agentMessage),
    failAgentResponse: vi.fn(),
    dispose: vi.fn(),
  }
}

async function run(input: Parameters<typeof startTaskAiRun>[0]) {
  const runtime = createRuntime()
  const client = createClient()
  const bindTask = vi.fn(async () => undefined)
  const unbindTask = vi.fn(async () => undefined)
  await startTaskAiRun({
    client,
    services: {
      deliveryApi: {
        bindTask,
        unbindTask,
        getLoopItem: vi.fn(async () => task),
      },
    },
    runtime,
    project,
    task,
    agent: input.agent,
    prompt: '请开始执行任务',
    messages: [],
    models: input.models,
    selectedModel: input.selectedModel,
    selectedModelOptions: input.selectedModelOptions,
    onError: vi.fn(),
    onMessages: vi.fn(),
    startFailedText: '启动失败',
  })
  return { runtime, client, bindTask }
}

async function runWith(
  input: Parameters<typeof startTaskAiRun>[0],
  overrides: {
    task?: CloudLoopItem
    continuationAccepted?: boolean
    continuationError?: string
    replyTo?: { runtimeDeviceId: string; runtimeTaskId: string } | null
    messages?: ProjectChatMessage[]
    threadRootId?: string | null
  } = {}
) {
  const taskUnderRun = overrides.task ?? task
  const runtime = {
    createProjectRuntimeTask: vi.fn(async (_prompt, options) => {
      const address = { deviceId: 'device-1', taskId: 'runtime-task-1' }
      await options.prepareRuntimeTask?.(address)
      await options.onRuntimeTaskOptimisticOpen?.(address)
      return address
    }),
    sendRuntimePaneMessage: vi.fn(async (_input, options) => {
      if (overrides.continuationError) {
        options?.onError?.(overrides.continuationError)
        return false
      }
      return overrides.continuationAccepted ?? true
    }),
  }
  const client = createClient()
  const bindTask = vi.fn(async () => undefined)
  const unbindTask = vi.fn(async () => undefined)
  await startTaskAiRun({
    client,
    services: {
      deliveryApi: {
        bindTask,
        unbindTask,
        getLoopItem: vi.fn(async () => taskUnderRun),
      },
    },
    runtime,
    project,
    task: taskUnderRun,
    agent: input.agent,
    prompt: '请开始执行任务',
    messages: overrides.messages ?? [],
    models: input.models,
    selectedModel: input.selectedModel,
    selectedModelOptions: input.selectedModelOptions,
    replyTo: overrides.replyTo,
    attachments: input.attachments,
    trigger: input.trigger,
    threadRootId: overrides.threadRootId,
    onError: vi.fn(),
    onMessages: vi.fn(),
    startFailedText: '启动失败',
  })
  return { runtime, client, bindTask }
}

describe('startTaskAiRun model resolution', () => {
  it('queues manual reruns through the same runner resolver as comments', async () => {
    const client = createClient()
    const comment: ProjectChatMessage = {
      ...agentMessage,
      messageId: 'rerun-comment',
      sender: { type: 'user', id: 'user-1', name: 'User' },
      type: 'text',
      content: 'Run the assigned Issue',
      status: 'completed',
    }
    vi.mocked(client.send).mockResolvedValue(comment)
    client.executeTaskComment = vi.fn(async () => [agentMessage])
    const runtime = createRuntime()
    const onMessages = vi.fn()
    const onError = vi.fn()
    const input = {
      client,
      runtime,
      services: {},
      project,
      task,
      agent: agent(null),
      prompt: comment.content,
      messages: [],
      onMessages,
      onError,
      startFailedText: '启动失败',
    }

    await expect(startTaskAiRun(input)).resolves.toBe(true)

    expect(client.send).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: task.id,
        mentions: [{ type: 'agent', id: 'agent-1', label: 'Project AI' }],
        replyToMessageId: null,
        model: null,
      })
    )
    expect(client.executeTaskComment).toHaveBeenCalledWith({
      projectId: project.id,
      taskId: task.id,
      triggerMessageId: comment.messageId,
      attachmentIds: [],
    })
    expect(runtime.createProjectRuntimeTask).not.toHaveBeenCalled()
    expect(client.startAgentResponse).not.toHaveBeenCalled()
    expect(onMessages).toHaveBeenLastCalledWith([agentMessage])
    expect(onError).not.toHaveBeenCalled()

    vi.mocked(client.executeTaskComment).mockRejectedValueOnce(new Error('Runner access revoked'))
    await expect(startTaskAiRun({ ...input, trigger: comment })).resolves.toBe(false)
    expect(client.send).toHaveBeenCalledTimes(1)
    expect(onError).toHaveBeenCalledWith('Runner access revoked')
    expect(runtime.createProjectRuntimeTask).not.toHaveBeenCalled()
  })

  it('materializes the assigned Team instead of dropping its model and shell defaults', async () => {
    const { runtime } = await run({
      agent: { ...agent(null), runtime: 'wegent', wegentTeamId: 1880 },
      models: [],
      selectedModel: null,
      selectedModelOptions: {},
    })

    expect(runtime.createProjectRuntimeTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        wegentTeamId: 1880,
        modelSelection: null,
        origin: expect.objectContaining({ dispatchRole: 'executor' }),
      })
    )
    expect(runtime.createProjectRuntimeTask.mock.calls[0]?.[1]).not.toHaveProperty('executionModel')
  })

  it('preserves an explicit per-run model override while materializing the assigned Team', async () => {
    const { runtime } = await run({
      agent: { ...agent(null), runtime: 'wegent', wegentTeamId: 1880 },
      models: [kimiModel],
      selectedModel: kimiModel,
      selectedModelOptions: {},
    })

    expect(runtime.createProjectRuntimeTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        wegentTeamId: 1880,
        modelSelection: expect.objectContaining({ modelName: kimiModel.name }),
      })
    )
  })
  it.each([false, true])(
    'seeds the user comment before execution (continuation=%s)',
    async continuation => {
      const attachment = {
        id: 7,
        filename: 'spec.txt',
        file_size: 12,
        mime_type: 'text/plain',
        status: 'ready' as const,
        file_extension: 'txt',
        created_at: '2026-09-16T00:00:00Z',
      }
      const { runtime } = await runWith(
        {
          agent: agent(null),
          attachments: [attachment],
          trigger: {
            ...agentMessage,
            messageId: 'trigger-1',
            sender: { type: 'user', id: '1', name: 'User' },
          },
        },
        {
          replyTo: continuation
            ? { runtimeDeviceId: 'device-1', runtimeTaskId: 'parent-session-1' }
            : null,
        }
      )
      const options = continuation
        ? runtime.sendRuntimePaneMessage.mock.calls[0][1]
        : runtime.createProjectRuntimeTask.mock.calls[0][1]
      expect(options.optimisticUserMessage).toMatchObject({
        id: continuation ? agentMessage.messageId : 'trigger-1',
        role: 'user',
        content: '请开始执行任务',
        attachments: [expect.objectContaining({ id: 7, filename: 'spec.txt' })],
      })
    }
  )

  it('passes the comment-selected model as full execution fields', async () => {
    const { runtime } = await run({
      agent: agent(null),
      models: [kimiModel],
      selectedModel: kimiModel,
      selectedModelOptions: {},
    })

    expect(runtime.createProjectRuntimeTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        executionModel: {
          modelId: kimiModel.name,
          modelType: 'runtime',
          modelOptions: expect.objectContaining({
            codexProviderId: 'wecode-moonshot',
            collaborationMode: 'default',
          }),
        },
      })
    )
  })

  it('does not infer a Runtime model from the robot record', async () => {
    const { runtime } = await run({
      agent: agent(kimiModel.name),
      models: [kimiModel],
      selectedModel: null,
      selectedModelOptions: {},
    })

    const options = runtime.createProjectRuntimeTask.mock.calls[0]?.[1]
    expect(options).not.toHaveProperty('executionModel')
    expect(options).not.toHaveProperty('modelSelection')
  })

  it('does not preserve a legacy raw model fallback', async () => {
    const { runtime } = await run({
      agent: agent('legacy-raw-model'),
      models: [],
      selectedModel: null,
      selectedModelOptions: {},
    })

    const options = runtime.createProjectRuntimeTask.mock.calls[0]?.[1]
    expect(options).not.toHaveProperty('executionModel')
    expect(options).not.toHaveProperty('modelSelection')
  })

  it('does not override the model when neither a comment nor a project model is configured', async () => {
    const { runtime } = await run({
      agent: agent(null),
      models: [],
      selectedModel: null,
      selectedModelOptions: {},
    })

    const options = runtime.createProjectRuntimeTask.mock.calls[0][1] as Record<string, unknown>
    expect(options.executionModel).toBeUndefined()
    expect(options.modelSelection).toBeUndefined()
    expect(options.modelId).toBeUndefined()
  })

  it('continues the replied AI message session when replyTo is provided', async () => {
    const { runtime, client, bindTask } = await runWith(
      { agent: agent(null), models: [], selectedModel: null, selectedModelOptions: {} },
      { replyTo: { runtimeDeviceId: 'device-1', runtimeTaskId: 'parent-session-1' } }
    )

    const sendArgs = runtime.sendRuntimePaneMessage.mock.calls[0][0] as Record<string, unknown>
    expect(sendArgs).toMatchObject({
      address: { deviceId: 'device-1', taskId: 'parent-session-1' },
      message: '请开始执行任务',
    })
    expect(runtime.createProjectRuntimeTask).not.toHaveBeenCalled()
    expect(bindTask).not.toHaveBeenCalled()
    expect(client.startAgentResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        triggerMessageId: undefined,
        agentId: 'agent-1',
        runtimeDeviceId: 'device-1',
        runtimeTaskId: 'parent-session-1',
      })
    )
  })

  it('starts a fresh persistent run for a new comment even when the task has a previous binding', async () => {
    const previouslyBoundTask = {
      ...task,
      ai_state: {
        status: 'completed',
        runtime_device_id: 'device-1',
        runtime_task_id: 'old-session-1',
      },
    } as unknown as CloudLoopItem
    const { runtime, client, bindTask } = await runWith(
      { agent: agent(null), models: [], selectedModel: null, selectedModelOptions: {} },
      { task: previouslyBoundTask }
    )

    expect(runtime.createProjectRuntimeTask).toHaveBeenCalledWith(
      '请开始执行任务',
      expect.objectContaining({
        cloudProjectId: '11',
        origin: {
          type: 'board_comment',
          dispatchRole: 'executor',
          cloudProjectId: '11',
          loopItemId: 'WEG-1',
        },
      })
    )
    expect(bindTask).toHaveBeenCalledWith(
      'WEG-1',
      { deviceId: 'device-1', taskId: 'runtime-task-1' },
      'Implement feature'
    )
    expect(client.startAgentResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeDeviceId: 'device-1',
        runtimeTaskId: 'runtime-task-1',
      })
    )
  })

  it('falls back to a fresh persistent run when the replied session cannot be resumed', async () => {
    const { runtime, client } = await runWith(
      { agent: agent(null), models: [], selectedModel: null, selectedModelOptions: {} },
      {
        replyTo: { runtimeDeviceId: 'device-1', runtimeTaskId: 'parent-session-1' },
        continuationError: 'runtime thread not found',
      }
    )

    expect(runtime.createProjectRuntimeTask).toHaveBeenCalledWith(
      '请开始执行任务',
      expect.objectContaining({
        cloudProjectId: '11',
        origin: expect.objectContaining({
          type: 'board_comment',
          loopItemId: 'WEG-1',
        }),
      })
    )
    expect(runtime.createProjectRuntimeTask.mock.calls[0][1]).not.toHaveProperty(
      'hiddenFromSidebar'
    )
    expect(runtime.createProjectRuntimeTask.mock.calls[0][1]).not.toHaveProperty('ephemeral')
    expect(client.startAgentResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeDeviceId: 'device-1',
        runtimeTaskId: 'runtime-task-1',
      })
    )
  })

  it('does not start a second run when continuation acknowledgement is ambiguous', async () => {
    const { runtime, client } = await runWith(
      { agent: agent(null), models: [], selectedModel: null, selectedModelOptions: {} },
      {
        replyTo: { runtimeDeviceId: 'device-1', runtimeTaskId: 'parent-session-1' },
        continuationAccepted: false,
      }
    )

    expect(runtime.sendRuntimePaneMessage).toHaveBeenCalledOnce()
    expect(runtime.createProjectRuntimeTask).not.toHaveBeenCalled()
    expect(client.failAgentResponse).toHaveBeenCalledWith(
      expect.objectContaining({ error: '启动失败' })
    )
  })

  it('does not start a second run when the bound turn is still running', async () => {
    const { runtime, client } = await runWith(
      { agent: agent(null), models: [], selectedModel: null, selectedModelOptions: {} },
      {
        replyTo: { runtimeDeviceId: 'device-1', runtimeTaskId: 'parent-session-1' },
        continuationError: 'runtime task is already running',
      }
    )

    expect(runtime.sendRuntimePaneMessage).toHaveBeenCalledOnce()
    expect(runtime.createProjectRuntimeTask).not.toHaveBeenCalled()
    expect(client.startAgentResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeDeviceId: 'device-1',
        runtimeTaskId: 'parent-session-1',
      })
    )
    expect(client.failAgentResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        messageId: agentMessage.messageId,
        error: 'runtime task is already running',
      })
    )
  })

  it('scopes rebuilt-session history to the owning comment thread', async () => {
    const ownRoot: ProjectChatMessage = {
      ...agentMessage,
      sequenceNumber: 1,
      messageId: 'thread-1',
      sender: { type: 'user', id: 'user-1', name: 'Ada' },
      type: 'text',
      content: '本线程的评论',
      status: 'completed',
    }
    const otherRoot: ProjectChatMessage = {
      ...agentMessage,
      sequenceNumber: 2,
      messageId: 'thread-2',
      sender: { type: 'user', id: 'user-2', name: 'Bob' },
      type: 'text',
      content: '别人的评论',
      status: 'completed',
    }
    const { runtime } = await runWith(
      { agent: agent(null), models: [], selectedModel: null, selectedModelOptions: {} },
      {
        replyTo: { runtimeDeviceId: 'device-1', runtimeTaskId: 'parent-session-1' },
        continuationError: 'runtime thread not found',
        messages: [ownRoot, otherRoot],
        threadRootId: 'thread-1',
      }
    )

    const options = runtime.createProjectRuntimeTask.mock.calls[0][1] as {
      additionalContext: { projectChatHistory: { value: string } }
    }
    const history = options.additionalContext.projectChatHistory.value
    expect(history).toContain('本线程的评论')
    expect(history).not.toContain('别人的评论')
  })
})
