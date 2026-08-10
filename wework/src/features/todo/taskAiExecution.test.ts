import { describe, expect, it, vi } from 'vitest'
import type { ProjectChatClient, ProjectChatMessage } from '@/api/backend/projectChatSocket'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import { startTaskAiRun, type TaskAiRuntimeBridge } from './taskAiExecution'

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

function createRuntime(): TaskAiRuntimeBridge {
  return {
    createProjectRuntimeTask: vi.fn(async (_prompt, options) => {
      const address = { deviceId: 'device-1', taskId: 'runtime-task-1' }
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
  await startTaskAiRun({
    client,
    services: {
      deliveryApi: {
        bindTask,
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
  await startTaskAiRun({
    client,
    services: {
      deliveryApi: {
        bindTask,
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
    threadRootId: overrides.threadRootId,
    onError: vi.fn(),
    onMessages: vi.fn(),
    startFailedText: '启动失败',
  })
  return { runtime, client, bindTask }
}

describe('startTaskAiRun model resolution', () => {
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

  it('resolves the project AI configured model against the shared model list', async () => {
    const { runtime } = await run({
      agent: agent(kimiModel.name),
      models: [kimiModel],
      selectedModel: null,
      selectedModelOptions: {},
    })

    expect(runtime.createProjectRuntimeTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        executionModel: expect.objectContaining({
          modelId: kimiModel.name,
          modelOptions: expect.objectContaining({ codexProviderId: 'wecode-moonshot' }),
        }),
      })
    )
  })

  it('keeps a raw name override when the configured model is not in the list', async () => {
    const { runtime } = await run({
      agent: agent('legacy-raw-model'),
      models: [],
      selectedModel: null,
      selectedModelOptions: {},
    })

    expect(runtime.createProjectRuntimeTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        executionModel: {
          modelId: 'legacy-raw-model',
          modelType: null,
          modelOptions: {},
        },
      })
    )
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
    // The session already carries its environment and thread context, so a
    // reply only sends the message text.
    expect(sendArgs).not.toHaveProperty('additionalContext')
    expect(runtime.sendRuntimePaneMessage).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ onError: expect.any(Function) })
    )
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

  it('starts a fresh hidden run for a new comment even when the task has a previous binding', async () => {
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

    expect(runtime.sendRuntimePaneMessage).not.toHaveBeenCalled()
    expect(runtime.createProjectRuntimeTask).toHaveBeenCalledWith(
      '请开始执行任务',
      expect.objectContaining({
        cloudProjectId: '11',
        hiddenFromSidebar: true,
        continuable: true,
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

  it('falls back to a fresh hidden run when the replied session cannot be resumed', async () => {
    const { runtime, client } = await runWith(
      { agent: agent(null), models: [], selectedModel: null, selectedModelOptions: {} },
      {
        replyTo: { runtimeDeviceId: 'device-1', runtimeTaskId: 'parent-session-1' },
        continuationAccepted: false,
      }
    )

    expect(runtime.createProjectRuntimeTask).toHaveBeenCalledWith(
      '请开始执行任务',
      expect.objectContaining({
        cloudProjectId: '11',
        hiddenFromSidebar: true,
        continuable: true,
      })
    )
    expect(client.startAgentResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeDeviceId: 'device-1',
        runtimeTaskId: 'runtime-task-1',
      })
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
    expect(client.startAgentResponse).not.toHaveBeenCalled()
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
        continuationAccepted: false,
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
