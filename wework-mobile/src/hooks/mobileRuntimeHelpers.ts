import * as Crypto from 'expo-crypto'
import { allWorkspaces } from '@/domain/work'
import { runtimeTaskKey } from '@/domain/runtimeTaskLifecycle'
import type { RuntimeTaskAddress, RuntimeWorkListResponse } from '@/types/runtime'

export function runtimeTaskRunning(
  address: RuntimeTaskAddress,
  work: RuntimeWorkListResponse,
  runningByTask: ReadonlyMap<string, boolean>
): boolean {
  const projected = runningByTask.get(runtimeTaskKey(address))
  if (typeof projected === 'boolean') return projected
  return allWorkspaces(work).some(
    workspace =>
      workspace.deviceId === address.deviceId &&
      workspace.tasks.some(task => task.taskId === address.taskId && task.running === true)
  )
}

export function sameRuntimeAddress(
  current: RuntimeTaskAddress | null,
  candidate: RuntimeTaskAddress
): boolean {
  return current?.deviceId === candidate.deviceId && current.taskId === candidate.taskId
}

export function createRuntimeTaskId(): string {
  const seed = `codex-${Crypto.randomUUID()}`
  let hash = 0
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) >>> 0
  return `runtime-${(hash % 1_000_000_000) + 1}`
}

export function titleFrom(message: string): string {
  const normalized = message.replace(/\s+/g, ' ').trim()
  return Array.from(normalized).slice(0, 48).join('') || '新会话'
}

export function messageFrom(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}
