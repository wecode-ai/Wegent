import type { ModelOptions, UnifiedModel } from '@wegent/chat-core/models'
import type { RuntimeTaskAddress } from '@wegent/chat-core/runtime'
import type {
  RuntimeSendRequest,
  RuntimeTaskSummary,
} from '@wegent/chat-core/runtime-task-api-types'
import { modelSelectionFromRuntimeHandle } from '@wegent/chat-core/runtime-model-selection'
import { selectedModelExecutionFields } from '../controls/runtimeModelSelection'

/** Preserve the destination's complete model identity when no draft override was selected. */
export function runtimeContinuationRequest(
  address: RuntimeTaskAddress,
  task: RuntimeTaskSummary,
  selection: { model: UnifiedModel | null; options: ModelOptions } | null,
  cloudProjectId?: string
): Omit<RuntimeSendRequest, 'message' | 'clientUserMessageId'> {
  const persisted = task.modelSelection ?? modelSelectionFromRuntimeHandle(task.runtimeHandle)
  const fields = selection
    ? selectedModelExecutionFields(selection.model, selection.options)
    : {
        modelId: persisted?.modelName,
        modelType: persisted?.modelType,
        modelOptions: persisted?.options,
      }
  const modelId = fields.modelId ?? persisted?.modelName
  const modelType = fields.modelType ?? persisted?.modelType
  return {
    address: {
      ...address,
      runtime: task.runtime,
      threadId: task.threadId,
      workspacePath: task.workspacePath,
      workspaceKind: task.workspaceKind,
      worktreeId: task.worktreeId,
      runtimeHandle: task.runtimeHandle,
    },
    ...fields,
    modelId,
    modelType,
    modelSelection: modelId
      ? { modelName: modelId, modelType, options: fields.modelOptions ?? {} }
      : undefined,
    collaborationMode: fields.modelOptions?.collaborationMode,
    cloudProjectId,
  }
}
