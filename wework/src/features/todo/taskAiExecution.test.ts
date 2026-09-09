import { describe, expect, it, vi } from 'vitest'
import type { ProjectChatClient, ProjectChatMessage } from '@/api/backend/projectChatSocket'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
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

async function run(
  input: Pick<Parameters<typeof startTaskAiRun>[0], 'selectedModel' | 'selectedModelOptions'>
) {
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
    prompt: '请开始执行任务',
    selectedModel: input.selectedModel,
    selectedModelOptions: input.selectedModelOptions,
    onError: vi.fn(),
    onMessages: vi.fn(),
    startFailedText: '启动失败',
  })
  return { runtime, client, bindTask }
}

async function runWith(
  input: Pick<Parameters<typeof startTaskAiRun>[0], 'selectedModel' | 'selectedModelOptions'>,
  overrides: {
    task?: CloudLoopItem
    continuationAccepted?: boolean
    continuationError?: string
    replyTo?: { runtimeDeviceId: string; runtimeTaskId: string } | null
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
    prompt: '请开始执行任务',
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

  it('does not override the model when neither a comment nor a project model is configured', async () => {
    const { runtime } = await run({
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
      { selectedModel: null, selectedModelOptions: {} },
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
      { selectedModel: null, selectedModelOptions: {} },
      { task: previouslyBoundTask }
    )

    expect(runtime.createProjectRuntimeTask).toHaveBeenCalledWith(
      '请开始执行任务',
      expect.objectContaining({
        cloudProjectId: '11',
        origin: {
          type: 'board_comment',
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

  it('reports an unavailable original session without creating another task', async () => {
    const { runtime, client } = await runWith(
      { selectedModel: null, selectedModelOptions: {} },
      {
        replyTo: { runtimeDeviceId: 'device-1', runtimeTaskId: 'parent-session-1' },
        continuationError: 'runtime thread not found',
      }
    )
    expect(runtime.createProjectRuntimeTask).not.toHaveBeenCalled()
    expect(client.failAgentResponse).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'runtime thread not found' })
    )
  })

  it('does not start a second run when continuation acknowledgement is ambiguous', async () => {
    const { runtime, client } = await runWith(
      { selectedModel: null, selectedModelOptions: {} },
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
      { selectedModel: null, selectedModelOptions: {} },
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

  it('binds a new activity to a completed Issue without binding the completed stage', async () => {
    const completedIssue = {
      ...task,
      status: 'completed',
      workflow: {
        current_stage_id: null,
        nodes: [],
        execution_config: {
          agent_id: null,
          runtime_profile_id: null,
          execution_device_id: 'configured-device',
          model: 'workflow-model',
          model_type: 'runtime',
          model_options: {},
          workspace_binding: { type: 'standalone' },
        },
      },
    } as unknown as CloudLoopItem
    const { runtime, bindTask } = await runWith({ selectedModel: null }, { task: completedIssue })
    expect(runtime.createProjectRuntimeTask).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        runtime: 'codex',
        taskRequest: expect.objectContaining({
          modelId: 'workflow-model',
          deviceId: 'configured-device',
        }),
      })
    )
    expect(bindTask).toHaveBeenCalledWith(
      task.id,
      { deviceId: 'device-1', taskId: 'runtime-task-1' },
      task.title
    )
  })

  it('rejects a reply without its original runtime address', async () => {
    const { runtime, client } = await runWith(
      { selectedModel: null },
      { threadRootId: 'old-thread', replyTo: null }
    )
    expect(runtime.createProjectRuntimeTask).not.toHaveBeenCalled()
    expect(runtime.sendRuntimePaneMessage).not.toHaveBeenCalled()
    expect(client.startAgentResponse).not.toHaveBeenCalled()
  })
})
