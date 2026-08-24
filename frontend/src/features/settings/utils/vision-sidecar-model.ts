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

/** Whether a model can act as a vision sidecar for some other model. */
function visionSidecarCandidate(model: UnifiedModel): boolean {
  return (
    model.isActive !== false &&
    model.resourceUserId != null &&
    model.modelCapabilities?.supportsImage === true &&
    visionSidecarApiFormat(model) !== null
  )
}

/** Candidates offered for the model currently being edited. */
export function visionSidecarModels(models: UnifiedModel[], currentName: string): UnifiedModel[] {
  return models.filter(model => model.name !== currentName && visionSidecarCandidate(model))
}

/** Build the reference persisted on a primary model for this sidecar target. */
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

function matchesVisionSidecarRef(model: UnifiedModel, ref: VisionSidecarModelRef): boolean {
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
 * Choose the option that represents an already configured sidecar reference.
 *
 * Only a selectable candidate may claim its own option key. Any other target -- a
 * model that never declared image support, was deactivated, or is not published to
 * this surface -- is kept under the sentinel so it stays visible and survives a
 * save; such a reference still works at runtime, so discarding it here would
 * silently delete working configuration.
 */
export function initialVisionSidecarSelection(
  models: UnifiedModel[],
  ref: VisionSidecarModelRef
): { selectedKey: string; unresolvedRef: VisionSidecarModelRef | null } {
  const selected = models.find(
    model => visionSidecarCandidate(model) && matchesVisionSidecarRef(model, ref)
  )
  return selected
    ? { selectedKey: visionSidecarModelKey(selected), unresolvedRef: null }
    : { selectedKey: UNRESOLVED_VISION_SIDECAR_KEY, unresolvedRef: ref }
}

/**
 * Resolve the reference to persist for the currently selected sidecar option.
 *
 * `models` is the full loaded catalog rather than the offered candidates, so a key
 * chosen before an unrelated edit narrowed the candidate list still resolves.
 */
export function selectedVisionSidecarRef(
  enabled: boolean,
  selectedKey: string,
  models: UnifiedModel[],
  unresolvedRef: VisionSidecarModelRef | null
): VisionSidecarModelRef | undefined {
  if (!enabled) return undefined
  if (selectedKey === UNRESOLVED_VISION_SIDECAR_KEY) return unresolvedRef ?? undefined
  const selected = models.find(model => visionSidecarModelKey(model) === selectedKey)
  return selected ? (visionSidecarRef(selected) ?? undefined) : undefined
}
