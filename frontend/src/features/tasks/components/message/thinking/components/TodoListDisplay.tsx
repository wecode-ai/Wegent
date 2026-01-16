// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { memo } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import type { TodoListDisplayProps } from '../types'

/**
 * Component to display a todo list from TodoWrite tool
 */
const TodoListDisplay = memo(function TodoListDisplay({ todos }: TodoListDisplayProps) {
  const { t } = useTranslation()

  if (!Array.isArray(todos) || todos.length === 0) {
    return null
  }

  return (
    <div>
      <div className="text-xs font-medium text-blue-400 mb-1">
        {t('chat:thinking.todo_list') || 'Todo List'}
      </div>
      <div className="space-y-0.5">
        {todos.map((todo, idx) => {
          return (
            <div key={idx} className="flex items-start gap-2 text-xs">
              <div className="flex-shrink-0 mt-0.5">
                {todo.status === 'completed' ? (
                  <span
                    className="text-green-400"
                    title={t('chat:thinking.todo_status_completed') || 'Completed'}
                  >
                    ☑
                  </span>
                ) : todo.status === 'in_progress' ? (
                  <span
                    className="text-blue-400 animate-pulse"
                    title={t('chat:thinking.todo_status_in_progress') || 'In Progress'}
                  >
                    ☐
                  </span>
                ) : (
                  <span
                    className="text-text-tertiary"
                    title={t('chat:thinking.todo_status_pending') || 'Pending'}
                  >
                    ☐
                  </span>
                )}
              </div>
              <div className="flex-1 min-w-0">
                <span
                  className={`${todo.status === 'completed' ? 'line-through text-text-tertiary' : 'text-text-secondary'}`}
                >
                  {todo.content}
                </span>
                {todo.activeForm && todo.status === 'in_progress' && (
                  <span className="text-blue-400 ml-1 italic">({todo.activeForm})</span>
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
