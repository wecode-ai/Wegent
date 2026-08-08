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
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'
import type { ModelOptions, ModelSelectionConfig, ModelType, UnifiedModel } from '@/types/api'
import { localRuntimeAttachments, remoteAttachmentIds } from '@/lib/runtime-attachments'
import { projectSpaceChatRuntimeContext } from './projectProviderConfig'

export interface TaskAiRuntimeBridge {
  createProjectRuntimeTask: (
    input: string,
    options: {
      project?: ProjectWithTasks | null
      modelId?: string | null
      collaborationMode?: 'default' | 'plan'
      cloudProjectId?: string
      hiddenFromSidebar?: boolean
      continuable?: boolean
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

export interface StartTaskAiRunInput {
  client: ProjectChatClient
  services: Pick<WorkbenchServices, 'deliveryApi'>
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
      try {
        responseRef.current = await startTaskAiResponse(client, {
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
        onMessages(responseRef.current ? [responseRef.current] : [])
        await refreshTask(services, task.id, onTaskUpdated)
        return true
      } catch (cause) {
        // The runtime accepted the follow-up turn; the reply row may already be
        // attached, so surface the failure and let the running turn write back.
        onError(cause instanceof Error ? cause.message : startFailedText)
        return false
      }
    }
    if (continuationRejectedReason && /running|执行中/i.test(continuationRejectedReason)) {
      // The bound turn is still active; starting a fresh run would double
      // execute the same reply.
      onError(continuationRejectedReason)
      return false
    }
    // Fall through silently: the bound session is gone or its device is
    // unavailable, so start a fresh hidden run for this new floor below.
  }

  const address = await runtime.createProjectRuntimeTask(prompt, {
    project: executionProject ?? null,
    ...(executionModel ? { executionModel } : {}),
    ...(modelSelection ? { modelSelection } : {}),
    collaborationMode: 'default',
    cloudProjectId: String(project.id),
    hiddenFromSidebar: true,
    continuable: true,
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
