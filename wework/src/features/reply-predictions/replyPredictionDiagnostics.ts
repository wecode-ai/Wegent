import {
  isConversationDiagnosticsEnabled,
  recordConversationDiagnostic,
} from '@wegent/collaboration/conversation/conversationDiagnostics'
import type { ReplyPredictionSource } from './replyPredictionService'

export interface PredictionEffectDiagnosticContext {
  api: object | undefined
  service: object | null
  source: ReplyPredictionSource | null
  key: string
  busy: boolean
  enabled: boolean
}

const identities = new WeakMap<object, number>()
let nextIdentity = 1

function identity(value: object | null | undefined): number {
  if (!value) return 0
  let id = identities.get(value)
  if (id === undefined) {
    id = nextIdentity++
    identities.set(value, id)
  }
  return id
}

// Match the renderer's existing FNV diagnostic fingerprints without logging their input.
function fingerprint(value: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== 'object') return value
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, canonical(item)])
  )
}

export function recordPredictionEffect(
  phase: 'start' | 'cleanup',
  provider: object,
  context: PredictionEffectDiagnosticContext,
  next?: PredictionEffectDiagnosticContext | null
): void {
  if (!isConversationDiagnosticsEnabled()) return
  const model = context.source?.modelSelection
  recordConversationDiagnostic(`reply-prediction-effect-${phase}`, {
    predictionProviderId: identity(provider),
    predictionApiId: identity(context.api),
    predictionServiceId: identity(context.service),
    predictionScopeHash: fingerprint(context.source?.scope ?? ''),
    predictionKeyHash: fingerprint(context.key),
    predictionModelHash: fingerprint(JSON.stringify(model) ?? 'undefined'),
    predictionModelSemanticHash: fingerprint(JSON.stringify(canonical(model)) ?? 'undefined'),
    predictionTurnHash: fingerprint(context.source?.latestTurnId ?? ''),
    modelFieldOrder: Object.keys(model ?? {}).join(','),
    optionFieldOrder: Object.keys(model?.options ?? {}).join(','),
    eligible: Boolean(context.service && context.source && !context.busy),
    enabled: context.enabled,
    busy: context.busy,
    ...(phase === 'cleanup'
      ? {
          unmounted: !next,
          apiChanged: Boolean(next && context.api !== next.api),
          serviceChanged: Boolean(next && context.service !== next.service),
          scopeChanged: Boolean(next && context.source?.scope !== next.source?.scope),
          keyChanged: Boolean(next && context.key !== next.key),
          busyChanged: Boolean(next && context.busy !== next.busy),
        }
      : {}),
  })
}

export function recordPredictionService(
  action: 'retain' | 'release' | 'request' | 'invalidate' | 'abort' | 'settled',
  api: object,
  service: object,
  scope: string,
  ownerCount: number,
  key?: string,
  details: Record<string, boolean> = {}
): void {
  if (!isConversationDiagnosticsEnabled()) return
  recordConversationDiagnostic(`reply-prediction-${action}`, {
    predictionApiId: identity(api),
    predictionServiceId: identity(service),
    predictionScopeHash: fingerprint(scope),
    ...(key === undefined ? {} : { predictionKeyHash: fingerprint(key) }),
    ownerCount,
    ...details,
  })
}
