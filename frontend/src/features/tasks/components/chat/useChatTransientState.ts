// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

interface UseChatTransientStateOptions {
  clearVersion: number
  selectedTaskId?: number | null
  setIsLoading: (value: boolean) => void
}

export function useChatTransientState({
  clearVersion,
  selectedTaskId,
  setIsLoading,
}: UseChatTransientStateOptions) {
  const [pendingTaskId, setPendingTaskId] = useState<number | null>(null)
  const [localPendingMessage, setLocalPendingMessage] = useState<string | null>(null)
  const [isAwaitingResponseStart, setIsAwaitingResponseStart] = useState(false)
  const [isCancelling, setIsCancelling] = useState(false)

  const previousTaskIdRef = useRef<number | null | undefined>(undefined)
  const previousClearVersionRef = useRef(clearVersion)

  const resetStreamingState = useCallback(() => {
    setLocalPendingMessage(null)
    setPendingTaskId(null)
    setIsAwaitingResponseStart(false)
  }, [])

  const effectiveTaskIdForState = useMemo(
    () => selectedTaskId || pendingTaskId || undefined,
    [pendingTaskId, selectedTaskId]
  )

  useEffect(() => {
    const currentTaskId = selectedTaskId ?? null

    if (clearVersion !== previousClearVersionRef.current) {
      previousClearVersionRef.current = clearVersion
      resetStreamingState()
      setIsLoading(false)
      setIsCancelling(false)
      previousTaskIdRef.current = currentTaskId
      return
    }

    if (pendingTaskId && currentTaskId && currentTaskId !== pendingTaskId) {
      setPendingTaskId(null)
    }

    if (!currentTaskId && !pendingTaskId) {
      resetStreamingState()
      setIsLoading(false)
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
  }, [clearVersion, pendingTaskId, resetStreamingState, selectedTaskId, setIsLoading])

  return {
    pendingTaskId,
    setPendingTaskId,
    localPendingMessage,
    setLocalPendingMessage,
    isAwaitingResponseStart,
    setIsAwaitingResponseStart,
    isCancelling,
    setIsCancelling,
    resetStreamingState,
    effectiveTaskIdForState,
  }
}

export function useClearAwaitingResponseOnActivity(
  isResponseActive: boolean,
  setIsAwaitingResponseStart: (value: boolean) => void
) {
  useEffect(() => {
    if (isResponseActive) {
      setIsAwaitingResponseStart(false)
    }
  }, [isResponseActive, setIsAwaitingResponseStart])
}
