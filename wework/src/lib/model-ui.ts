import type { ModelOptions, UnifiedModel } from '@/types/api'

export interface ModelControlOption {
  value: string
  label: string
  labelKey?: string
  summaryLabel?: string
  description?: string
  descriptionKey?: string
  order: number
}

export interface ModelControlConfig {
  id: string
  label: string
  labelKey?: string
  defaultValue: string
  placement?: 'aboveModels' | 'belowModels'
  scope?: 'family' | 'model'
  includeInLabel?: 'always' | 'whenNonDefault' | 'never'
  options: ModelControlOption[]
}

export interface ModelFamilyConfig {
  id: string
  label: string
  order: number
  controls: ModelControlConfig[]
}

export type ModelCompatibilityFamily = string

export interface ModelCompatibilitySource {
  name?: string | null
  displayName?: string | null
  provider?: string | null
  modelId?: string | null
  config?: Record<string, unknown> | null
  runtime?: {
    family?: string | null
  } | null
}

interface ModelUiMetadata {
  family: string
  region?: string
  modelLabel: string
  sortOrder: number
  supportedControls: Set<string>
}

type LabelResolver = (key: string, fallback: string) => string

const REGION_LABELS: Record<string, string> = {
  intranet: '内网',
  public: '公网',
  overseas: '海外',
}

const FAMILY_ORDER = [
  'claude',
  'gpt',
  'gemini',
  'kimi',
  'glm',
  'deepseek',
  'qwen',
  'minimax',
  'other',
]

const HIDDEN_MODEL_FAMILIES = new Set(['gemini'])

export const MODEL_FAMILY_CONFIGS: ModelFamilyConfig[] = [
  { id: 'claude', label: 'Claude', order: 10, controls: [] },
  {
    id: 'gpt',
    label: 'GPT',
    order: 20,
    controls: [
      {
        id: 'reasoning',
        label: 'Reasoning',
        labelKey: 'workbench.reasoning_level',
        defaultValue: 'high',
        placement: 'aboveModels',
        scope: 'family',
        includeInLabel: 'never',
        options: [
          {
            value: 'low',
            label: 'Low',
            labelKey: 'workbench.intelligence_low',
            order: 10,
          },
          {
            value: 'medium',
            label: 'Medium',
            labelKey: 'workbench.intelligence_medium',
            order: 20,
          },
          {
            value: 'high',
            label: 'High',
            labelKey: 'workbench.intelligence_high',
            order: 30,
          },
          {
            value: 'extra_high',
            label: 'Extra High',
            labelKey: 'workbench.intelligence_ultra',
            order: 40,
          },
        ],
      },
      {
        id: 'speed',
        label: 'Speed',
        labelKey: 'workbench.speed',
        defaultValue: 'standard',
        placement: 'belowModels',
        scope: 'model',
        includeInLabel: 'whenNonDefault',
        options: [
          {
            value: 'standard',
            label: '标准',
            labelKey: 'workbench.speed_standard',
            description: '默认速度',
            descriptionKey: 'workbench.speed_standard_description',
            order: 10,
          },
          {
            value: 'fast',
            label: '⚡ 快速',
            labelKey: 'workbench.speed_fast',
            summaryLabel: '⚡',
            description: '1.5 倍速度，消耗增加',
            descriptionKey: 'workbench.speed_fast_description',
            order: 20,
          },
        ],
      },
    ],
  },
  { id: 'gemini', label: 'Gemini', order: 30, controls: [] },
  { id: 'kimi', label: 'Kimi', order: 40, controls: [] },
  { id: 'glm', label: 'GLM', order: 50, controls: [] },
  { id: 'deepseek', label: 'DeepSeek', order: 60, controls: [] },
  { id: 'qwen', label: 'Qwen', order: 70, controls: [] },
  { id: 'minimax', label: 'MiniMax', order: 80, controls: [] },
  { id: 'other', label: '其他', order: 100, controls: [] },
]

function getConfigUi(model: UnifiedModel): Record<string, unknown> {
  const ui = model.config?.ui
  return ui && typeof ui === 'object' && !Array.isArray(ui)
    ? (ui as Record<string, unknown>)
    : {}
}

function identityTextForModel(model: UnifiedModel): string {
  return [model.name, model.displayName, model.modelId]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
}

function normalizeCompatibilitySignal(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function getModelCompatibilityFamily(
  model?: ModelCompatibilitySource | null,
): ModelCompatibilityFamily | null {
  if (!model) return null
  return normalizeCompatibilitySignal(model.runtime?.family) || null
}

export function areModelsProtocolCompatible(
  currentModel?: ModelCompatibilitySource | null,
  nextModel?: ModelCompatibilitySource | null,
): boolean {
  const currentFamily = getModelCompatibilityFamily(currentModel)
  const nextFamily = getModelCompatibilityFamily(nextModel)
  if (!currentFamily || !nextFamily) return false
  return currentFamily === nextFamily
}

export function inferModelFamily(model: UnifiedModel): string {
  const explicit = getConfigUi(model).family
  if (typeof explicit === 'string' && explicit.trim()) {
    return explicit.trim().toLowerCase()
  }

  const text = identityTextForModel(model)
  if (text.includes('kimi')) return 'kimi'
  if (text.includes('gemini')) return 'gemini'
  if (text.includes('glm')) return 'glm'
  if (text.includes('deepseek')) return 'deepseek'
  if (text.includes('qwen')) return 'qwen'
  if (text.includes('minimax')) return 'minimax'
  if (text.includes('claude') || text.includes('opus') || text.includes('sonnet')) {
    return 'claude'
  }
  if (text.includes('gpt') || text.includes('openai')) return 'gpt'

  return 'other'
}

export function getFamilyConfig(familyId: string): ModelFamilyConfig {
  return (
    MODEL_FAMILY_CONFIGS.find(config => config.id === familyId) ?? {
      id: familyId,
      label: familyId.replace(/^\w/, letter => letter.toUpperCase()),
      order: 100,
      controls: [],
    }
  )
}

function inferRegion(model: UnifiedModel): string | undefined {
  const explicit = getConfigUi(model).region
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()

  const text = [model.displayName, model.name, model.modelId].filter(Boolean).join(' ')
  if (text.includes('海外') || /overseas/i.test(text)) return 'overseas'
  if (text.includes('公网') || /public/i.test(text)) return 'public'
  if (text.includes('内网') || /intranet|internal/i.test(text)) return 'intranet'
  return undefined
}

function stripRegionPrefix(label: string): string {
  return label.replace(/^(内网|公网|海外)\s*[:：]\s*/, '').trim()
}

function getExplicitSupportedControls(ui: Record<string, unknown>): Set<string> {
  const controls = ui.controls ?? ui.supportedControls
  if (Array.isArray(controls)) {
    return new Set(controls.filter((control): control is string => typeof control === 'string'))
  }

  if (controls && typeof controls === 'object') {
    return new Set(
      Object.entries(controls as Record<string, unknown>)
        .filter(([, value]) => {
          if (typeof value === 'boolean') return value
          if (value && typeof value === 'object' && !Array.isArray(value)) {
            return (value as Record<string, unknown>).enabled !== false
          }
          return false
        })
        .map(([key]) => key)
    )
  }

  return new Set()
}

export function getModelUiMetadata(model: UnifiedModel): ModelUiMetadata {
  const ui = getConfigUi(model)
  const modelLabel =
    typeof ui.modelLabel === 'string' && ui.modelLabel.trim()
      ? ui.modelLabel.trim()
      : stripRegionPrefix(model.displayName || model.modelId || model.name)
  const sortOrder = typeof ui.sortOrder === 'number' ? ui.sortOrder : 100

  return {
    family: inferModelFamily(model),
    region: inferRegion(model),
    modelLabel,
    sortOrder,
    supportedControls: getExplicitSupportedControls(ui),
  }
}

export function getControlsForModel(model: UnifiedModel | null): ModelControlConfig[] {
  if (!model) return []
  const metadata = getModelUiMetadata(model)
  const familyConfig = getFamilyConfig(metadata.family)
  return familyConfig.controls.filter(control => {
    if ((control.scope ?? 'family') === 'family') return true
    return metadata.supportedControls.has(control.id)
  })
}

export function getModelDisplayLabel(
  model: UnifiedModel | null,
  options: ModelOptions = {},
  resolveLabel?: LabelResolver,
): string {
  if (!model) return ''

  const metadata = getModelUiMetadata(model)
  const controls = getControlsForModel(model)
  const regionLabel = metadata.region ? REGION_LABELS[metadata.region] ?? metadata.region : ''
  const controlLabels = controls
    .filter(control => control.includeInLabel !== 'never')
    .map(control => {
      const selected = options[control.id] ?? control.defaultValue
      if (control.includeInLabel === 'whenNonDefault' && selected === control.defaultValue) {
        return ''
      }
      return resolveOptionSummaryLabel(
        control.options.find(option => option.value === selected),
        resolveLabel,
      )
    })
    .filter(Boolean)

  return [
    regionLabel ? `${regionLabel}:${metadata.modelLabel}` : metadata.modelLabel,
    ...controlLabels,
  ].join(' ')
}

function resolveOptionLabel(
  option: ModelControlOption | undefined,
  resolveLabel?: LabelResolver,
): string {
  if (!option) return ''
  return option.labelKey && resolveLabel
    ? resolveLabel(option.labelKey, option.label)
    : option.label
}

function resolveOptionSummaryLabel(
  option: ModelControlOption | undefined,
  resolveLabel?: LabelResolver,
): string {
  if (!option) return ''
  return option.summaryLabel || resolveOptionLabel(option, resolveLabel)
}

export function getSelectedModelDisplayLabel(
  model: UnifiedModel | null,
  options: ModelOptions = {},
  resolveLabel?: LabelResolver,
): string {
  if (!model) return ''

  const metadata = getModelUiMetadata(model)
  const controls = getControlsForModel(model)
  const regionLabel = metadata.region ? REGION_LABELS[metadata.region] ?? metadata.region : ''
  const controlLabels = controls
    .map(control => {
      const selected = options[control.id] ?? control.defaultValue
      if (
        control.id !== 'reasoning' &&
        control.includeInLabel === 'whenNonDefault' &&
        selected === control.defaultValue
      ) {
        return ''
      }
      if (control.id !== 'reasoning' && control.includeInLabel === 'never') {
        return ''
      }
      return resolveOptionSummaryLabel(
        control.options.find(option => option.value === selected),
        resolveLabel,
      )
    })
    .filter(Boolean)

  return [
    regionLabel ? `${regionLabel}:${metadata.modelLabel}` : metadata.modelLabel,
    ...controlLabels,
  ].join(' ')
}

export function getDefaultModelOptions(model: UnifiedModel | null): ModelOptions {
  if (!model) return {}
  return Object.fromEntries(
    getControlsForModel(model).map(control => [control.id, control.defaultValue]),
  )
}

export function normalizeModelOptions(
  model: UnifiedModel | null,
  options: ModelOptions,
): ModelOptions {
  if (!model) return {}
  return Object.fromEntries(
    getControlsForModel(model).map(control => [
      control.id,
      options[control.id] ?? control.defaultValue,
    ]),
  )
}

function regionPriority(region?: string): number {
  if (region === 'intranet') return 0
  if (region === 'public') return 1
  if (region === 'overseas') return 2
  return 3
}

function extractVersionParts(label: string): number[] {
  return [...label.matchAll(/\d+/g)].map(match => Number.parseInt(match[0], 10))
}

function compareVersionDesc(leftLabel: string, rightLabel: string): number {
  const leftParts = extractVersionParts(leftLabel)
  const rightParts = extractVersionParts(rightLabel)
  const maxLength = Math.max(leftParts.length, rightParts.length)

  for (let index = 0; index < maxLength; index += 1) {
    const leftPart = leftParts[index] ?? 0
    const rightPart = rightParts[index] ?? 0
    if (leftPart !== rightPart) return rightPart - leftPart
  }

  return 0
}

export function groupModelsByFamily(models: UnifiedModel[]) {
  const groups = new Map<string, UnifiedModel[]>()
  for (const model of models) {
    const family = inferModelFamily(model)
    if (HIDDEN_MODEL_FAMILIES.has(family)) continue
    groups.set(family, [...(groups.get(family) ?? []), model])
  }

  return [...groups.entries()]
    .map(([familyId, familyModels]) => ({
      config: getFamilyConfig(familyId),
      models: [...familyModels].sort((a, b) => {
        const left = getModelUiMetadata(a)
        const right = getModelUiMetadata(b)
        return (
          regionPriority(left.region) - regionPriority(right.region) ||
          compareVersionDesc(left.modelLabel, right.modelLabel) ||
          left.sortOrder - right.sortOrder ||
          left.modelLabel.localeCompare(right.modelLabel)
        )
      }),
    }))
    .sort((a, b) => {
      const leftOrder = FAMILY_ORDER.indexOf(a.config.id)
      const rightOrder = FAMILY_ORDER.indexOf(b.config.id)
      const normalizedLeft = leftOrder >= 0 ? leftOrder : a.config.order
      const normalizedRight = rightOrder >= 0 ? rightOrder : b.config.order
      return normalizedLeft - normalizedRight || a.config.label.localeCompare(b.config.label)
    })
}

export function isSupportedModelFamily(model: UnifiedModel): boolean {
  return Boolean(model.name)
}
