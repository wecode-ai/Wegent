import type { ProjectChatClient, ProjectChatMessage } from '@/api/backend/projectChatSocket'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import type { ProjectChatAgent } from '@/api/projectChatAgents'
import type { RuntimeAdditionalContext, RuntimeTaskAddress } from '@/types/api'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import { selectedModelExecutionFields } from '@/features/workbench/runtimeModelSelection'
import type { ModelOptions, UnifiedModel } from '@/types/api'
import { projectSpaceChatRuntimeContext } from './projectProviderConfig'

export interface TaskAiRuntimeBridge {
  createProjectRuntimeTask: (
    input: string,
    options: {
      project?: null
      modelId?: string | null
      collaborationMode?: 'default' | 'plan'
      cloudProjectId?: string
      hiddenFromSidebar?: boolean
      executionModel?: {
        modelId?: string | null
        modelType?: string | null
        modelOptions?: ModelOptions
      } | null
      modelSelection?: { modelName: string; modelType: string | null; options: ModelOptions } | null
      additionalContext?: RuntimeAdditionalContext
      deviceId?: string | null
      onError?: (error: string) => void
      onRuntimeTaskOptimisticOpen?: (address: RuntimeTaskAddress) => void | Promise<void>
    }
  ) => Promise<RuntimeTaskAddress | false>
  sendRuntimePaneMessage: (
    input: {
      address: RuntimeTaskAddress
      message: string
      ephemeral?: boolean
      additionalContext?: RuntimeAdditionalContext
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
  /** Target the run at the robot's execution environment device. */
  deviceId?: string | null
  onError: (error: string) => void
  onMessages: (messages: ProjectChatMessage[]) => void
  onTaskUpdated?: (task: CloudLoopItem) => void
  startFailedText: string
}

export function buildTaskAiInitialPrompt(task: CloudLoopItem): string {
  return [
    `请开始执行任务 ${task.id}：${task.title}`,
    task.description.trim(),
    '完成后请总结实际改动、验证结果、未完成事项和风险，提交给人类验收。',
  ]
    .filter(Boolean)
    .join('\n\n')
}

export function formatProjectChatHistory(
  current: ProjectChatMessage[],
  trigger?: ProjectChatMessage
): string {
  const lines = mergeProjectChatMessages(current, trigger ? [trigger] : [])
    .filter(message => message.status === 'completed' && message.content.trim())
    .slice(-40)
    .map(message => {
      const role =
        message.sender.type === 'agent' ? `AI ${message.sender.name}` : message.sender.name
      return `[${role}] ${message.content.trim()}`
    })
  return [
    '<project_chat_history order="oldest-first">',
    lines.join('\n').slice(-20_000),
    '</project_chat_history>',
    'Use this shared project-chat history to resolve references to earlier messages. Do not claim that only the current message is visible.',
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
  prompt,
  trigger,
  autoRetry,
  messages,
  models,
  selectedModel,
  selectedModelOptions,
  deviceId,
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
  const address = await runtime.createProjectRuntimeTask(prompt, {
    project: null,
    ...(executionModel ? { executionModel } : {}),
    ...(modelSelection ? { modelSelection } : {}),
    collaborationMode: 'default',
    cloudProjectId: String(project.id),
    hiddenFromSidebar: true,
    ...(deviceId ? { deviceId } : {}),
    additionalContext: {
      ...projectSpaceChatRuntimeContext(project),
      projectChatHistory: {
        kind: 'untrusted',
        value: formatProjectChatHistory(messages, trigger),
      },
      projectChat: {
        kind: 'application',
        value: [
          trigger
            ? `This run was started by task activity ${trigger.messageId}.`
            : 'This run was started by assigning this task to the project AI.',
          `Reply to task cloud://projects/${project.id}/todos/${task.id}.`,
          'Your final response is a reviewable task comment. Report actual changes, verification, unfinished work, and risks.',
        ].join('\n'),
      },
      projectChatAgent: {
        kind: 'application',
        value: agent.systemPrompt
          ? `You are ${agent.name}, the AI owner of this project task.\n${agent.systemPrompt}`
          : `You are ${agent.name}, the AI owner of this project task.`,
      },
    },
    onError,
    onRuntimeTaskOptimisticOpen: async nextAddress => {
      await services.deliveryApi?.bindTask(task.id, nextAddress, task.title)
      responseRef.current = await client.startAgentResponse({
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

async function refreshTask(
  services: Pick<WorkbenchServices, 'deliveryApi'>,
  taskId: string,
  onTaskUpdated?: (task: CloudLoopItem) => void
): Promise<void> {
  if (!services.deliveryApi) return
  const updated = await services.deliveryApi.getLoopItem(taskId)
  onTaskUpdated?.(updated)
}
