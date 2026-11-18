import type { ConnectionEventSubscription } from '@/lib/runtime-connection-events'

export type ResourceObservationState = 'refreshing' | 'observing' | 'auth_required' | 'error'

export interface ResourceObservation {
  state: ResourceObservationState
  transport: 'poll' | 'connection'
  lastSuccessAt: string | number | null
  stale: boolean
  error?: string | null
}

export function observationFailureState(code: string | null | undefined): ResourceObservationState {
  return code && /auth_required|unauthenticated|account_changed/.test(code)
    ? 'auth_required'
    : 'error'
}

export function observationErrorCode(failure: unknown): string {
  if (
    failure &&
    typeof failure === 'object' &&
    'code' in failure &&
    typeof failure.code === 'string' &&
    failure.code
  )
    return failure.code
  return failure instanceof Error ? failure.message : 'connection_observation_failed'
}

export function connectionObservationHealth(
  subscription: ConnectionEventSubscription,
  resourceError?: string | null
): ResourceObservation {
  const error =
    subscription.error_code ??
    (resourceError === undefined
      ? Array.isArray(subscription.resource_states)
        ? subscription.resource_states.find(state => state.errorCode)?.errorCode
        : undefined
      : resourceError)
  return {
    state: error
      ? observationFailureState(error)
      : subscription.status === 'preparing' ||
          subscription.refresh_pending ||
          !subscription.last_collected_at
        ? 'refreshing'
        : 'observing',
    transport: 'connection',
    lastSuccessAt: subscription.last_collected_at ?? null,
    stale: Boolean(error),
    error,
  }
}

export function observationLabelKey(observation: ResourceObservation): string {
  return `workbench.observation_${observation.state}`
}

export const observationFallback: Record<ResourceObservationState, string> = {
  refreshing: '正在同步状态',
  observing: '状态同步正常',
  auth_required: '连接需要重新授权',
  error: '状态同步异常，请检查连接',
}
