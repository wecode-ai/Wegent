import { runtimeTaskKey } from '@/domain/runtimeTaskLifecycle'
import type { RuntimeTaskAddress } from '@/types/runtime'
import type { MobileTelemetryResult } from './events'

const outcomes = new Map<string, MobileTelemetryResult>()
const MAX_OUTCOMES = 256

export function recordMobileTaskOutcome(address: RuntimeTaskAddress, eventName: string): void {
  const key = runtimeTaskKey(address)
  outcomes.delete(key)
  outcomes.set(key, terminalResult(eventName))
  if (outcomes.size > MAX_OUTCOMES) {
    const oldest = outcomes.keys().next().value
    if (oldest) outcomes.delete(oldest)
  }
}

export function takeMobileTaskOutcome(address: RuntimeTaskAddress): MobileTelemetryResult | null {
  const key = runtimeTaskKey(address)
  const result = outcomes.get(key) ?? null
  outcomes.delete(key)
  return result
}

export function clearMobileTaskOutcomes(): void {
  outcomes.clear()
}

function terminalResult(eventName: string): MobileTelemetryResult {
  const normalized = eventName.toLowerCase()
  if (normalized.includes('cancel')) return 'cancelled'
  if (normalized.includes('fail') || normalized === 'error' || normalized.includes('incomplete')) {
    return 'failure'
  }
  return 'success'
}
