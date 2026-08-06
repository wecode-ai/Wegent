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
  await startTaskAiRun({
    client,
    services: {
      deliveryApi: {
        bindTask: vi.fn(async () => undefined),
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
  return { runtime, client }
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
})
