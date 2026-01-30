// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import type { ToolRendererProps } from '../../types'
import TodoListDisplay from '../TodoListDisplay'

/**
 * TodoWrite tool renderer
 * Displays the task list using existing TodoListDisplay component
 */
export function TodoWriteToolRenderer({ tool }: ToolRendererProps) {
  const { t } = useTranslation('chat')

  const input = tool.toolUse.details?.input as Record<string, unknown> | undefined
  const todos = input?.todos as
    | Array<{
        content: string
        status: 'pending' | 'in_progress' | 'completed'
        activeForm: string
      }>
    | undefined

  const output = (tool.toolResult?.details?.content || tool.toolResult?.details?.output) as
    | string
    | undefined
  const isError = tool.toolResult?.details?.is_error || tool.toolResult?.details?.error

  return (
    <div className="space-y-3">
      {/* Todo List */}
      {todos && Array.isArray(todos) && todos.length > 0 && (
        <div>
          <div className="text-xs font-medium text-text-secondary mb-2">
            {t('thinking.todo_list') || 'Task List'}
          </div>
          <TodoListDisplay todos={todos} />
        </div>
      )}

      {/* Result */}
      {output && (
        <div>
          <div
            className={`text-xs font-medium mb-1 ${
              isError ? 'text-yellow-600' : 'text-text-secondary'
            }`}
          >
            {isError ? t('thinking.tool_error') || 'Error' : 'Result'}
          </div>
          <div
            className={`text-xs p-2 rounded ${
              isError
                ? 'text-yellow-700 bg-yellow-50 border border-yellow-200'
                : 'text-text-tertiary bg-fill-tert'
            }`}
          >
            {output}
          </div>
        </div>
      )}

      {/* No output yet (streaming) */}
      {!output && tool.status === 'invoking' && (
        <div className="text-xs text-text-muted italic">
          {t('thinking.tool_executing') || 'Updating tasks...'}
        </div>
      )}
    </div>
  )
}

export default TodoWriteToolRenderer
