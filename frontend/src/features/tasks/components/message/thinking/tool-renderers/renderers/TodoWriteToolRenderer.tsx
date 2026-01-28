// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useTranslation } from '@/hooks/useTranslation'
import type { ToolRendererProps, ToolRenderResult, TodoWriteToolInput } from '../types'
import { ToolHeader } from '../components'
import TodoListDisplay from '../../components/TodoListDisplay'
import type { TodoItem } from '../../types'

/**
 * Renderer for TodoWrite tool
 */
export function TodoWriteToolRenderer(
  props: ToolRendererProps<TodoWriteToolInput>
): ToolRenderResult {
  const { t } = useTranslation('chat')
  const { toolName, input, isLoading } = props

  const todos = input?.todos || []
  const todoCount = todos.length
  const inProgressCount = todos.filter(todo => todo.status === 'in_progress').length
  const completedCount = todos.filter(todo => todo.status === 'completed').length

  const stats =
    todoCount > 0
      ? `${completedCount}/${todoCount} ${t('thinking.todo_status_completed') || 'completed'}`
      : undefined

  return {
    key: `${toolName}-${props.itemIndex}`,
    label: (
      <ToolHeader
        toolName={toolName}
        params={
          inProgressCount > 0
            ? `${inProgressCount} ${t('thinking.todo_status_in_progress') || 'in progress'}`
            : undefined
        }
        stats={stats}
        isLoading={isLoading}
      />
    ),
    children: (
      <div className="text-sm">
        {todos.length > 0 ? (
          <TodoListDisplay todos={todos as TodoItem[]} />
        ) : (
          <span className="text-text-tertiary text-xs">{t('thinking.no_todos') || 'No tasks'}</span>
        )}
      </div>
    ),
  }
}
