import type {
  ModelSelectionConfig,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  UnifiedModel,
} from '@/types/api'
import { findModelForSelection, modelSelectionFromRuntimeHandle } from './runtimeContextUsage'
import { findRuntimeTask } from './workbenchRuntimeHelpers'

export function resolveTemporaryChatActiveModel(
  models: UnifiedModel[],
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  address: RuntimeTaskAddress | null
): UnifiedModel | null {
  return findModelForSelection(models, resolveTemporaryChatModelSelection(runtimeWork, address))
}

export function resolveTemporaryChatModelSelection(
  runtimeWork: RuntimeWorkListResponse | null | undefined,
  address: RuntimeTaskAddress | null
): ModelSelectionConfig | null {
  if (!address) return null
  return (
    findRuntimeTask(runtimeWork, address)?.modelSelection ??
    modelSelectionFromRuntimeHandle(address.runtimeHandle)
  )
}
