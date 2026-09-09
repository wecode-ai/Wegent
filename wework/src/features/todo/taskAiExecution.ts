import type { ProjectChatClient, ProjectChatMessage } from '@/api/backend/projectChatSocket'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
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
import { buildWorkItemRuntimeContext } from './workItemRuntimeContext'
import { activityTaskRequest, taskActivityExecutionConfig } from './taskActivityExecutionConfig'
import type { CreateProjectRuntimeTaskOptions } from '@/features/workbench/workbenchContextTypes'

export interface TaskAiRuntimeBridge {
  createProjectRuntimeTask: (
    input: string,
    options: CreateProjectRuntimeTaskOptions
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

export interface StartTaskAiRunInput {
  client: ProjectChatClient
  services: Pick<WorkbenchServices, 'deliveryApi'> & {
    chatStream?: WorkbenchServices['chatStream']
  }
  runtime: TaskAiRuntimeBridge
  project: CloudProject
  task: CloudLoopItem
  /** Bound local code project (task feature). Resolved before calling:
   * user selection overrides the Issue workflow workspace. */
  executionProject?: ProjectWithTasks | null
  prompt: string
  trigger?: ProjectChatMessage
  autoRetry?: boolean
  /** Per-comment model selection. */
  selectedModel?: UnifiedModel | null
  selectedModelOptions?: ModelOptions
  /** When replying to an existing AI message, continue the executor session of
   * that message's parent comment instead of starting a new session. */
  replyTo?: { runtimeDeviceId: string; runtimeTaskId: string } | null
  /** The parent activity owning this task; replies must keep its address. */
  threadRootId?: string | null
  /** Explicit execution device override. */
  deviceId?: string | null
  /** Files attached to the comment; uploaded before the run starts. */
  attachments?: Attachment[]
  onError: (error: string) => void
  onMessages: (messages: ProjectChatMessage[]) => void
  onTaskUpdated?: (task: CloudLoopItem) => void
  startFailedText: string
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
  executionProject,
  prompt,
  trigger,
  autoRetry,
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
  let stopWatching: (() => void) | undefined
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
    return unsubscribe
  }
  const executionModel = selectedModel
    ? selectedModelExecutionFields(selectedModel, selectedModelOptions ?? {})
    : null
  const modelSelection = selectedModel
    ? {
        modelName: selectedModel.name,
        modelType: selectedModel.type,
        options: selectedModelOptions ?? {},
      }
    : null
  const usedModel = executionModel?.modelId
  const context = buildWorkItemRuntimeContext(
    project,
    task,
    task.workflow?.current_stage_id ?? undefined
  )
  const configuredRequest = activityTaskRequest(taskActivityExecutionConfig(task), prompt)
  const additionalContext: RuntimeAdditionalContext = {
    ...configuredRequest?.additionalContext,
    ...context.additionalContext,
  }
  if (threadRootId && !replyTo) {
    onError(startFailedText)
    return false
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
    stopWatching = watchRuntimeFailure(replyTo.runtimeDeviceId, replyTo.runtimeTaskId)
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
      onMessages(responseRef.current ? [responseRef.current] : [])
      await refreshTask(services, task.id, onTaskUpdated)
      return true
    }
    stopWatching?.()
    const rejection = continuationRejectedReason ?? startFailedText
    await closePendingMessage(rejection)
    onError(rejection)
    return false
  }

  const address = await runtime.createProjectRuntimeTask(prompt, {
    project: executionProject ?? null,
    runtime: 'codex',
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
    additionalContext,
    ...(configuredRequest
      ? {
          taskRequest: {
            ...configuredRequest,
            ...(executionModel
              ? {
                  modelId: executionModel.modelId ?? undefined,
                  modelType: executionModel.modelType as ModelType,
                  modelOptions: executionModel.modelOptions,
                  modelSelection,
                }
              : {}),
            ...(executionProject
              ? {
                  projectId: undefined,
                  deviceWorkspaceId: undefined,
                  runtimeProjectKey: undefined,
                  standaloneChatWorkspace: false,
                  deviceId: deviceId ?? undefined,
                }
              : {}),
            additionalContext,
          },
        }
      : {}),
    prepareRuntimeTask: async nextAddress => {
      const deliveryApi = services.deliveryApi
      if (!deliveryApi) {
        throw new Error('项目空间任务绑定服务不可用')
      }
      await deliveryApi.bindTask(task.id, nextAddress, task.title)
      try {
        responseRef.current = await startTaskAiResponse(client, {
          projectId: project.id,
          taskId: task.id,
          triggerMessageId: trigger?.messageId,
          runtimeDeviceId: nextAddress.deviceId,
          runtimeTaskId: nextAddress.taskId,
          prompt,
          autoRetry,
          model: usedModel,
        })
        onMessages([responseRef.current])
        stopWatching = watchRuntimeFailure(nextAddress.deviceId, nextAddress.taskId)
      } catch (error) {
        await deliveryApi.unbindTask(task.id, nextAddress)
        throw error
      }
      return () => deliveryApi.unbindTask(task.id, nextAddress)
    },
    onError,
    onRuntimeTaskOptimisticOpen: async () => {
      await refreshTask(services, task.id, onTaskUpdated)
    },
  })
  if (!address) {
    stopWatching?.()
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
