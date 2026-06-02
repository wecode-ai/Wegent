// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

interface UseChatTransientStateOptions {
  selectedTaskId?: number | null
}

export function useChatTransientState({ selectedTaskId }: UseChatTransientStateOptions) {
  const [pendingTaskId, setPendingTaskId] = useState<number | null>(null)

  const previousTaskIdRef = useRef<number | null | undefined>(undefined)

  const resetStreamingState = useCallback(() => {
    setPendingTaskId(null)
  }, [])

  const effectiveTaskIdForState = useMemo(
    () => selectedTaskId || pendingTaskId || undefined,
    [pendingTaskId, selectedTaskId]
  )

  useEffect(() => {
    const currentTaskId = selectedTaskId ?? null

    if (pendingTaskId && currentTaskId && currentTaskId !== pendingTaskId) {
      setPendingTaskId(null)
    }

    if (!currentTaskId && !pendingTaskId) {
      resetStreamingState()
    }

    const previousTaskId = previousTaskIdRef.current
    if (
      previousTaskId !== undefined &&
      currentTaskId !== previousTaskId &&
      previousTaskId !== null
    ) {
      resetStreamingState()
    }

    previousTaskIdRef.current = currentTaskId
  }, [pendingTaskId, resetStreamingState, selectedTaskId])

  return {
    pendingTaskId,
    setPendingTaskId,
    resetStreamingState,
    effectiveTaskIdForState,
  }
}
