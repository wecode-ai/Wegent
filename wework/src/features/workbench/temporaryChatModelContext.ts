import type { RuntimeTaskAddress, RuntimeWorkListResponse, UnifiedModel } from '@/types/api'
import { findModelForSelection, modelSelectionFromRuntimeHandle } from './runtimeContextUsage'
import { findRuntimeTask } from './workbenchRuntimeHelpers'

export function resolveTemporaryChatActiveModel(
  models: UnifiedModel[],
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  address: RuntimeTaskAddress | null
): UnifiedModel | null {
  if (!address) return null

  const selection =
    findRuntimeTask(runtimeWork, address)?.modelSelection ??
    modelSelectionFromRuntimeHandle(address.runtimeHandle)

  return findModelForSelection(models, selection)
}
