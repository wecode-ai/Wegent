// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { TodoListDisplayProps } from '../types'
import { TODO_STATUS_COLORS } from '../utils/constants'

/**
 * Component to display a todo list from TodoWrite tool
 */
const TodoListDisplay = memo(function TodoListDisplay({ todos }: TodoListDisplayProps) {
  const { t } = useTranslation('chat')

  if (!Array.isArray(todos) || todos.length === 0) {
    return null
  }

  return (
    <div className="rounded bg-blue-500/5 p-2 border border-blue-500/20">
      <div className="text-xs font-medium text-blue-400 mb-2">
        {t('thinking.todo_list') || 'Todo List'}
      </div>
      <div className="space-y-2">
        {todos.map((todo, idx) => {
          const statusColors = TODO_STATUS_COLORS[todo.status] || TODO_STATUS_COLORS.pending

          return (
            <div key={idx} className="flex items-start gap-2 p-2 bg-surface/50 rounded">
              <div className="flex-shrink-0 mt-0.5">
                {todo.status === 'in_progress' ? (
                  <div
                    className={`w-3 h-3 rounded-full ${statusColors.bg} animate-pulse`}
                    title={t('thinking.todo_status_in_progress') || 'In Progress'}
                  />
                ) : todo.status === 'completed' ? (
                  <div
                    className={`w-3 h-3 rounded-full ${statusColors.bg}`}
                    title={t('thinking.todo_status_completed') || 'Completed'}
                  />
                ) : (
                  <div
                    className={`w-3 h-3 rounded-full ${statusColors.bg}`}
                    title={t('thinking.todo_status_pending') || 'Pending'}
                  />
                )}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-xs text-text-secondary font-medium">{todo.content}</div>
                {todo.activeForm && (
                  <div className="text-xs text-text-tertiary mt-1 italic">{todo.activeForm}</div>
                )}
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
})

export default TodoListDisplay
