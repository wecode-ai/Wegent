import { useCallback, useMemo, useState } from 'react'

export type GuidanceStatus = 'pending' | 'queued' | 'sending' | 'failed' | 'applied' | 'expired'

export interface GuidanceQueueItem {
  taskId: number
  guidanceId: string
  content: string
  status: GuidanceStatus
  createdAt: number
  error?: string
}

export interface EnqueueGuidanceInput {
  taskId: number
  guidanceId: string
  content: string
}

interface UseGuidanceQueueOptions {
  taskId?: number | null
}

export function useGuidanceQueue({ taskId }: UseGuidanceQueueOptions) {
  const [guidanceQueue, setGuidanceQueue] = useState<GuidanceQueueItem[]>([])

  const enqueueGuidance = useCallback((input: EnqueueGuidanceInput) => {
    const item: GuidanceQueueItem = {
      ...input,
      status: 'pending',
      createdAt: Date.now(),
    }

    setGuidanceQueue(current => [...current, item])
    return item
  }, [])

  const updateGuidance = useCallback(
    (guidanceId: string, updater: (item: GuidanceQueueItem) => GuidanceQueueItem) => {
      setGuidanceQueue(current =>
        current.map(item => (item.guidanceId === guidanceId ? updater(item) : item))
      )
    },
    []
  )

  const markGuidanceSending = useCallback(
    (guidanceId: string) => {
      updateGuidance(guidanceId, item => ({ ...item, status: 'sending', error: undefined }))
    },
    [updateGuidance]
  )

  const markGuidanceQueued = useCallback(
    (guidanceId: string) => {
      updateGuidance(guidanceId, item => ({ ...item, status: 'queued', error: undefined }))
    },
    [updateGuidance]
  )

  const markGuidanceFailed = useCallback(
    (guidanceId: string, error?: string) => {
      updateGuidance(guidanceId, item => ({ ...item, status: 'failed', error }))
    },
    [updateGuidance]
  )

  const markGuidanceApplied = useCallback((guidanceId: string) => {
    setGuidanceQueue(current => current.filter(item => item.guidanceId !== guidanceId))
  }, [])

  const markGuidanceExpired = useCallback(
    (guidanceId: string, error?: string) => {
      updateGuidance(guidanceId, item => ({ ...item, status: 'expired', error }))
    },
    [updateGuidance]
  )

  const cancelGuidance = useCallback((guidanceId: string) => {
    setGuidanceQueue(current =>
      current.filter(item => item.guidanceId !== guidanceId || item.status === 'sending')
    )
  }, [])

  const removeExpiredGuidance = useCallback((guidanceId?: string) => {
    setGuidanceQueue(current =>
      current.filter(item => {
        if (item.status !== 'expired') return true
        return guidanceId ? item.guidanceId !== guidanceId : false
      })
    )
  }, [])

  const activeGuidanceQueue = useMemo(() => {
    if (!taskId) return []
    return guidanceQueue.filter(item => item.taskId === taskId && item.status !== 'applied')
  }, [guidanceQueue, taskId])

  const expiredGuidance = useMemo(
    () => activeGuidanceQueue.filter(item => item.status === 'expired'),
    [activeGuidanceQueue]
  )

  return {
    guidanceQueue,
    activeGuidanceQueue,
    expiredGuidance,
    enqueueGuidance,
    markGuidanceSending,
    markGuidanceQueued,
    markGuidanceFailed,
    markGuidanceApplied,
    markGuidanceExpired,
    cancelGuidance,
    removeExpiredGuidance,
    enqueue: enqueueGuidance,
    markSending: markGuidanceSending,
    markQueued: markGuidanceQueued,
    markFailed: markGuidanceFailed,
    markApplied: markGuidanceApplied,
    markExpired: markGuidanceExpired,
  }
}
