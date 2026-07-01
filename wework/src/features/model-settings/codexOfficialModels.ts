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

function providerSortScore(provider: CodexOfficialModelProvider): number {
  if (provider.type === 'official') return 0
  return provider.current ? 1 : 2
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
    supportsFastMode:
      additionalSpeedTiers.some(tier => stringValue(tier)?.toLowerCase() === 'fast') ||
      serviceTiers.some(tier => stringValue(recordValue(tier).id)?.toLowerCase() === 'fast'),
  }
}

function officialModelSortScore(model: CodexOfficialModel): number {
  if (model.modelId === CODEX_RUNTIME_MODEL_ID) return 0
  if (model.isDefault) return 1
  return 2
}

function sortModels(models: CodexOfficialModel[]): CodexOfficialModel[] {
  return [...models].sort((left, right) => {
    const scoreDelta = officialModelSortScore(left) - officialModelSortScore(right)
    return (
      scoreDelta ||
      left.providerName.localeCompare(right.providerName) ||
      left.displayName.localeCompare(right.displayName)
    )
  })
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
  return {
    ...provider,
    models: sortModels(
      arrayValue(record.data)
        .map(model => normalizeOfficialModel(model, provider))
        .filter((model): model is CodexOfficialModel => model !== null)
    ),
  }
}

export function normalizeCodexOfficialModelList(value: unknown): CodexOfficialModelList {
  const record = recordValue(value)
  const providers = arrayValue(record.providers)
    .map(normalizeProvider)
    .filter((provider): provider is CodexOfficialModelProvider => provider !== null)
    .sort((left, right) => {
      const scoreDelta = providerSortScore(left) - providerSortScore(right)
      return scoreDelta || left.displayName.localeCompare(right.displayName)
    })

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
