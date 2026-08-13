import type { ProjectChatClient, ProjectChatMessage } from '@/api/backend/projectChatSocket'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import type {
  Attachment,
  ProjectWithTasks,
  RuntimeAdditionalContext,
  RuntimeTaskAddress,
} from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { localRuntimeAttachments, remoteAttachmentIds } from '@/lib/runtime-attachments'
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'
import type { ModelOptions, ModelSelectionConfig, ModelType, UnifiedModel } from '@/types/api'
import { projectSpaceChatRuntimeContext } from './projectProviderConfig'

export interface TaskAiRuntimeBridge {
  createProjectRuntimeTask: (
    input: string,
    options: {
      project?: ProjectWithTasks | null
      modelId?: string | null
      collaborationMode?: 'default' | 'plan'
      cloudProjectId?: string
      origin?: {
        type: 'board_comment'
        cloudProjectId: string
        loopItemId: string
        rootCommentId?: string
      }
      executionModel?: {
        modelId?: string | null
        modelType?: string | null
        modelOptions?: ModelOptions
      } | null
      modelSelection?: {
        modelName: string
        modelType: ModelType | null
        options: ModelOptions
      } | null
      additionalContext?: RuntimeAdditionalContext
      deviceId?: string | null
      attachments?: Attachment[]
      onError?: (error: string) => void
      onRuntimeTaskOptimisticOpen?: (address: RuntimeTaskAddress) => void | Promise<void>
    }
  ) => Promise<RuntimeTaskAddress | false>
  sendRuntimePaneMessage: (
    input: {
      address: RuntimeTaskAddress
      message: string
      ephemeral?: boolean
      modelId?: string
      modelType?: ModelType | null
      modelOptions?: ModelOptions
      modelSelection?: ModelSelectionConfig | null
      collaborationMode?: string
      additionalContext?: RuntimeAdditionalContext
      attachmentIds?: number[]
      attachments?: Attachment[]
    },
    options?: { onError?: (error: string) => void }
  ) => Promise<boolean>
}

function sessionDefinitelyUnavailable(error: string | null): boolean {
  if (!error) return false
  return /(?:thread|task|session).*(?:not found|不存在|已删除|不可用)|(?:not found|不存在).*(?:thread|task|session)/i.test(
    error
  )
}

export interface StartTaskAiRunInput {
  client: ProjectChatClient
  services: Pick<WorkbenchServices, 'deliveryApi'> & {
    chatStream?: WorkbenchServices['chatStream']
  }
  runtime: TaskAiRuntimeBridge
  project: CloudProject
  task: CloudLoopItem
  agent: ProjectChatAgent
  /** Bound local code project (task feature). Resolved before calling:
   * user selection first, then the robot's binding, then none. */
  executionProject?: ProjectWithTasks | null
  prompt: string
  trigger?: ProjectChatMessage
  autoRetry?: boolean
  messages: ProjectChatMessage[]
  /** Model list from the same source as the task composer; used to resolve the
   * agent's configured model name back to its full runtime configuration. */
  models?: UnifiedModel[]
  /** Per-comment model override; falls back to the agent's configured model. */
  selectedModel?: UnifiedModel | null
  selectedModelOptions?: ModelOptions
  /** When replying to an existing AI message, continue the executor session of
   * that message's parent comment instead of starting a new session. */
  replyTo?: { runtimeDeviceId: string; runtimeTaskId: string } | null
  /** The parent comment owning this run. Scopes rebuilt-session history to a
   * single thread when a lost session has to be recreated for a reply. */
  threadRootId?: string | null
  /** Target the run at the robot's execution environment device. */
  deviceId?: string | null
  /** Files attached to the comment; uploaded before the run starts. */
  attachments?: Attachment[]
  onError: (error: string) => void
  onMessages: (messages: ProjectChatMessage[]) => void
  onTaskUpdated?: (task: CloudLoopItem) => void
  startFailedText: string
}

export function buildRobotRoleDescription(agent: { name: string; systemPrompt?: string }): string {
  // The task title/description is read by the AI itself (injected context and
  // wework_space get_board_item); the sent content is the robot role only.
  return agent.systemPrompt
    ? `你是 ${agent.name}，这个项目任务的 AI 执行者。\n${agent.systemPrompt}`
    : `你是 ${agent.name}，这个项目任务的 AI 执行者。`
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

export async function startTaskAiRun({
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
  models,
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
}: StartTaskAiRunInput): Promise<boolean> {
  const responseRef: { current: ProjectChatMessage | null } = { current: null }
  // The executor can fail a turn asynchronously (lost thread, no model
  // progress). The backend event relay is not guaranteed to close the
  // streaming comment, so surface the failure from the sender's own runtime
  // stream: fail the comment and raise the error instead of leaving the reply
  // stuck at "正在处理" with no feedback.
  const watchRuntimeFailure = (deviceId: string, runtimeTaskId: string) => {
    if (!services.chatStream?.subscribe) return
    let finished = false
    const unsubscribe = services.chatStream.subscribe({
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
            .catch(() => undefined)
        }
        onError(payload.error)
      },
      onChatDone: payload => {
        if (finished || payload.taskId !== runtimeTaskId) return
        finished = true
        unsubscribe()
      },
    })
  }
  const commentModel = selectedModel ?? null
  const resolvedAgentModel = agent.model
    ? (models?.find(model => model.name === agent.model) ?? null)
    : null
  const resolvedModel = commentModel ?? resolvedAgentModel
  const executionModel = resolvedModel
    ? selectedModelExecutionFields(resolvedModel, selectedModelOptions ?? {})
    : agent.model
      ? { modelId: agent.model, modelType: null, modelOptions: {} }
      : null
  const modelSelection = resolvedModel
    ? {
        modelName: resolvedModel.name,
        modelType: resolvedModel.type,
        options: selectedModelOptions ?? {},
      }
    : null
  const usedModel = executionModel?.modelId ?? agent.model ?? undefined
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
      } catch {
        // The send itself failed; closing the placeholder is best-effort.
      }
    }
    const continued = await runtime.sendRuntimePaneMessage(
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
        onError: error => {
          continuationRejectedReason = error
        },
      }
    )
    if (continued) {
      watchRuntimeFailure(replyTo.runtimeDeviceId, replyTo.runtimeTaskId)
      onMessages(responseRef.current ? [responseRef.current] : [])
      await refreshTask(services, task.id, onTaskUpdated)
      return true
    }
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
    project: executionProject ?? null,
    ...(executionModel ? { executionModel } : {}),
    ...(modelSelection ? { modelSelection } : {}),
    collaborationMode: 'default',
    cloudProjectId: String(project.id),
    origin: {
      type: 'board_comment',
      cloudProjectId: String(project.id),
      loopItemId: String(task.id),
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
    onError,
    onRuntimeTaskOptimisticOpen: async nextAddress => {
      await services.deliveryApi?.bindTask(task.id, nextAddress, task.title)
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
      onMessages(responseRef.current ? [responseRef.current] : [])
      await refreshTask(services, task.id, onTaskUpdated)
    },
  })
  if (address) {
    watchRuntimeFailure(address.deviceId, address.taskId)
  }
  if (!address) {
    if (responseRef.current) {
      try {
        const failed = await client.failAgentResponse({
          projectId: project.id,
          taskId: task.id,
          messageId: responseRef.current.messageId,
          error: startFailedText,
        })
        onMessages(failed ? [failed] : [])
      } catch (cause) {
        console.warn('[Wework] Failed to close rejected task AI run', cause)
      }
    }
    onError(startFailedText)
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

async function refreshTask(
  services: Pick<WorkbenchServices, 'deliveryApi'>,
  taskId: string,
  onTaskUpdated?: (task: CloudLoopItem) => void
): Promise<void> {
  if (!services.deliveryApi) return
  const updated = await services.deliveryApi.getLoopItem(taskId)
  onTaskUpdated?.(updated)
}
