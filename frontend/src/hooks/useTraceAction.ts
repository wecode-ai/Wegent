// SPDX-FileCopyrightText: 2025 WeCode, Inc.
//
// SPDX-License-Identifier: Apache-2.0

/**
 * Hook for tracing user actions with context information.
 *
 * Automatically includes user context (id, name) and task context (taskId, subtaskId)
 * in all traced actions.
 */

import { useCallback, useContext } from 'react';
import { traceLocalAction, traceLocalActionSync } from '@/lib/telemetry';
import { useUser } from '@/features/common/UserContext';
import { TaskContext } from '@/features/tasks/contexts/taskContext';
import { Attributes, AttributeValue } from '@opentelemetry/api';

/**
 * Common attributes for all traced actions
 */
type TraceContext = Record<string, AttributeValue | undefined>;

/**
 * Hook that provides trace functions with automatic user and task context.
 *
 * @example
 * ```tsx
 * const { traceAction, traceActionSync } = useTraceAction()
 *
 * const handleCopy = async () => {
 *   await traceAction('copy-message', { 'message.content_length': text.length }, async () => {
 *     await navigator.clipboard.writeText(text)
 *   })
 * }
 * ```
 */
export function useTraceAction() {
  const { user } = useUser();
  const taskContext = useContext(TaskContext);

  /**
   * Build common trace attributes from current context
   */
  const buildContextAttributes = useCallback((): TraceContext => {
    const attrs: TraceContext = {};

    // Add user context
    if (user) {
      attrs['user.id'] = user.id;
      attrs['user.name'] = user.user_name;
    }

    // Add task context if available
    if (taskContext?.selectedTaskDetail) {
      attrs['task.id'] = taskContext.selectedTaskDetail.id;
    }

    return attrs;
  }, [user, taskContext?.selectedTaskDetail]);

  /**
   * Trace an async action with automatic context
   *
   * @param name - The name of the action (e.g., 'copy-message', 'export-pdf')
   * @param attributes - Additional attributes to add to the span
   * @param fn - The async function to execute
   * @returns The result of the function
   */
  const traceAction = useCallback(
    async <T>(name: string, attributes: Attributes, fn: () => T | Promise<T>): Promise<T> => {
      const contextAttrs = buildContextAttributes();
      return traceLocalAction(name, { ...contextAttrs, ...attributes }, fn);
    },
    [buildContextAttributes]
  );

  /**
   * Trace a sync action with automatic context
   *
   * @param name - The name of the action
   * @param attributes - Additional attributes to add to the span
   * @param fn - The sync function to execute
   * @returns The result of the function
   */
  const traceActionSync = useCallback(
    <T>(name: string, attributes: Attributes, fn: () => T): T => {
      const contextAttrs = buildContextAttributes();
      return traceLocalActionSync(name, { ...contextAttrs, ...attributes }, fn);
    },
    [buildContextAttributes]
  );

  /**
   * Trace an action with a specific subtask ID
   *
   * @param name - The name of the action
   * @param subtaskId - The subtask ID to include in the trace
   * @param attributes - Additional attributes to add to the span
   * @param fn - The async function to execute
   * @returns The result of the function
   */
  const traceActionWithSubtask = useCallback(
    async <T>(
      name: string,
      subtaskId: number,
      attributes: Attributes,
      fn: () => T | Promise<T>
    ): Promise<T> => {
      const contextAttrs = buildContextAttributes();
      return traceLocalAction(
        name,
        { ...contextAttrs, 'subtask.id': subtaskId, ...attributes },
        fn
      );
    },
    [buildContextAttributes]
  );

  return {
    traceAction,
    traceActionSync,
    traceActionWithSubtask,
    buildContextAttributes,
  };
}

export default useTraceAction;
