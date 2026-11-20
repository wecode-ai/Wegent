import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { useCallback, useMemo, useSyncExternalStore } from 'react'
import {
  createAsyncResource,
  getIdleResourceSnapshot,
  subscribeIdleResource,
} from '@wegent/chat-core/async-resource'
import type { StandInExecutorApi, StandInProcessingStatus } from '@/api/standIn'

interface ProcessingSnapshot {
  status: StandInProcessingStatus | null
  error: string | null
}

export function useStandInProcessingStatus(
  api: StandInExecutorApi | undefined,
  userId: number,
  deviceId: string,
  enabled: boolean
) {
  const resource = useMemo(
    () =>
      createAsyncResource<ProcessingSnapshot>(
        JSON.stringify([userId, deviceId]),
        async () => ({ status: await api!.processingStatus(userId, deviceId), error: null }),
        { refreshIntervalMs: 15_000, refreshOnSubscribe: true }
      ),
    [api, userId, deviceId]
  )
  const query = useSyncExternalStore(
    api && enabled ? resource.subscribe : subscribeIdleResource,
    resource.getSnapshot,
    getIdleResourceSnapshot
  )
  const setStatus = useCallback(
    (status: StandInProcessingStatus) => {
      resource.update(previous => ({
        status,
        error:
          resource.getSnapshot().status === 'error'
            ? getStandInErrorMessage(resource.getSnapshot().error)
            : (previous?.error ?? null),
      }))
    },
    [resource]
  )
  const setError = useCallback(
    (error: string | null) => {
      resource.update(previous => ({ status: previous?.status ?? null, error }))
    },
    [resource]
  )
  return {
    status: enabled ? (query.data?.status ?? null) : null,
    error: enabled
      ? query.status === 'error'
        ? getStandInErrorMessage(query.error)
        : (query.data?.error ?? null)
      : null,
    setStatus,
    setError,
  }
}
