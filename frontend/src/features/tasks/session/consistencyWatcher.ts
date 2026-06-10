// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useCallback, useEffect, useRef } from 'react'
import { useSocket } from '@/contexts/SocketContext'
import { usePageVisibility } from '@/hooks/usePageVisibility'
import type { TaskStateMachine } from '../state'
import type { TaskRecoveryReason } from '../state'

const MIN_HIDDEN_DURATION_MS = 3000
const RUNTIME_HEALTH_TIMEOUT_MS = 5000
const NETWORK_ONLINE_RECOVERY_DELAY_MS = 500

const withTimeout = <T>(promise: Promise<T>, timeoutMs: number): Promise<T | void> => {
  return Promise.race([
    promise,
    new Promise<void>(resolve => {
      globalThis.setTimeout(resolve, timeoutMs)
    }),
  ])
}

interface ConsistencyWatcherOptions {
  taskId: number | null
  getMachine: () => TaskStateMachine | null
  refreshTasks: () => void
}

export function useConsistencyWatcher({
  taskId,
  getMachine,
  refreshTasks,
}: ConsistencyWatcherOptions): void {
  const { isConnected, onReconnect } = useSocket()
  const isCheckingRef = useRef(false)
  const hasConnectedOnceRef = useRef(false)
  const wasConnectedRef = useRef(false)

  const verifyCurrentTask = useCallback(
    async (reason: TaskRecoveryReason) => {
      if (!taskId || isCheckingRef.current) return

      const machine = getMachine()
      if (!machine || machine.getState().taskId !== taskId) return

      isCheckingRef.current = true
      try {
        if (reason === 'page-visible' || reason === 'websocket-reconnect') {
          refreshTasks()
        }
        const verification =
          reason === 'websocket-reconnect'
            ? machine.handleSocketConnected(reason)
            : machine.checkHealth(reason)
        await withTimeout(verification, RUNTIME_HEALTH_TIMEOUT_MS)
      } catch (error) {
        console.error('[consistencyWatcher] Runtime verification failed:', error)
      } finally {
        isCheckingRef.current = false
      }
    },
    [getMachine, refreshTasks, taskId]
  )

  usePageVisibility({
    minHiddenTime: MIN_HIDDEN_DURATION_MS,
    onVisible: (wasHiddenFor: number) => {
      if (wasHiddenFor >= MIN_HIDDEN_DURATION_MS) {
        void verifyCurrentTask('page-visible')
      }
    },
  })

  useEffect(() => {
    const wasConnected = wasConnectedRef.current

    if (isConnected) {
      const hasPendingSocketRecovery = getMachine()?.getState().phase === 'waiting_socket'
      if (!wasConnected && (hasConnectedOnceRef.current || hasPendingSocketRecovery)) {
        void verifyCurrentTask('websocket-reconnect')
      }
      hasConnectedOnceRef.current = true
    }

    wasConnectedRef.current = isConnected
  }, [getMachine, isConnected, verifyCurrentTask])

  useEffect(() => {
    return onReconnect(() => {
      void verifyCurrentTask('websocket-reconnect')
    })
  }, [onReconnect, verifyCurrentTask])

  useEffect(() => {
    if (typeof window === 'undefined') return

    let recoveryTimer: ReturnType<typeof globalThis.setTimeout> | null = null
    const handleOnline = () => {
      if (recoveryTimer) {
        globalThis.clearTimeout(recoveryTimer)
      }
      recoveryTimer = globalThis.setTimeout(() => {
        void verifyCurrentTask('websocket-reconnect')
      }, NETWORK_ONLINE_RECOVERY_DELAY_MS)
    }

    window.addEventListener('online', handleOnline)
    return () => {
      if (recoveryTimer) {
        globalThis.clearTimeout(recoveryTimer)
      }
      window.removeEventListener('online', handleOnline)
    }
  }, [verifyCurrentTask])
}
