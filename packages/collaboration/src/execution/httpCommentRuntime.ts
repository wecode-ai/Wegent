import type { RuntimeTaskAddress, RuntimeName } from '@wegent/chat-core/runtime'
import type { createRuntimeConversationApi } from '@wegent/chat-core/runtime-conversation-api'
import type { RuntimeTaskCreateIntent } from '@wegent/chat-core/runtime-task-api-types'
import {
  createRuntimeTaskId,
  createRuntimeTaskIdFromSeed,
} from '@wegent/chat-core/runtime-task-identity'
import { localRuntimeAttachments, remoteAttachmentIds } from '@wegent/chat-core/runtime-attachments'
import type { TaskAiRuntimeBridge } from './taskAiExecution'

export interface CommentExecutionTarget {
  deviceId: string
  runtime: RuntimeName
  projectId?: number
  deviceWorkspaceId?: number
  workspacePath?: string
  runtimeProjectKey?: string
  runtimeProjectName?: string
  runtimeWorkspaceRoots?: string[]
}

type RuntimeApi = Pick<
  ReturnType<typeof createRuntimeConversationApi>,
  'createRuntimeTask' | 'sendRuntimeMessage'
>

/** HTTP host port for the PC comment orchestration, with the same pre-dispatch bindings. */
export function createHttpCommentRuntime(
  api: RuntimeApi,
  defaultTarget: CommentExecutionTarget | null
): TaskAiRuntimeBridge<CommentExecutionTarget> {
  return {
    async createProjectRuntimeTask(prompt, options) {
      const target = options.project ?? defaultTarget
      if (!target) {
        options.onError?.('Comment execution requires a selected workspace or device')
        return false
      }
      const request: RuntimeTaskCreateIntent = {
        ...target,
        schemaVersion: 2,
        taskId: createRuntimeTaskIdFromSeed(createRuntimeTaskId(target.runtime)),
        message: prompt,
        clientUserMessageId: options.optimisticUserMessage?.id,
        standaloneChatWorkspace:
          !target.projectId && !target.workspacePath && !target.runtimeProjectKey,
        ...options.executionModel,
        modelSelection: options.modelSelection,
        cloudProjectId: options.cloudProjectId,
        origin: options.origin,
        additionalContext: options.additionalContext,
        attachmentIds: remoteAttachmentIds(options.attachments ?? []),
        attachments: localRuntimeAttachments(options.attachments ?? []),
      }
      const address: RuntimeTaskAddress = {
        deviceId: target.deviceId,
        taskId: request.taskId!,
        runtime: target.runtime,
        workspacePath: target.workspacePath,
        runtimeHandle: options.modelSelection
          ? { modelSelection: options.modelSelection }
          : undefined,
      }
      let rollback: (() => Promise<void>) | undefined
      let dispatched = false
      try {
        if (!target.deviceId.trim()) throw new Error('Comment execution requires a device')
        if (options.deviceId && options.deviceId !== target.deviceId)
          throw new Error('Comment execution device does not match its selected workspace')
        rollback = await options.prepareRuntimeTask?.(address)
        await options.onRuntimeTaskOptimisticOpen?.(address)
        dispatched = true
        const response = await api.createRuntimeTask(request)
        if (!response.accepted) {
          dispatched = false
          throw new Error(response.error || 'Runtime did not accept task creation')
        }
        if (response.deviceId !== address.deviceId || response.taskId !== address.taskId)
          throw new Error('Runtime created a different task from the bound comment')
        return {
          ...address,
          workspacePath: response.workspacePath,
          runtimeHandle: response.runtimeHandle ?? address.runtimeHandle,
        }
      } catch (cause) {
        // An ambiguous transport failure may have started execution. Keep its binding inspectable.
        let error = cause instanceof Error ? cause.message : String(cause)
        if (!dispatched && rollback) {
          try {
            await rollback()
          } catch (cleanupError) {
            error += `; ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
          }
        }
        options.onError?.(error)
        return false
      }
    },
    async sendRuntimePaneMessage(input, options) {
      try {
        const response = await api.sendRuntimeMessage(input)
        if (!response.accepted)
          throw new Error(response.error || 'Runtime did not accept the message')
        return true
      } catch (cause) {
        options?.onError?.(cause instanceof Error ? cause.message : String(cause))
        return false
      }
    },
  }
}
