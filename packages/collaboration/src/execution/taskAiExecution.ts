import type { ProjectChatClient, ProjectChatMessage } from '@wegent/chat-core'
import type { Attachment, RuntimeTaskAddress } from '@wegent/chat-core/runtime'
import type { ModelOptions, UnifiedModel } from '@wegent/chat-core/models'
import type {
  RuntimeAdditionalContext,
  RuntimeSendRequest,
  RuntimeTaskOrigin,
} from '@wegent/chat-core/runtime-task-api-types'
import type {
  ModelSelectionConfig,
  ChatStreamHandlers,
} from '@wegent/chat-core/runtime-stream-types'
import type { WorkbenchMessage } from '@wegent/chat-core/runtime-conversation'
import { localRuntimeAttachments, remoteAttachmentIds } from '@wegent/chat-core/runtime-attachments'
import {
  projectSpaceChatRuntimeContext,
  type ProjectSpaceContext,
} from '@wegent/chat-core/project-space-context'
import { createRuntimeUserMessage } from './runtimeUserMessage'
import { selectedModelExecutionFields } from '../controls/runtimeModelSelection'

export interface CommentExecutionTask {
  id: string
  title: string
  description?: string | null
  status: string
}
export interface CommentRuntimeCreateOptions<ExecutionProject> {
  project?: ExecutionProject | null
  optimisticUserMessage?: WorkbenchMessage & { role: 'user' }
  executionModel?: Pick<RuntimeSendRequest, 'modelId' | 'modelType' | 'modelOptions'>
  modelSelection?: Required<ModelSelectionConfig>
  collaborationMode?: 'default' | 'plan'
  cloudProjectId?: string
  origin?: RuntimeTaskOrigin
  deviceId?: string
  attachments?: Attachment[]
  additionalContext?: RuntimeAdditionalContext
  prepareRuntimeTask?(address: RuntimeTaskAddress): Promise<() => Promise<void>>
  onRuntimeTaskOptimisticOpen?(address: RuntimeTaskAddress): Promise<void>
  onError?(error: string): void
}
export interface TaskAiRuntimeBridge<ExecutionProject> {
  createProjectRuntimeTask(
    prompt: string,
    options: CommentRuntimeCreateOptions<ExecutionProject>
  ): Promise<RuntimeTaskAddress | false>
  sendRuntimePaneMessage(
    input: RuntimeSendRequest,
    options?: {
      optimisticUserMessage?: WorkbenchMessage & { role: 'user' }
      onError?(error: string): void
    }
  ): Promise<boolean>
}
export interface CommentExecutionServices<Task extends CommentExecutionTask> {
  deliveryApi?: {
    bindTask(taskId: string, address: RuntimeTaskAddress, title: string): Promise<void>
    unbindTask(taskId: string, address: RuntimeTaskAddress): Promise<void>
    getLoopItem(taskId: string): Promise<Task>
  }
  chatStream?: { subscribe(handlers: ChatStreamHandlers): (() => void) | Promise<() => void> }
}
export interface StartTaskAiRunInput<ExecutionProject, Task extends CommentExecutionTask> {
  client: ProjectChatClient
  services: CommentExecutionServices<Task>
  runtime: TaskAiRuntimeBridge<ExecutionProject>
  project: ProjectSpaceContext
  task: Task
  agent: { id: string; name: string; systemPrompt?: string }
  executionProject?: ExecutionProject | null
  prompt: string
  trigger?: ProjectChatMessage
  autoRetry?: boolean
  messages: ProjectChatMessage[]
  models?: UnifiedModel[]
  selectedModel?: UnifiedModel | null
  selectedModelOptions?: ModelOptions
  replyTo?: { runtimeDeviceId: string; runtimeTaskId: string } | null
  threadRootId?: string | null
  deviceId?: string | null
  attachments?: Attachment[]
  onError(error: string): void
  onMessages(messages: ProjectChatMessage[]): void
  onTaskUpdated?(task: Task): void
  onBindingChange?(change: {
    task: RuntimeTaskAddress
    project: { projectId: string; projectStore: 'local' | 'backend' }
    type: 'bound' | 'unbound'
  }): void
  startFailedText: string
}

function sessionDefinitelyUnavailable(error: string | null): boolean {
  if (!error) return false
  return /(?:thread|task|session).*(?:not found|不存在|已删除|不可用)|(?:not found|不存在).*(?:thread|task|session)/i.test(
    error
  )
}

export function buildRobotRoleDescription(agent: { name: string; systemPrompt?: string }): string {
  // The task title/description is read by the AI itself (injected context and
  // wework_space get_board_item); the sent content is the robot role only.
  return agent.systemPrompt
    ? `你是 ${agent.name}，这个项目任务的 AI 执行者。\n${agent.systemPrompt}`
    : `你是 ${agent.name}，这个项目任务的 AI 执行者。`
}

export function selectActivityRerunModel(messages: ProjectChatMessage[], models: UnifiedModel[]) {
  const modelName = messages
    .filter(message => message.sender.type === 'user' && typeof message.metadata.model === 'string')
    .at(-1)?.metadata.model
  return typeof modelName === 'string'
    ? (models.find(model => model.name === modelName) ?? null)
    : null
}

export function formatThreadHistory(
  threadRootId: string,
  current: ProjectChatMessage[],
  trigger?: ProjectChatMessage
): string {
  const thread = mergeProjectChatMessages(current, trigger ? [trigger] : []).filter(
    message =>
      message.status === 'completed' &&
      message.content.trim() &&
      (message.rootMessageId === threadRootId || message.messageId === threadRootId)
  )
  const lines = thread.slice(-40).map(message => {
    const role = message.sender.type === 'agent' ? `AI ${message.sender.name}` : message.sender.name
    return `[${role}] ${message.content.trim()}`
  })
  return [
    '<project_chat_thread>',
    lines.join('\n').slice(-20_000),
    '</project_chat_thread>',
    'This is the comment thread that owns this session. Do not reference other comments.',
  ].join('\n')
}

export function mergeProjectChatMessages(
  current: ProjectChatMessage[],
  incoming: ProjectChatMessage[]
): ProjectChatMessage[] {
  const byId = new Map(current.map(message => [message.messageId, message]))
  for (const message of incoming) {
    const previous = byId.get(message.messageId)
    byId.set(message.messageId, previous ? { ...previous, ...message } : message)
  }
  return Array.from(byId.values()).sort((left, right) => left.sequenceNumber - right.sequenceNumber)
}

export async function startTaskAiRun<ExecutionProject, Task extends CommentExecutionTask>({
  client,
  services,
  runtime,
  project,
  task,
  agent,
  executionProject,
  prompt,
  trigger,
  autoRetry,
  messages,
  selectedModel,
  selectedModelOptions,
  replyTo,
  threadRootId,
  deviceId,
  attachments,
  onError,
  onMessages,
  onTaskUpdated,
  startFailedText,
  onBindingChange,
}: StartTaskAiRunInput<ExecutionProject, Task>): Promise<boolean> {
  const responseRef: { current: ProjectChatMessage | null } = { current: null }
  // The executor can fail a turn asynchronously (lost thread, no model
  // progress). The backend event relay is not guaranteed to close the
  // streaming comment, so surface the failure from the sender's own runtime
  // stream: fail the comment and raise the error instead of leaving the reply
  // stuck at "正在处理" with no feedback.
  const watchRuntimeFailure = async (
    deviceId: string,
    runtimeTaskId: string
  ): Promise<() => void> => {
    if (!services.chatStream?.subscribe) return () => undefined
    let finished = false
    let unsubscribe = () => undefined as void
    const cleanup = await services.chatStream.subscribe({
      scope: { deviceId, taskId: runtimeTaskId },
      onChatError: payload => {
        if (finished || payload.taskId !== runtimeTaskId) return
        finished = true
        unsubscribe()
        const message = responseRef.current
        if (message) {
          void client
            .failAgentResponse({
              projectId: project.id,
              taskId: task.id,
              messageId: message.messageId,
              error: payload.error,
            })
            .catch(cause => onError(cause instanceof Error ? cause.message : startFailedText))
        }
        onError(payload.error)
      },
      onChatDone: payload => {
        if (finished || payload.taskId !== runtimeTaskId) return
        finished = true
        unsubscribe()
      },
    })
    unsubscribe = cleanup
    if (finished) cleanup()
    return () => {
      finished = true
      cleanup()
    }
  }
  let stopWatching = () => undefined as void
  let executionError: string | null = null
  const executionModel = selectedModel
    ? selectedModelExecutionFields(selectedModel, selectedModelOptions ?? {})
    : null
  const modelSelection = selectedModel
    ? {
        modelName: selectedModel.name,
        modelType: selectedModel.type,
        options: executionModel?.modelOptions ?? {},
      }
    : null
  const usedModel = executionModel?.modelId
  const additionalContext: RuntimeAdditionalContext = {
    ...projectSpaceChatRuntimeContext(project),
    projectChatTask: {
      kind: 'application',
      value: [
        '<current_task>',
        JSON.stringify({
          id: String(task.id),
          title: task.title,
          description: task.description ?? '',
          status: task.status,
        }),
        '</current_task>',
        'This run is bound to this task in the current project space.',
      ].join('\n'),
    },
    projectChat: {
      kind: 'application',
      value: [
        trigger
          ? `This run was started by task activity ${trigger.messageId}.`
          : 'This run was started by assigning this task to the project AI.',
        `Reply to task cloud://projects/${project.id}/todos/${task.id}.`,
        'Read the task with the wework_space get_board_item tool before executing; the task link already contains the space_id and item_id, so do not call list_spaces to find the project.',
        'Your final response is a reviewable task comment. Report actual changes, verification, unfinished work, and risks.',
      ].join('\n'),
    },
    projectChatAgent: {
      kind: 'application',
      value: buildRobotRoleDescription(agent),
    },
  }

  if (replyTo?.runtimeDeviceId && replyTo?.runtimeTaskId) {
    // Replying to an AI message continues the executor session of its parent
    // comment (each parent comment owns one session). The environment and
    // thread context were bound when the session was created, so only the
    // reply text is sent here.
    let continuationRejectedReason: string | null = null
    const continuationAttachmentIds = remoteAttachmentIds(attachments ?? [])
    const continuationAttachments = localRuntimeAttachments(attachments ?? [])
    // Open the activity before the executor can emit events. An instant
    // terminal failure (for example the bound session was destroyed and the
    // turn fails with "thread not found") must find a streaming message to
    // close; otherwise the reply is left "processing" forever because the
    // failure event races ahead of the comment row.
    let pendingMessage: ProjectChatMessage | null = null
    try {
      pendingMessage = await startTaskAiResponse(client, {
        projectId: project.id,
        taskId: task.id,
        triggerMessageId: trigger?.messageId,
        agentId: agent.id,
        runtimeDeviceId: replyTo.runtimeDeviceId,
        runtimeTaskId: replyTo.runtimeTaskId,
        prompt,
        autoRetry,
        model: usedModel,
      })
    } catch (cause) {
      // Without an activity row the terminal event would be dropped; surface
      // the failure instead of sending into an un-tracked session.
      onError(cause instanceof Error ? cause.message : startFailedText)
      return false
    }
    responseRef.current = pendingMessage
    const closePendingMessage = async (error: string) => {
      if (!pendingMessage) return
      try {
        await client.failAgentResponse({
          projectId: project.id,
          taskId: task.id,
          messageId: pendingMessage.messageId,
          error,
        })
      } catch (cause) {
        onError(cause instanceof Error ? cause.message : startFailedText)
      }
    }
    let continued = false
    try {
      stopWatching = await watchRuntimeFailure(replyTo.runtimeDeviceId, replyTo.runtimeTaskId)
      continued = await runtime.sendRuntimePaneMessage(
        {
          address: {
            deviceId: replyTo.runtimeDeviceId,
            taskId: replyTo.runtimeTaskId,
          },
          message: prompt,
          ...(executionModel
            ? {
                ...(executionModel.modelId ? { modelId: executionModel.modelId } : {}),
                modelType: executionModel.modelType ?? null,
                modelOptions: executionModel.modelOptions ?? {},
              }
            : {}),
          ...(modelSelection ? { modelSelection } : {}),
          collaborationMode: 'default',
          ...(continuationAttachmentIds.length > 0
            ? { attachmentIds: continuationAttachmentIds }
            : {}),
          ...(continuationAttachments.length > 0 ? { attachments: continuationAttachments } : {}),
        },
        {
          optimisticUserMessage: createRuntimeUserMessage(prompt, attachments, {
            id: pendingMessage.messageId,
          }),
          onError: error => {
            continuationRejectedReason = error
          },
        }
      )
    } catch (cause) {
      continuationRejectedReason = cause instanceof Error ? cause.message : startFailedText
    }
    if (continued) {
      onMessages(responseRef.current ? [responseRef.current] : [])
      await refreshTask(services, task.id, onTaskUpdated)
      return true
    }
    stopWatching()
    if (continuationRejectedReason && /running|执行中/i.test(continuationRejectedReason)) {
      // The bound turn is still active; starting a fresh run would double
      // execute the same reply.
      await closePendingMessage(continuationRejectedReason)
      onError(continuationRejectedReason)
      return false
    }
    const rejection = continuationRejectedReason ?? startFailedText
    await closePendingMessage(rejection)
    if (!sessionDefinitelyUnavailable(continuationRejectedReason)) {
      // A transport failure is ambiguous: the executor may have accepted the
      // turn before the acknowledgement was lost. Starting another session
      // here could execute the same comment twice. Rebuild only when the
      // runtime explicitly confirms that the old session no longer exists.
      onError(rejection)
      return false
    }
    // Fall through silently: the bound session is gone or its device is
    // unavailable, so start a fresh persistent run for this new floor below.
  }

  const address = await runtime.createProjectRuntimeTask(prompt, {
    optimisticUserMessage: createRuntimeUserMessage(prompt, attachments, {
      id: trigger?.messageId,
    }),
    project: executionProject ?? null,
    ...(executionModel ? { executionModel } : {}),
    ...(modelSelection ? { modelSelection } : {}),
    collaborationMode: 'default',
    cloudProjectId: String(project.id),
    origin: {
      type: 'board_comment',
      cloudProjectId: String(project.id),
      loopItemId: String(task.id),
      projectStore: project.project_store,
      ...(threadRootId || trigger?.messageId
        ? { rootCommentId: threadRootId ?? trigger?.messageId }
        : {}),
    },
    ...(deviceId ? { deviceId } : {}),
    ...(attachments && attachments.length > 0 ? { attachments } : {}),
    // When a lost session is rebuilt for a reply, attach only the owning
    // thread's history; parent comments and live-session replies never receive
    // other threads' messages.
    additionalContext: threadRootId
      ? {
          ...additionalContext,
          projectChatHistory: {
            kind: 'untrusted',
            value: formatThreadHistory(threadRootId, messages, trigger),
          },
        }
      : additionalContext,
    prepareRuntimeTask: async nextAddress => {
      const deliveryApi = services.deliveryApi
      if (!deliveryApi) {
        throw new Error('项目空间任务绑定服务不可用')
      }
      await deliveryApi.bindTask(task.id, nextAddress, task.title)
      const projectRef = { projectId: project.id, projectStore: project.project_store }
      onBindingChange?.({
        task: nextAddress,
        project: projectRef,
        type: 'bound',
      })
      const rollback = async () => {
        await deliveryApi.unbindTask(task.id, nextAddress)
        onBindingChange?.({
          task: nextAddress,
          project: projectRef,
          type: 'unbound',
        })
      }
      try {
        responseRef.current = await startTaskAiResponse(client, {
          projectId: project.id,
          taskId: task.id,
          triggerMessageId: trigger?.messageId,
          agentId: agent.id,
          runtimeDeviceId: nextAddress.deviceId,
          runtimeTaskId: nextAddress.taskId,
          prompt,
          autoRetry,
          model: usedModel,
        })
        stopWatching = await watchRuntimeFailure(nextAddress.deviceId, nextAddress.taskId)
        onMessages(responseRef.current ? [responseRef.current] : [])
        return rollback
      } catch (cause) {
        await rollback()
        throw cause
      }
    },
    onError: error => {
      executionError = error
      onError(error)
    },
    onRuntimeTaskOptimisticOpen: async () => {
      await refreshTask(services, task.id, onTaskUpdated)
    },
  })
  if (!address) {
    stopWatching()
    if (responseRef.current) {
      try {
        const failed = await client.failAgentResponse({
          projectId: project.id,
          taskId: task.id,
          messageId: responseRef.current.messageId,
          error: executionError ?? startFailedText,
        })
        onMessages(failed ? [failed] : [])
      } catch (cause) {
        console.warn('[Wework] Failed to close rejected task AI run', cause)
      }
    }
    onError(executionError ?? startFailedText)
    return false
  }
  return true
}

async function startTaskAiResponse(
  client: ProjectChatClient,
  input: Parameters<ProjectChatClient['startAgentResponse']>[0]
): Promise<ProjectChatMessage> {
  // The backend deduplicates the response row by trigger message and runtime
  // task, so a retry after a transient network failure cannot duplicate it.
  try {
    return await client.startAgentResponse(input)
  } catch (firstError) {
    try {
      return await client.startAgentResponse(input)
    } catch {
      throw firstError
    }
  }
}

async function refreshTask<Task extends CommentExecutionTask>(
  services: CommentExecutionServices<Task>,
  taskId: string,
  onTaskUpdated?: (task: Task) => void
): Promise<void> {
  if (!services.deliveryApi) return
  const updated = await services.deliveryApi.getLoopItem(taskId)
  onTaskUpdated?.(updated)
}
