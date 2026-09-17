import type { RuntimeName } from './runtime'

function stableRuntimeTaskId(value: string): number {
  let hash = 0
  for (const char of value) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0
  }
  return (hash % 1_000_000_000) + 1
}

export function createRuntimeTaskIdFromSeed(seed: string): string {
  return `runtime-${stableRuntimeTaskId(seed)}`
}

export function createRuntimeTaskId(runtime: RuntimeName): string {
  const prefix = runtime === 'codex' ? 'codex' : 'runtime'
  const randomId =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(36).slice(2)}`
  return `${prefix}-${randomId}`
}
