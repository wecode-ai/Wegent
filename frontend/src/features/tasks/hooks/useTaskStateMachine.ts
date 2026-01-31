// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * useTaskStateMachine Hook
 *
 * React hook for using TaskStateMachine in components.
 * Handles subscription to state changes and provides convenient accessors.
 */

import { useState, useEffect, useCallback, useMemo } from 'react'
import { taskStateManager, TaskStateData, UnifiedMessage, SyncOptions } from '../state'

export interface UseTaskStateMachineResult {
  /** Current state data */
  state: TaskStateData | null
  /** Messages map */
  messages: Map<string, UnifiedMessage>
  /** Whether any message is streaming */
  isStreaming: boolean
  /** Current task status */
  status: TaskStateData['status'] | null
  /** Trigger recovery */
  recover: (options?: { subtasks?: unknown[]; force?: boolean }) => Promise<void>
  /** Whether the state machine is initialized */
  isInitialized: boolean
}

/**
 * Hook to use TaskStateMachine for a specific task
 */
export function useTaskStateMachine(
  taskId: number | undefined | null,
  syncOptions?: SyncOptions
): UseTaskStateMachineResult {
  const [state, setState] = useState<TaskStateData | null>(null)

  // Check if manager is initialized
  const isInitialized = taskStateManager.isInitialized()

  // Subscribe to state changes
  useEffect(() => {
    if (!taskId || !isInitialized) {
      setState(null)
      return
    }

    const machine = taskStateManager.getOrCreate(taskId)

    // Set sync options if provided
    // Note: Full syncOptions updates are handled by the separate useEffect below
    if (syncOptions) {
      machine.setSyncOptions(syncOptions)
    }

    // Get initial state
    setState(machine.getState())

    // Subscribe to updates
    const unsubscribe = machine.subscribe(newState => {
      setState(newState)
    })

    return () => {
      unsubscribe()
    }
    // We intentionally only list specific syncOptions properties to avoid unnecessary
    // re-subscriptions. Full syncOptions updates are handled by the separate useEffect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    taskId,
    isInitialized,
    syncOptions?.teamName,
    syncOptions?.isGroupChat,
    syncOptions?.currentUserId,
    syncOptions?.currentUserName,
  ])

  // Update sync options when they change
  useEffect(() => {
    if (!taskId || !isInitialized || !syncOptions) return

    const machine = taskStateManager.get(taskId)
    if (machine) {
      machine.setSyncOptions(syncOptions)
    }
  }, [taskId, isInitialized, syncOptions])

  // Recover function
  const recover = useCallback(
    async (options?: { subtasks?: unknown[]; force?: boolean }) => {
      if (!taskId || !isInitialized) return

      const machine = taskStateManager.getOrCreate(taskId)
      await machine.recover({
        subtasks: options?.subtasks as import('@/types/api').TaskDetailSubtask[],
        force: options?.force,
      })
    },
    [taskId, isInitialized]
  )

  // Computed values
  const messages = useMemo(() => state?.messages || new Map(), [state?.messages])

  const isStreaming = useMemo(() => {
    return state?.status === 'streaming'
  }, [state?.status])

  const status = state?.status || null

  return {
    state,
    messages,
    isStreaming,
    status,
    recover,
    isInitialized,
  }
}

export default useTaskStateMachine
