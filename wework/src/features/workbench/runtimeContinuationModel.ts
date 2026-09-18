import i18n from '@/i18n'
import type { RuntimeSendRequest, RuntimeWorkListResponse } from '@/types/api'
import { modelSelectionFromRuntimeHandle } from './runtimeContextUsage'
import { findRuntimeTask } from './workbenchRuntimeHelpers'

/** Resolve against the destination task, never the active pane or new-chat defaults. */
export async function prepareRuntimeContinuationModel(
  request: RuntimeSendRequest,
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  listRuntimeWork: () => Promise<RuntimeWorkListResponse>
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

  let selection = request.modelSelection
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
