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
  persistDefault?: boolean
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
  familyLabel?: string
  region?: string
  modelLabel: string
  sortOrder: number
  supportedControls: Set<string>
  supportedReasoningEfforts: string[]
  defaultReasoningEffort?: string
}

type LabelResolver = (key: string, fallback: string) => string

const REGION_LABELS: Record<string, string> = {
  intranet: '内网',
  public: '公网',
  overseas: '海外',
}

const FAMILY_ORDER = [
  'claude',
  'codex-official',
  'codex-provider',
  'model-interface',
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

const OPENAI_RESPONSES_CONTROLS: ModelControlConfig[] = [
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
        value: 'xhigh',
        label: 'Extra High',
        labelKey: 'workbench.intelligence_ultra',
        order: 40,
      },
      {
        value: 'max',
        label: 'Maximum',
        labelKey: 'workbench.intelligence_max',
        order: 50,
      },
      {
        value: 'ultra',
        label: 'Extra High',
        labelKey: 'workbench.intelligence_ultra',
        description: 'Faster, uses more quota',
        descriptionKey: 'workbench.reasoning_ultra_description',
        order: 60,
      },
    ],
  },
  {
    id: 'collaborationMode',
    label: 'Mode',
    labelKey: 'workbench.collaboration_mode',
    defaultValue: 'default',
    placement: 'aboveModels',
    scope: 'family',
    includeInLabel: 'never',
    persistDefault: false,
    options: [
      {
        value: 'default',
        label: 'Default mode',
        labelKey: 'workbench.collaboration_default',
        description: 'Answer directly in the normal Codex flow.',
        descriptionKey: 'workbench.collaboration_default_description',
        order: 10,
      },
      {
        value: 'plan',
        label: 'Plan mode',
        labelKey: 'workbench.plan_mode',
        description: 'Ask clarifying questions before continuing when needed.',
        descriptionKey: 'workbench.plan_mode_description',
        order: 20,
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
]

export const MODEL_FAMILY_CONFIGS: ModelFamilyConfig[] = [
  { id: 'claude', label: 'Claude', order: 10, controls: [] },
  { id: 'codex-official', label: '我的 CodeX', order: 20, controls: OPENAI_RESPONSES_CONTROLS },
  { id: 'codex-provider', label: 'Provider 模型', order: 30, controls: OPENAI_RESPONSES_CONTROLS },
  { id: 'model-interface', label: '接口模型', order: 40, controls: OPENAI_RESPONSES_CONTROLS },
  {
    id: 'gpt',
    label: 'GPT',
    order: 50,
    controls: OPENAI_RESPONSES_CONTROLS,
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
  return ui && typeof ui === 'object' && !Array.isArray(ui) ? (ui as Record<string, unknown>) : {}
}

function identityTextForModel(model: UnifiedModel): string {
  return [model.name, model.displayName, model.modelId].filter(Boolean).join(' ').toLowerCase()
}

function normalizeCompatibilitySignal(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function getModelCompatibilityFamily(
  model?: ModelCompatibilitySource | null
): ModelCompatibilityFamily | null {
  if (!model) return null
  return normalizeCompatibilitySignal(model.runtime?.family) || null
}

function getCompatibilityRuntimeGroup(family: ModelCompatibilityFamily): string {
  const [provider = '', protocol = ''] = family.split('.')
  if (family === 'openai' || protocol === 'openai-responses') return 'openai'
  if (family === 'claude' || provider === 'claude' || protocol === 'claude') return 'claude'
  return family
}

export function areModelCompatibilityFamiliesCompatible(
  currentFamily?: ModelCompatibilityFamily | null,
  nextFamily?: ModelCompatibilityFamily | null
): boolean {
  if (!currentFamily || !nextFamily) return false
  return getCompatibilityRuntimeGroup(currentFamily) === getCompatibilityRuntimeGroup(nextFamily)
}

export function areModelsProtocolCompatible(
  currentModel?: ModelCompatibilitySource | null,
  nextModel?: ModelCompatibilitySource | null
): boolean {
  const currentFamily = getModelCompatibilityFamily(currentModel)
  const nextFamily = getModelCompatibilityFamily(nextModel)
  return areModelCompatibilityFamiliesCompatible(currentFamily, nextFamily)
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

export function getFamilyConfig(familyId: string, label?: string): ModelFamilyConfig {
  const base =
    MODEL_FAMILY_CONFIGS.find(config => config.id === familyId) ??
    (familyId.startsWith('codex-provider:')
      ? MODEL_FAMILY_CONFIGS.find(config => config.id === 'codex-provider')
      : familyId.startsWith('model-interface:')
        ? MODEL_FAMILY_CONFIGS.find(config => config.id === 'model-interface')
        : null)
  const resolved = base ?? {
    id: familyId,
    label: familyId.replace(/^\w/, letter => letter.toUpperCase()),
    order: 100,
    controls: [],
  }
  return {
    ...resolved,
    id: familyId,
    label: label || resolved.label,
  }
}

function familyOrderValue(familyId: string, configuredOrder: number): number {
  const exactOrder = FAMILY_ORDER.indexOf(familyId)
  if (exactOrder >= 0) return exactOrder

  const baseFamilyId = familyId.split(':', 1)[0]
  const baseOrder = FAMILY_ORDER.indexOf(baseFamilyId)
  return baseOrder >= 0 ? baseOrder : configuredOrder
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

function getSupportedReasoningEfforts(ui: Record<string, unknown>): string[] {
  const values = ui.reasoningEfforts ?? ui.supportedReasoningEfforts
  if (!Array.isArray(values)) return []
  return values
    .filter((value): value is string => typeof value === 'string')
    .map(value => normalizeModelOptionValue('reasoning', value) ?? value)
}

export function getModelUiMetadata(model: UnifiedModel): ModelUiMetadata {
  const ui = getConfigUi(model)
  const modelLabel =
    typeof ui.modelLabel === 'string' && ui.modelLabel.trim()
      ? ui.modelLabel.trim()
      : stripRegionPrefix(model.displayName || model.modelId || model.name)
  const sortOrder = typeof ui.sortOrder === 'number' ? ui.sortOrder : 100
  const familyLabel =
    typeof ui.familyLabel === 'string' && ui.familyLabel.trim() ? ui.familyLabel.trim() : undefined

  return {
    family: inferModelFamily(model),
    familyLabel,
    region: inferRegion(model),
    modelLabel,
    sortOrder,
    supportedControls: getExplicitSupportedControls(ui),
    supportedReasoningEfforts: getSupportedReasoningEfforts(ui),
    defaultReasoningEffort:
      typeof ui.defaultReasoningEffort === 'string'
        ? normalizeModelOptionValue('reasoning', ui.defaultReasoningEffort)
        : undefined,
  }
}

export function getControlsForModel(model: UnifiedModel | null): ModelControlConfig[] {
  if (!model) return []
  const metadata = getModelUiMetadata(model)
  const familyConfig = getFamilyConfig(metadata.family, metadata.familyLabel)
  return familyConfig.controls
    .filter(control => {
      if ((control.scope ?? 'family') === 'family') return true
      return metadata.supportedControls.has(control.id)
    })
    .map(control => {
      if (control.id !== 'reasoning') return control
      const supportedValues = new Set(metadata.supportedReasoningEfforts)
      const options = control.options.filter(option => {
        if (supportedValues.size > 0) return supportedValues.has(option.value)
        return !['max', 'ultra'].includes(option.value)
      })
      const configuredDefault = metadata.defaultReasoningEffort
      const defaultValue = options.some(option => option.value === configuredDefault)
        ? configuredDefault
        : options.some(option => option.value === control.defaultValue)
          ? control.defaultValue
          : options[0]?.value
      return {
        ...control,
        defaultValue: defaultValue ?? control.defaultValue,
        options,
      }
    })
}

export function getModelDisplayLabel(
  model: UnifiedModel | null,
  options: ModelOptions = {},
  resolveLabel?: LabelResolver
): string {
  if (!model) return ''

  const metadata = getModelUiMetadata(model)
  const controls = getControlsForModel(model)
  const regionLabel = metadata.region ? (REGION_LABELS[metadata.region] ?? metadata.region) : ''
  const controlLabels = controls
    .filter(control => control.includeInLabel !== 'never')
    .map(control => {
      const selected = selectedControlValue(control, options)
      if (control.includeInLabel === 'whenNonDefault' && selected === control.defaultValue) {
        return ''
      }
      return resolveOptionSummaryLabel(
        control.options.find(option => option.value === selected),
        resolveLabel
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
  resolveLabel?: LabelResolver
): string {
  if (!option) return ''
  return option.labelKey && resolveLabel
    ? resolveLabel(option.labelKey, option.label)
    : option.label
}

function resolveOptionSummaryLabel(
  option: ModelControlOption | undefined,
  resolveLabel?: LabelResolver
): string {
  if (!option) return ''
  return option.summaryLabel || resolveOptionLabel(option, resolveLabel)
}

export function normalizeModelOptionValue(optionId: string, value?: string): string | undefined {
  if (!value) return value
  if (optionId !== 'reasoning') return value

  const normalized = value.trim().toLowerCase().replace(/\s+/g, '_')
  if (['extra_high', 'x_high', 'x-high'].includes(normalized)) {
    return 'xhigh'
  }
  if (normalized === 'maximum') return 'max'
  return value
}

export function normalizeModelOptionAliases(options: ModelOptions = {}): ModelOptions {
  return Object.fromEntries(
    Object.entries(options).map(([optionId, value]) => [
      optionId,
      normalizeModelOptionValue(optionId, value) ?? value,
    ])
  )
}

function selectedControlValue(control: ModelControlConfig, options: ModelOptions): string {
  const selected = normalizeModelOptionValue(control.id, options[control.id])
  return control.options.some(option => option.value === selected)
    ? selected!
    : control.defaultValue
}

export function getSelectedModelDisplayLabel(
  model: UnifiedModel | null,
  options: ModelOptions = {},
  resolveLabel?: LabelResolver
): string {
  if (!model) return ''

  const metadata = getModelUiMetadata(model)
  const controls = getControlsForModel(model)
  const regionLabel = metadata.region ? (REGION_LABELS[metadata.region] ?? metadata.region) : ''
  const controlLabels = controls
    .map(control => {
      const selected = selectedControlValue(control, options)
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
        resolveLabel
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
    getControlsForModel(model)
      .filter(control => control.persistDefault !== false)
      .map(control => [control.id, control.defaultValue])
  )
}

export function normalizeModelOptions(
  model: UnifiedModel | null,
  options: ModelOptions
): ModelOptions {
  if (!model) return {}
  return Object.fromEntries(
    getControlsForModel(model)
      .filter(control => control.persistDefault !== false || options[control.id] !== undefined)
      .map(control => [control.id, selectedControlValue(control, options)])
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
  const groups = new Map<string, { models: UnifiedModel[]; familyLabel?: string }>()
  for (const model of models) {
    const metadata = getModelUiMetadata(model)
    const family = metadata.family
    if (HIDDEN_MODEL_FAMILIES.has(family)) continue
    const group = groups.get(family)
    groups.set(family, {
      models: [...(group?.models ?? []), model],
      familyLabel: group?.familyLabel ?? metadata.familyLabel,
    })
  }

  return [...groups.entries()]
    .map(([familyId, group]) => ({
      config: getFamilyConfig(familyId, group.familyLabel),
      models: [...group.models].sort((a, b) => {
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
      const normalizedLeft = familyOrderValue(a.config.id, a.config.order)
      const normalizedRight = familyOrderValue(b.config.id, b.config.order)
      return normalizedLeft - normalizedRight || a.config.label.localeCompare(b.config.label)
    })
}

export function isSupportedModelFamily(model: UnifiedModel): boolean {
  return Boolean(model.name)
}
