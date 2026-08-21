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

const WIRE_FORMAT_CONFIG_KEYS = ['apiFormat', 'api_format', 'wire_api']

/**
 * Upstream protocol detection rules, ordered by precedence.
 *
 * These rules must stay identical to Wework's `getCloudModelUpstreamApiFormat`
 * (wework/src/features/cloud-connection/modelExecution.ts): Wework re-derives the
 * upstream format from the same catalog fields, so any divergence here makes a
 * model silently unselectable as a vision sidecar.
 *
 * Bare families matter: models that only declare `env.model` (no `spec.protocol`)
 * are published with `runtime.family` of just `claude` or `openai`.
 */
const SIDECAR_API_FORMAT_RULES: {
  apiFormat: SidecarApiFormat
  families: string[]
  protocols: string[]
  wireFormats: string[]
}[] = [
  {
    apiFormat: 'openai-responses',
    families: ['openai.openai-responses'],
    protocols: ['openai-responses'],
    wireFormats: ['responses'],
  },
  {
    apiFormat: 'anthropic-messages',
    families: ['claude.anthropic-messages', 'claude'],
    protocols: ['anthropic-messages', 'claude'],
    wireFormats: [],
  },
  {
    apiFormat: 'openai-chat-completions',
    families: ['openai.openai-chat-completions', 'openai'],
    protocols: ['openai-chat-completions', 'openai'],
    wireFormats: ['chat/completions'],
  },
]

export function visionSidecarApiFormat(model: UnifiedModel): SidecarApiFormat | null {
  const config = recordValue(model.config)
  const family = normalized(model.runtime?.family)
  const protocol = normalized(config?.protocol)
  const wireFormats = WIRE_FORMAT_CONFIG_KEYS.map(key => normalized(config?.[key]))
  const rule = SIDECAR_API_FORMAT_RULES.find(
    candidate =>
      candidate.families.includes(family) ||
      candidate.protocols.includes(protocol) ||
      candidate.wireFormats.some(format => wireFormats.includes(format))
  )
  return rule?.apiFormat ?? null
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

/**
 * Option key for a configured sidecar whose target is not a selectable candidate.
 *
 * Real keys built by `visionSidecarModelKey` always contain separators, so this
 * sentinel cannot collide with one.
 */
export const UNRESOLVED_VISION_SIDECAR_KEY = '__unresolved-vision-sidecar__'

/**
 * Resolve the reference to persist for the currently selected sidecar option.
 *
 * Keeping the sentinel selectable makes an unresolvable reference survive a save:
 * a model whose target never declared image support is still honoured at runtime,
 * so dropping it here would silently discard working configuration.
 */
export function selectedVisionSidecarRef(
  enabled: boolean,
  selectedKey: string,
  candidates: UnifiedModel[],
  unresolvedRef: VisionSidecarModelRef | null
): VisionSidecarModelRef | undefined {
  if (!enabled) return undefined
  if (selectedKey === UNRESOLVED_VISION_SIDECAR_KEY) return unresolvedRef ?? undefined
  const selected = candidates.find(candidate => visionSidecarModelKey(candidate) === selectedKey)
  return selected ? (visionSidecarRef(selected) ?? undefined) : undefined
}
