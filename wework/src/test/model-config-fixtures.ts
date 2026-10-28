import {
  createLocalModelConfig,
  LOCAL_MODEL_SETTINGS_STORAGE_KEY,
  type CreateLocalModelConfigInput,
  type LocalModelConfig,
} from '@/features/model-settings/localModelSettings'
import {
  getProviderModelConfigs,
  replaceProviderModelConfigs,
} from '@/features/model-settings/providerModelState'

/** Unit fixtures seed only the memory projection; production writes use native IPC. */
export function saveLocalModelConfig(input: CreateLocalModelConfigInput): LocalModelConfig {
  const existing = getProviderModelConfigs()
  const next = createLocalModelConfig(input, existing)
  replaceProviderModelConfigs([...existing.filter(model => model.id !== next.id), next])
  return next
}

export function clearLocalModelConfigs(): void {
  replaceProviderModelConfigs([])
}

/** Historical inputs are created only by migration tests, never consumed by runtime catalogs. */
export function seedLegacyLocalModelConfig(input: CreateLocalModelConfigInput): LocalModelConfig {
  const existing = listLegacyLocalModelConfigs()
  const next = createLocalModelConfig(input, existing)
  localStorage.setItem(
    LOCAL_MODEL_SETTINGS_STORAGE_KEY,
    JSON.stringify([...existing.filter(model => model.id !== next.id), next])
  )
  return next
}

export function listLegacyLocalModelConfigs(): LocalModelConfig[] {
  return JSON.parse(localStorage.getItem(LOCAL_MODEL_SETTINGS_STORAGE_KEY) ?? '[]')
}
