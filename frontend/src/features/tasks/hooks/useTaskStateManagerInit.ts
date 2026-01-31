// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * useTaskStateManagerInit Hook
 *
 * Initializes TaskStateManager with SocketContext dependency.
 * Should be called once in the app root (e.g., in ChatStreamProvider).
 */

import { useEffect } from 'react'
import { useSocket } from '@/contexts/SocketContext'
import { taskStateManager } from '../state'

/**
 * Initialize TaskStateManager with socket context
 *
 * This hook sets up the connection between TaskStateManager and SocketContext,
 * and registers the reconnection handler.
 */
export function useTaskStateManagerInit(): void {
  const { joinTask, leaveTask, isConnected, onReconnect } = useSocket()

  // Set socket context for TaskStateManager
  useEffect(() => {
    taskStateManager.setSocketContext({
      joinTask,
      leaveTask,
      isConnected,
    })
  }, [joinTask, leaveTask, isConnected])

  // Handle WebSocket reconnection
  useEffect(() => {
    const unsubscribe = onReconnect(() => {
      console.log('[TaskStateManager] WebSocket reconnected, recovering all tasks...')
      taskStateManager.recoverAll({ force: true })
    })

    return unsubscribe
  }, [onReconnect])
}

export default useTaskStateManagerInit
