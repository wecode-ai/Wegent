import type { ModelTypeEnum, UnifiedModel, VisionSidecarModelRef } from '@/apis/models'

type SidecarApiFormat = VisionSidecarModelRef['apiFormat']

function recordValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function normalized(value: unknown): string {
  return typeof value === 'string' ? value.trim().toLowerCase() : ''
}

export function visionSidecarApiFormat(model: UnifiedModel): SidecarApiFormat | null {
  const config = recordValue(model.config)
  const family = normalized(model.runtime?.family)
  if (
    family === 'openai.openai-responses' ||
    normalized(config?.protocol) === 'openai-responses' ||
    normalized(config?.apiFormat) === 'responses'
  ) {
    return 'openai-responses'
  }
  if (
    family === 'claude.anthropic-messages' ||
    normalized(config?.protocol) === 'anthropic-messages' ||
    normalized(config?.protocol) === 'claude'
  ) {
    return 'anthropic-messages'
  }
  if (
    family === 'openai.openai-chat-completions' ||
    normalized(config?.protocol) === 'openai-chat-completions' ||
    normalized(config?.protocol) === 'openai' ||
    normalized(config?.apiFormat) === 'chat/completions'
  ) {
    return 'openai-chat-completions'
  }
  return null
}

export function visionSidecarModelKey(model: UnifiedModel): string {
  return [model.type, model.namespace ?? 'default', model.resourceUserId ?? '', model.name].join(
    ':'
  )
}

export function visionSidecarModels(models: UnifiedModel[], currentName: string): UnifiedModel[] {
  return models.filter(model => {
    if (model.name === currentName || model.isActive === false) return false
    if (model.resourceUserId == null || model.modelCapabilities?.supportsImage !== true)
      return false
    return visionSidecarApiFormat(model) !== null
  })
}

export function visionSidecarRef(model: UnifiedModel): VisionSidecarModelRef | null {
  const apiFormat = visionSidecarApiFormat(model)
  if (!apiFormat || model.resourceUserId == null) return null
  return {
    modelName: model.name,
    modelType: model.type as ModelTypeEnum,
    namespace: model.namespace ?? 'default',
    resourceUserId: model.resourceUserId,
    apiFormat,
  }
}

export function matchesVisionSidecarRef(model: UnifiedModel, ref: VisionSidecarModelRef): boolean {
  return (
    model.name === ref.modelName &&
    model.type === ref.modelType &&
    (model.namespace ?? 'default') === ref.namespace &&
    model.resourceUserId === ref.resourceUserId
  )
}
