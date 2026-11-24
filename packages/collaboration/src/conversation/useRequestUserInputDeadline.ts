import { useClock } from '../clock'
import type { RequestUserInputPayload } from '@wegent/chat-core/runtime'
import { hasRequestUserInputResponse } from '@wegent/chat-core/runtime-user-input'

export function requestUserInputExpired(payload: RequestUserInputPayload, now = Date.now()) {
  if (payload.interactionStatus && payload.interactionStatus !== 'pending') {
    return payload.interactionStatus === 'expired'
  }
  if (hasRequestUserInputResponse(payload)) return false
  return (
    typeof payload.expiresAtUnixMs === 'number' &&
    Number.isFinite(payload.expiresAtUnixMs) &&
    payload.expiresAtUnixMs <= now
  )
}

export function useRequestUserInputDeadline(payload: RequestUserInputPayload) {
  const deadline = payload.expiresAtUnixMs
  const settled =
    hasRequestUserInputResponse(payload) ||
    Boolean(payload.interactionStatus && payload.interactionStatus !== 'pending')
  const now = useClock(deadline !== undefined && !settled, { until: deadline })
  const expired = requestUserInputExpired(payload, now)

  const seconds = Math.max(0, Math.ceil(((deadline ?? now) - now) / 1000))
  const remainingTime =
    deadline === undefined || settled || expired
      ? null
      : `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
  return { expired, remainingTime }
}
