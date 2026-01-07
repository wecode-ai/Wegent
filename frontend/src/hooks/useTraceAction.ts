// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Hook for tracing user actions with context information.
 *
 * Automatically includes user context (id, name) and task context (taskId, subtaskId)
 * in all traced actions.
 */

import { useCallback, useContext, useMemo } from 'react'
import { traceLocalAction, traceLocalActionSync } from '@/lib/telemetry'
import { useUser } from '@/features/common/UserContext'
import { TaskContext } from '@/features/tasks/contexts/taskContext'
import { Attributes, AttributeValue } from '@opentelemetry/api'

/**
 * Common attributes for all traced actions
 */
type TraceContext = Record<string, AttributeValue | undefined>

/**
 * Message type for copy/download tracing
 */
type MessageType = 'user' | 'ai'

/**
 * Hook that provides trace functions with automatic user and task context.
 *
 * @example
 * ```tsx
 * const { trace } = useTraceAction()
 *
 * // Simplest usage - predefined events
 * trace.copy('user')           // trace copy user message
 * trace.copy('ai', subtaskId)  // trace copy AI message with subtask
 * trace.download('ai')         // trace download
 *
 * // Custom event
 * trace.event('custom-action', { key: 'value' })
 *
 * // Wrap function execution
 * await trace.action('export-pdf', { pages: 10 }, async () => { ... })
 * ```
 */
export function useTraceAction() {
  const { user } = useUser()
  const taskContext = useContext(TaskContext)

  /**
   * Build common trace attributes from current context
   */
  const buildContextAttributes = useCallback((): TraceContext => {
    const attrs: TraceContext = {}

    // Add user context
    if (user) {
      attrs['user.id'] = user.id
      attrs['user.name'] = user.user_name
    }

    // Add task context if available
    if (taskContext?.selectedTaskDetail) {
      attrs['task.id'] = taskContext.selectedTaskDetail.id
    }

    return attrs
  }, [user, taskContext?.selectedTaskDetail])

  /**
   * Simple event tracing - records an event without wrapping a function.
   */
  const traceEvent = useCallback(
    (name: string, attributes?: Attributes): void => {
      const contextAttrs = buildContextAttributes()
      traceLocalActionSync(name, { ...contextAttrs, ...attributes }, () => {})
    },
    [buildContextAttributes]
  )

  /**
   * Trace an async action with automatic context
   */
  const traceAction = useCallback(
    async <T>(name: string, attributes: Attributes, fn: () => T | Promise<T>): Promise<T> => {
      const contextAttrs = buildContextAttributes()
      return traceLocalAction(name, { ...contextAttrs, ...attributes }, fn)
    },
    [buildContextAttributes]
  )

  /**
   * Trace a sync action with automatic context
   */
  const traceActionSync = useCallback(
    <T>(name: string, attributes: Attributes, fn: () => T): T => {
      const contextAttrs = buildContextAttributes()
      return traceLocalActionSync(name, { ...contextAttrs, ...attributes }, fn)
    },
    [buildContextAttributes]
  )

  /**
   * Trace an action with a specific subtask ID
   */
  const traceActionWithSubtask = useCallback(
    async <T>(
      name: string,
      subtaskId: number,
      attributes: Attributes,
      fn: () => T | Promise<T>
    ): Promise<T> => {
      const contextAttrs = buildContextAttributes()
      return traceLocalAction(name, { ...contextAttrs, 'subtask.id': subtaskId, ...attributes }, fn)
    },
    [buildContextAttributes]
  )

  /**
   * Create a traced version of an async function.
   * The trace is recorded when the function is called, regardless of success/failure.
   *
   * @param name - The name of the action
   * @param attributes - Attributes to add to the span (can be a function that receives args)
   * @returns A function that wraps the original function with tracing
   *
   * @example
   * ```tsx
   * // Simple usage - trace with static attributes
   * const handleShare = traced('share-task', { 'task.id': taskId })(async () => {
   *   await taskApis.shareTask(taskId);
   * });
   *
   * // With dynamic attributes based on function arguments
   * const handleCopy = traced('copy-link', (url) => ({ 'copy.url': url }))(async (url: string) => {
   *   await navigator.clipboard.writeText(url);
   * });
   * ```
   */
  const traced = useCallback(
    <TArgs extends unknown[], TReturn>(
      name: string,
      attributes?: Attributes | ((...args: TArgs) => Attributes)
    ) => {
      return (fn: (...args: TArgs) => TReturn | Promise<TReturn>) => {
        return async (...args: TArgs): Promise<TReturn> => {
          const contextAttrs = buildContextAttributes()
          const resolvedAttrs = typeof attributes === 'function' ? attributes(...args) : attributes
          return traceLocalAction(name, { ...contextAttrs, ...resolvedAttrs }, () => fn(...args))
        }
      }
    },
    [buildContextAttributes]
  )

  /**
   * Simplified trace API with predefined common events
   */
  const trace = useMemo(
    () => ({
      /**
       * Trace copy message event
       * @param messageType - 'user' or 'ai'
       * @param subtaskId - Optional subtask ID
       */
      copy: (messageType: MessageType, subtaskId?: number) => {
        traceEvent('copy-message', {
          'copy.type': `${messageType}-message`,
          'copy.message_type': messageType,
          ...(subtaskId && { 'subtask.id': subtaskId }),
        })
      },

      /**
       * Trace download message event
       * @param messageType - 'user' or 'ai'
       * @param subtaskId - Optional subtask ID
       */
      download: (messageType: MessageType, subtaskId?: number) => {
        traceEvent('download-message', {
          'download.message_type': messageType,
          ...(subtaskId && { 'subtask.id': subtaskId }),
        })
      },

      /**
       * Trace custom event
       * @param name - Event name
       * @param attributes - Optional attributes
       */
      event: traceEvent,

      /**
       * Trace async action with function wrapping
       * @param name - Action name
       * @param attributes - Attributes
       * @param fn - Function to execute
       */
      action: traceAction,

      /**
       * Trace sync action with function wrapping
       * @param name - Action name
       * @param attributes - Attributes
       * @param fn - Function to execute
       */
      actionSync: traceActionSync,
    }),
    [traceEvent, traceAction, traceActionSync]
  )

  return {
    // New simplified API
    trace,
    traced,
    // Legacy API (for backward compatibility)
    traceAction,
    traceActionSync,
    traceEvent,
    traceActionWithSubtask,
    buildContextAttributes,
  }
}

export default useTraceAction
