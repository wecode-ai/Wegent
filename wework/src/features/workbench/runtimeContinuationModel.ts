import i18n from '@/i18n'
import type {
  ModelSelectionConfig,
  RuntimeSendRequest,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
} from '@/types/api'
import { modelSelectionFromRuntimeHandle } from './runtimeContextUsage'
import { findRuntimeTask } from './workbenchRuntimeHelpers'

/** Resolve against the destination task, never the active pane or new-chat defaults. */
export async function prepareRuntimeContinuationModel(
  request: RuntimeSendRequest,
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  listRuntimeWork: () => Promise<RuntimeWorkListResponse>,
  resolveActiveSelection?: (address: RuntimeTaskAddress) => ModelSelectionConfig | null | undefined
): Promise<RuntimeSendRequest> {
  if (request.requestUserInputResponse || request.request_user_input_response) return request

  if (request.modelId) {
    return {
      ...request,
      modelSelection: {
        modelName: request.modelId,
        modelType: request.modelType ?? null,
        options: request.modelOptions ?? {},
      },
    }
  }

  // The caller knows when an accepted cross-provider switch moved the native
  // session before the work list reflects it. Prefer that session selection
  // over a stale task cache; the cache remains the fallback for other callers.
  let selection = request.modelSelection
  if (!selection?.modelName) {
    selection = resolveActiveSelection?.(request.address) ?? null
  }
  if (!selection?.modelName) {
    let task = findRuntimeTask(runtimeWork, request.address)
    selection =
      task?.modelSelection ??
      modelSelectionFromRuntimeHandle(task?.runtimeHandle ?? request.address.runtimeHandle)
    if (!task && !selection?.modelName) {
      task = findRuntimeTask(await listRuntimeWork(), request.address)
      selection = task?.modelSelection ?? modelSelectionFromRuntimeHandle(task?.runtimeHandle)
    }
    // A task with no Wework model override deliberately uses native runtime
    // configuration. Only preserve that behavior after resolving its owner.
    if (task && !selection?.modelName) return request
  }
  if (!selection?.modelName) {
    throw new Error(i18n.t('workbench.harness_model_required'))
  }

  return {
    ...request,
    modelId: selection.modelName,
    modelType: selection.modelType,
    modelOptions: selection.options,
    modelSelection: selection,
  }
}
