import type { RuntimeTaskAddress } from '@/types/api'

// Derives stable, opaque correlation identifiers for AI telemetry without
// exposing the underlying task id (a resource identifier) as an event
// property. The derivation is deterministic and one-way.
const FNV_OFFSET_BASIS = 0xcbf29ce484222325n
const FNV_PRIME = 0x100000001b3n

export function telemetryTraceId(seed: string): string {
  let hash = FNV_OFFSET_BASIS
  for (let index = 0; index < seed.length; index++) {
    hash = BigInt.asUintN(64, hash ^ BigInt(seed.charCodeAt(index)))
    hash = BigInt.asUintN(64, hash * FNV_PRIME)
  }
  return `t-${hash.toString(36)}`
}

// A task is a stable resource that can be run repeatedly (or watched from
// several windows). Hashing the task id alone would collapse every run of the
// task into a single PostHog trace, so each active run mints its own opaque
// trace id. Trace events and generations emitted while a run is active share
// the minted id; once the run settles the entry is removed and the next run
// mints a fresh one. The registry is per process/window, which keeps one run
// internally consistent even when two windows observe the same task.
const activeRunTraceIds = new Map<string, string>()

function runtimeRunKey(deviceId: string, taskId: string): string {
  return `${deviceId}\0${taskId}`
}

export function mintRuntimeRunTraceId(address: RuntimeTaskAddress): string {
  const key = runtimeRunKey(address.deviceId, address.taskId)
  const existing = activeRunTraceIds.get(key)
  if (existing) return existing
  const minted = telemetryTraceId(crypto.randomUUID())
  activeRunTraceIds.set(key, minted)
  return minted
}

export function activeRuntimeRunTraceId(address: RuntimeTaskAddress): string | undefined {
  return activeRunTraceIds.get(runtimeRunKey(address.deviceId, address.taskId))
}

export function settleRuntimeRunTraceId(address: RuntimeTaskAddress): void {
  activeRunTraceIds.delete(runtimeRunKey(address.deviceId, address.taskId))
}

export function resetRuntimeRunTraceIds(): void {
  activeRunTraceIds.clear()
}
