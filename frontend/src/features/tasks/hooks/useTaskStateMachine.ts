// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * useTaskStateMachine Hook
 *
 * React hook for using TaskStateMachine with automatic state synchronization.
 */

import { useEffect, useReducer, useMemo, useCallback } from 'react'
import {
  taskStateManager,
  type TaskStateMachine,
  type TaskStateData,
  type RecoverOptions,
  type UnifiedMessage,
} from '../state'

/**
 * Hook result type
 */
export interface UseTaskStateMachineResult {
  /** The TaskStateMachine instance */
  machine: TaskStateMachine | undefined
  /** Current state snapshot */
  state: TaskStateData | undefined
  /** Current status */
  status: TaskStateData['status'] | undefined
  /** All messages as Map */
  messages: Map<string, UnifiedMessage>
  /** All messages as sorted array */
  messagesArray: UnifiedMessage[]
  /** Whether currently streaming */
  isStreaming: boolean
  /** Current error */
  error: string | null
  /** Trigger recovery */
  recover: (options?: RecoverOptions) => Promise<void>
}

/**
 * Sort messages by messageId (primary) and timestamp (fallback)
 */
function sortMessages(messages: Map<string, UnifiedMessage>): UnifiedMessage[] {
  return Array.from(messages.values()).sort((a, b) => {
    // Primary sort by messageId (database order)
    if (a.messageId !== undefined && b.messageId !== undefined) {
      return a.messageId - b.messageId
    }
    // If one has messageId and other doesn't, messageId takes precedence
    if (a.messageId !== undefined) return -1
    if (b.messageId !== undefined) return 1
    // Fallback to timestamp
    return a.timestamp - b.timestamp
  })
}

/**
 * useTaskStateMachine Hook
 *
 * Provides reactive access to TaskStateMachine state.
 * Automatically subscribes to state changes and triggers re-renders.
 *
 * @param taskId - Task ID (undefined for no task)
 * @returns Hook result with state and methods
 */
export function useTaskStateMachine(taskId: number | undefined): UseTaskStateMachineResult {
  // Force update trigger
  const [, forceUpdate] = useReducer(x => x + 1, 0)

  // Get or create TaskStateMachine
  const machine = useMemo(() => {
    if (!taskId) return undefined
    return taskStateManager.getOrCreate(taskId)
  }, [taskId])

  // Subscribe to state changes
  useEffect(() => {
    if (!machine) return

    const unsubscribe = machine.subscribe(() => {
      forceUpdate()
    })

    return unsubscribe
  }, [machine])

  // Get current state
  const state = machine?.state

  // Memoize messages array
  const messagesArray = useMemo(() => {
    if (!state?.messages) return []
    return sortMessages(state.messages)
  }, [state?.messages])

  // Memoize recover function
  const recover = useCallback(
    async (options?: RecoverOptions) => {
      if (machine) {
        await machine.recover(options)
      }
    },
    [machine]
  )

  return {
    machine,
    state,
    status: state?.status,
    messages: state?.messages ?? new Map(),
    messagesArray,
    isStreaming: machine?.isStreaming ?? false,
    error: state?.error ?? null,
    recover,
  }
}

export default useTaskStateMachine
