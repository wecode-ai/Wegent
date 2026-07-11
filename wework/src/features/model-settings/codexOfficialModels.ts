export type CodexModelProviderType = 'official' | 'provider'

export interface CodexOfficialModel {
  id: string
  displayName: string
  modelId: string
  providerId: string
  providerName: string
  providerType: CodexModelProviderType
  providerCurrent: boolean
  description: string | null
  hidden: boolean
  isDefault: boolean
  defaultReasoningEffort: string | null
  supportedReasoningEfforts: string[]
  supportsFastMode: boolean
}

export interface CodexOfficialModelProvider {
  id: string
  displayName: string
  type: CodexModelProviderType
  current: boolean
  available: boolean
  error: string | null
  models: CodexOfficialModel[]
}

export interface CodexOfficialModelList {
  providers: CodexOfficialModelProvider[]
  models: CodexOfficialModel[]
}

export const CODEX_RUNTIME_MODEL_ID = 'gpt-5.5'
export const CODEX_OFFICIAL_UNAVAILABLE_MODEL_NAME = 'codex-official-unavailable'

const CODEX_PICKER_MODELS = [
  { modelId: 'gpt-5.6-sol', label: 'GPT 5.6 Sol' },
  { modelId: 'gpt-5.6-terra', label: 'GPT 5.6 Terra' },
  { modelId: 'gpt-5.6-luna', label: 'GPT 5.6 Luna' },
  { modelId: 'gpt-5.5', label: 'GPT 5.5' },
  { modelId: 'gpt-5.4', label: 'GPT 5.4' },
  { modelId: 'gpt-5.4-mini', label: 'GPT 5.4 Mini' },
  { modelId: 'gpt-5.3-codex-spark', label: 'GPT 5.3 Codex Spark' },
] as const

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

function booleanValue(value: unknown): boolean {
  return value === true
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function camelOrSnake(record: Record<string, unknown>, camel: string, snake: string): unknown {
  return record[camel] ?? record[snake]
}

function providerTypeValue(value: unknown): CodexModelProviderType | null {
  const normalized = stringValue(value)?.toLowerCase()
  if (normalized === 'provider') return 'provider'
  if (normalized === 'official') return 'official'
  return null
}

function normalizedModelId(modelId: string): string {
  return modelId.trim().toLowerCase()
}

export function codexModelPickerLabel(modelId: string): string {
  return (
    CODEX_PICKER_MODELS.find(model => model.modelId === normalizedModelId(modelId))?.label ??
    modelId
  )
}

export function codexModelPickerSortOrder(modelId: string): number {
  const index = CODEX_PICKER_MODELS.findIndex(model => model.modelId === normalizedModelId(modelId))
  return index >= 0 ? index : CODEX_PICKER_MODELS.length
}

function reasoningEffortValue(value: unknown): string | null {
  if (typeof value === 'string') return stringValue(value)?.toLowerCase() ?? null
  const record = recordValue(value)
  return (
    stringValue(camelOrSnake(record, 'reasoningEffort', 'reasoning_effort'))?.toLowerCase() ?? null
  )
}

function normalizeOfficialModel(
  value: unknown,
  provider?: Pick<CodexOfficialModelProvider, 'id' | 'displayName' | 'type' | 'current'>
): CodexOfficialModel | null {
  const record = recordValue(value)
  const modelId = stringValue(record.model) ?? stringValue(record.id)
  if (!modelId) return null
  const providerId = stringValue(camelOrSnake(record, 'providerId', 'provider_id')) ?? provider?.id
  const providerName =
    stringValue(camelOrSnake(record, 'providerName', 'provider_name')) ??
    provider?.displayName ??
    providerId ??
    'CodeX'
  const providerType =
    providerTypeValue(camelOrSnake(record, 'providerType', 'provider_type')) ??
    provider?.type ??
    'official'
  const serviceTiers = arrayValue(camelOrSnake(record, 'serviceTiers', 'service_tiers'))
  const additionalSpeedTiers = arrayValue(
    camelOrSnake(record, 'additionalSpeedTiers', 'additional_speed_tiers')
  )
  const supportedReasoningEfforts = arrayValue(
    camelOrSnake(record, 'supportedReasoningEfforts', 'supported_reasoning_efforts')
  )
    .map(reasoningEffortValue)
    .filter((effort): effort is string => Boolean(effort))
  return {
    id: stringValue(record.id) ?? modelId,
    modelId,
    displayName: stringValue(camelOrSnake(record, 'displayName', 'display_name')) ?? modelId,
    providerId: providerId ?? 'openai',
    providerName,
    providerType,
    providerCurrent:
      booleanValue(camelOrSnake(record, 'providerCurrent', 'provider_current')) ||
      provider?.current === true,
    description: stringValue(record.description),
    hidden: booleanValue(record.hidden),
    isDefault: booleanValue(camelOrSnake(record, 'isDefault', 'is_default')),
    defaultReasoningEffort:
      stringValue(camelOrSnake(record, 'defaultReasoningEffort', 'default_reasoning_effort')) ??
      null,
    supportedReasoningEfforts,
    supportsFastMode:
      additionalSpeedTiers.some(tier => stringValue(tier)?.toLowerCase() === 'fast') ||
      serviceTiers.some(tier => stringValue(recordValue(tier).id)?.toLowerCase() === 'fast'),
  }
}

function sortModels(models: CodexOfficialModel[]): CodexOfficialModel[] {
  return [...models].sort(
    (left, right) =>
      codexModelPickerSortOrder(left.modelId) - codexModelPickerSortOrder(right.modelId)
  )
}

function normalizeProvider(value: unknown): CodexOfficialModelProvider | null {
  const record = recordValue(value)
  const id = stringValue(record.id)
  if (!id) return null
  const provider = {
    id,
    displayName:
      stringValue(camelOrSnake(record, 'displayName', 'display_name')) ??
      stringValue(record.name) ??
      id,
    type: providerTypeValue(record.type) ?? 'official',
    current: booleanValue(record.current),
    available: record.available !== false,
    error: stringValue(record.error),
  }
  const normalizedModels = sortModels(
    arrayValue(record.data)
      .map(model => normalizeOfficialModel(model, provider))
      .filter((model): model is CodexOfficialModel => model !== null)
  )
  return { ...provider, models: normalizedModels }
}

export function normalizeCodexOfficialModelList(value: unknown): CodexOfficialModelList {
  const record = recordValue(value)
  const providers = arrayValue(record.providers)
    .map(normalizeProvider)
    .filter((provider): provider is CodexOfficialModelProvider => provider !== null)

  if (providers.length > 0) {
    return { providers, models: providers.flatMap(provider => provider.models) }
  }

  const fallbackProvider: CodexOfficialModelProvider = {
    id: 'openai',
    displayName: 'CodeX',
    type: 'official',
    current: true,
    available: true,
    error: null,
    models: [],
  }
  const fallbackModels = sortModels(
    arrayValue(record.data)
      .map(model => normalizeOfficialModel(model, fallbackProvider))
      .filter((model): model is CodexOfficialModel => model !== null)
  )
  return {
    providers: fallbackModels.length > 0 ? [{ ...fallbackProvider, models: fallbackModels }] : [],
    models: fallbackModels,
  }
}

export function codexOfficialModelName(modelOrId: CodexOfficialModel | string): string {
  return typeof modelOrId === 'string' ? modelOrId : modelOrId.modelId
}

export function codexOfficialModelIdFromModelName(modelName?: string | null): string | null {
  return modelName?.trim() || null
}
