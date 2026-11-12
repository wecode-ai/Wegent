import { useCallback, useEffect, useState } from 'react'
import type { StandInExecutorApi } from '@/api/standIn'
import { savedConversationProvider } from '@/features/workbench/runtimeModelSelection'
import type { ModelSelectionConfig, RuntimeTaskAddress } from '@/types/api'

export function activeModelProviderFromHandle(
  handle: Record<string, unknown> | null | undefined,
  threadId: string | null | undefined
): string | null {
  const value = handle?.activeModelProvider
  if (!value || typeof value !== 'object') return null
  const identity = value as Record<string, unknown>
  return identity.threadId === threadId && typeof identity.provider === 'string'
    ? identity.provider.trim() || null
    : null
}

/** Resolve only legacy stand-in sessions that have no saved provider identity. */
export function useStandInActiveModelProvider({
  enabled,
  api,
  address,
  threadId,
  selection,
  runtimeHandle,
}: {
  enabled: boolean
  api: StandInExecutorApi | undefined
  address: RuntimeTaskAddress | null
  threadId: string | null | undefined
  selection: ModelSelectionConfig | null | undefined
  runtimeHandle: Record<string, unknown> | null | undefined
}) {
  const storedProvider = activeModelProviderFromHandle(runtimeHandle, threadId)
  const savedProvider = storedProvider ?? savedConversationProvider(selection)
  const key =
    enabled && address && threadId
      ? JSON.stringify([address.deviceId, address.taskId, threadId])
      : ''
  const [attempt, setAttempt] = useState(0)
  const [resolved, setResolved] = useState<{ key: string; provider?: string; failed?: boolean }>()
  const provider =
    storedProvider ?? (resolved?.key === key ? resolved.provider : null) ?? savedProvider
  const pending = Boolean(key && !provider)
  const failed = pending && resolved?.key === key && Boolean(resolved.failed)
  const refresh = useCallback(() => setAttempt(value => value + 1), [])
  const deviceId = address?.deviceId
  const taskId = address?.taskId
  const readTask = api?.readTask

  useEffect(() => {
    if (!key || savedProvider || !readTask || !deviceId || !taskId || !threadId) return
    let cancelled = false
    void readTask(deviceId, taskId, { resolveActiveProvider: true })
      .then(result => {
        if (cancelled) return
        const provider =
          result.success && result.task?.threadId === threadId
            ? activeModelProviderFromHandle(result.task.runtimeHandle, threadId)
            : null
        setResolved(provider ? { key, provider } : { key, failed: true })
      })
      .catch(() => {
        if (!cancelled) setResolved({ key, failed: true })
      })
    return () => {
      cancelled = true
    }
  }, [readTask, key, deviceId, taskId, threadId, savedProvider, attempt])

  return { provider, pending, failed, refresh }
}
