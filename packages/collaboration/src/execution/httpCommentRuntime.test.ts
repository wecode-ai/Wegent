import { describe, expect, it, vi } from 'vitest'
import { createRuntimeConversationApi } from '@wegent/chat-core/runtime-conversation-api'
import type { ProjectChatClient, ProjectChatMessage } from '@wegent/chat-core'
import { createHttpCommentRuntime } from './httpCommentRuntime'
import { startTaskAiRun } from './taskAiExecution'

const target = { deviceId: 'device-1', runtime: 'codex', workspacePath: '/project' }
const project = {
  id: 'project-1',
  name: 'Project',
  project_key: 'P',
  project_store: 'backend' as const,
  task_provider: 'local',
  provider_config: {},
}
const task = { id: 'issue-1', title: 'Check pwd', status: 'in_progress' }
const model = {
  name: 'cloud-model',
  type: 'user' as const,
  provider: 'cloud',
  namespace: 'engineering',
  resourceUserId: 7,
  displayName: 'Cloud model',
  config: { protocol: 'openai-responses' },
}
const response = {
  messageId: 'agent-response',
  projectId: project.id,
  taskId: task.id,
} as ProjectChatMessage

function setup() {
  const order: string[] = []
  const post = vi.fn(async (_path: string, input: unknown) => {
    const request = input as { deviceId: string; taskId: string }
    order.push('dispatch')
    return { accepted: true, ...request, workspacePath: '/project' }
  })
  const work = createRuntimeConversationApi({ get: vi.fn(), post: post as never })
  const runtime = createHttpCommentRuntime(work, target)
  const client = {
    startAgentResponse: vi.fn(async () => {
      order.push('response')
      return response
    }),
    failAgentResponse: vi.fn().mockResolvedValue(response),
  } as unknown as ProjectChatClient
  const unbindTask = vi.fn(async () => {
    order.push('unbind')
  })
  const stop = vi.fn()
  const onError = vi.fn()
  const subscribe = vi.fn(async () => {
    order.push('subscribe')
    return stop
  })
  const input = {
    client,
    runtime,
    project,
    task,
    agent: { id: 'agent-1', name: 'Engineer', systemPrompt: 'Check the repository' },
    services: {
      deliveryApi: {
        bindTask: vi.fn(async () => {
          order.push('bind')
        }),
        unbindTask,
        getLoopItem: vi.fn(async () => task),
      },
      chatStream: { subscribe },
    },
    trigger: { messageId: 'root-comment' } as ProjectChatMessage,
    prompt: 'Run pwd',
    messages: [],
    selectedModel: model,
    selectedModelOptions: { permissionMode: 'full-access', reasoningEffort: 'high' },
    onError,
    onMessages: vi.fn(),
    startFailedText: 'Start failed',
  }
  return { input, post, order, stop, subscribe, unbindTask, onError }
}

describe('shared comment execution using the real HTTP adapter', () => {
  it('creates a new bound session after the durable activity and event subscription exist', async () => {
    const { input, post, order } = setup()
    expect(await startTaskAiRun(input)).toBe(true)
    expect(order).toEqual(['bind', 'response', 'subscribe', 'dispatch'])
    expect(post).toHaveBeenCalledWith(
      '/runtime-work/create',
      expect.objectContaining({
        schemaVersion: 2,
        deviceId: target.deviceId,
        taskId: expect.stringMatching(/^runtime-/),
        workspacePath: '/project',
        message: 'Run pwd',
        modelSelection: {
          modelName: model.name,
          modelType: 'user',
          options: expect.objectContaining({
            permissionMode: 'full-access',
            reasoningEffort: 'high',
            weworkCloudModelNamespace: 'engineering',
            weworkCloudModelResourceUserId: '7',
          }),
        },
        origin: {
          type: 'board_comment',
          projectStore: 'backend',
          cloudProjectId: project.id,
          loopItemId: task.id,
          rootCommentId: 'root-comment',
        },
      })
    )
    const sent = post.mock.calls[0][1] as { taskId: string }
    expect(input.client.startAgentResponse).toHaveBeenCalledWith(
      expect.objectContaining({
        runtimeDeviceId: target.deviceId,
        runtimeTaskId: sent.taskId,
        triggerMessageId: 'root-comment',
      })
    )
  })
  it('rolls back a rejected create and closes the activity with the actual error', async () => {
    const { input, post, unbindTask, stop } = setup()
    post.mockResolvedValueOnce({ accepted: false, error: 'Device offline' } as never)
    expect(await startTaskAiRun(input)).toBe(false)
    expect(unbindTask).toHaveBeenCalledOnce()
    expect(stop).toHaveBeenCalledOnce()
    expect(input.client.failAgentResponse).toHaveBeenCalledWith(
      expect.objectContaining({ error: 'Device offline' })
    )
  })
  it('retains a binding after an ambiguous transport failure so a possibly started run remains inspectable', async () => {
    const { input, post, unbindTask } = setup()
    post.mockRejectedValueOnce(new Error('Gateway timeout'))
    expect(await startTaskAiRun(input)).toBe(false)
    expect(unbindTask).not.toHaveBeenCalled()
    expect(input.onError).toHaveBeenLastCalledWith('Gateway timeout')
    expect(post).toHaveBeenCalledOnce()
  })
  it('does not dispatch when a durable response cannot be established and undoes its binding', async () => {
    const { input, post, unbindTask } = setup()
    vi.mocked(input.client.startAgentResponse).mockRejectedValue(new Error('Activity unavailable'))
    expect(await startTaskAiRun(input)).toBe(false)
    expect(post).not.toHaveBeenCalled()
    expect(unbindTask).toHaveBeenCalledOnce()
    expect(input.onError).toHaveBeenLastCalledWith('Activity unavailable')
  })
  it('closes a continuation response when subscribing fails without sending or creating a task', async () => {
    const { input, post, subscribe } = setup()
    subscribe.mockRejectedValueOnce(new Error('Subscription unavailable'))
    expect(
      await startTaskAiRun({
        ...input,
        replyTo: { runtimeDeviceId: 'device-1', runtimeTaskId: 'existing-task' },
      })
    ).toBe(false)
    expect(post).not.toHaveBeenCalled()
    expect(input.services.deliveryApi.bindTask).not.toHaveBeenCalled()
    expect(input.client.failAgentResponse).toHaveBeenCalledWith(
      expect.objectContaining({ messageId: response.messageId, error: 'Subscription unavailable' })
    )
    expect(input.onError).toHaveBeenLastCalledWith('Subscription unavailable')
  })
  it('splits real uploaded attachments from local references before starting execution', async () => {
    const { input, post } = setup()
    const file = {
      id: 14,
      filename: 'notes.txt',
      file_size: 5,
      file_extension: 'txt',
      mime_type: 'text/plain',
      status: 'ready' as const,
      created_at: '',
    }
    expect(
      await startTaskAiRun({
        ...input,
        attachments: [
          file,
          { ...file, id: -1, local_path: '/project/local.txt', text_content: 'local' },
        ],
      })
    ).toBe(true)
    expect(post).toHaveBeenCalledWith(
      '/runtime-work/create',
      expect.objectContaining({
        attachmentIds: [14],
        attachments: [expect.objectContaining({ id: -1, local_path: '/project/local.txt' })],
      })
    )
    const sent = post.mock.calls[0][1] as { attachments: unknown[] }
    expect(sent.attachments[0]).not.toHaveProperty('text_content')
  })
})
