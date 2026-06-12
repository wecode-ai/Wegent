// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useSocket } from '@/contexts/SocketContext'
import { usePageVisibility } from '@/hooks/usePageVisibility'
import type { TaskRecoveryReason, TaskStateMachine } from '@wegent/chat-core'

const MIN_HIDDEN_DURATION_MS = 3000

interface RuntimeSignalBridgeOptions {
  taskId: number | null
  getMachine: () => TaskStateMachine | null
  refreshTasks: () => void
}

export function useRuntimeSignalBridge({
  taskId,
  getMachine,
  refreshTasks,
}: RuntimeSignalBridgeOptions): void {
  const { isConnected, onReconnect } = useSocket()
  const hasConnectedOnceRef = useRef(false)
  const wasConnectedRef = useRef(false)

  const signalRuntime = useCallback(
    (reason: TaskRecoveryReason, shouldRefreshTasks: boolean = true) => {
      if (!taskId) return

      const machine = getMachine()
      if (!machine || machine.getState().taskId !== taskId) return

      if (shouldRefreshTasks) {
        refreshTasks()
      }
      void machine.requestRuntimeCheck(reason)
    },
    [getMachine, refreshTasks, taskId]
  )

  usePageVisibility({
    minHiddenTime: MIN_HIDDEN_DURATION_MS,
    onVisible: (wasHiddenFor: number) => {
      if (wasHiddenFor >= MIN_HIDDEN_DURATION_MS) {
        signalRuntime('page-visible')
      }
    },
  })

  useEffect(() => {
    const wasConnected = wasConnectedRef.current

    if (isConnected) {
      const hasPendingSocketRecovery = getMachine()?.getState().phase === 'waiting_socket'
      if (!wasConnected && (hasConnectedOnceRef.current || hasPendingSocketRecovery)) {
        signalRuntime('websocket-reconnect')
      }
      hasConnectedOnceRef.current = true
    }

    wasConnectedRef.current = isConnected
  }, [getMachine, isConnected, signalRuntime])

  useEffect(() => {
    return onReconnect(() => {
      signalRuntime('websocket-reconnect')
    })
  }, [onReconnect, signalRuntime])

  useEffect(() => {
    if (typeof window === 'undefined') return

    const handleOnline = () => {
      signalRuntime('network-online')
    }

    window.addEventListener('online', handleOnline)
    return () => {
      window.removeEventListener('online', handleOnline)
    }
  }, [signalRuntime])
}
