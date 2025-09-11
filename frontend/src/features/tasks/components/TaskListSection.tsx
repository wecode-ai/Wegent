// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { Task } from '@/types/api'
import TaskMenu from './TaskMenu'
import { FaRegCircleCheck, FaRegCircleStop, FaRegCircleXmark } from 'react-icons/fa6'

import { useTaskContext } from '@/features/tasks/contexts/taskContext'

interface TaskListSectionProps {
  tasks: Task[]
  title: string
}

import { useRouter } from 'next/navigation'
import { taskApis } from '@/apis/tasks'
import { paths } from '@/config/paths'

export default function TaskListSection({
  tasks,
  title,
}: TaskListSectionProps) {
  const router = useRouter()
  const { selectedTaskDetail, setSelectedTask, refreshTasks } = useTaskContext()
  const [hoveredTaskId, setHoveredTaskId] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)

  // Select task
  const handleTaskClick = (task: Task) => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search)
      params.set('taskId', String(task.id))
      router.push(`?${params.toString()}`)
    }
  }

  // Copy task ID
  const handleCopyTaskId = async (taskId: number) => {
    const textToCopy = taskId.toString()
    if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
      try {
        await navigator.clipboard.writeText(textToCopy)
        return
      } catch (err) {
        // eslint-disable-next-line no-console
        console.error('Copy failed', err)
      }
    }
    try {
      const textarea = document.createElement('textarea')
      textarea.value = textToCopy
      textarea.style.cssText = 'position:fixed;opacity:0'
      document.body.appendChild(textarea)
      textarea.select()
      document.execCommand('copy')
      document.body.removeChild(textarea)
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Fallback copy failed', err)
    }
  }

  // Delete task
  const handleDeleteTask = async (taskId: number) => {
    setLoading(true)
    try {
      await taskApis.deleteTask(taskId)
      setSelectedTask(null)
      if (typeof window !== 'undefined') {
        const url = new URL(window.location.href)
        url.searchParams.delete('taskId')
        router.replace(url.pathname + url.search)
        refreshTasks()
      }
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('Delete failed', err)
    } finally {
      setLoading(false)
    }
  }

  if (tasks.length === 0) return null

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'COMPLETED':
        return <FaRegCircleCheck className="w-4 h-4 text-gray-500" />
      case 'FAILED':
      case 'CANCELLED':
        return <FaRegCircleXmark className="w-4 h-4 text-gray-500" />
      case 'RUNNING':
        return <FaRegCircleStop className="w-4 h-4 text-gray-500" />
      default:
        return <FaRegCircleStop className="w-4 h-4 text-gray-500" />
    }
  }

  const formatTimeAgo = (dateString: string) => {
    const now = new Date()
    const date = new Date(dateString)
    const diffMs = now.getTime() - date.getTime()

    const MINUTE_MS = 60 * 1000
    const HOUR_MS = 60 * MINUTE_MS
    const DAY_MS = 24 * HOUR_MS

    if (diffMs < HOUR_MS) {
      return `${Math.floor(diffMs / MINUTE_MS)}m`
    } else if (diffMs < DAY_MS) {
      return `${Math.floor(diffMs / HOUR_MS)}h`
    } else {
      return `${Math.floor(diffMs / DAY_MS)}d`
    }
  }

  return (
    <div className="mb-2">
      <h3 className="text-xs font-medium text-gray-500 tracking-wide mb-1" style={{ fontSize: '10px' }}>{title}</h3>
      <div className="space-y-0">
        {tasks.map(task => {
          return (
            <div
              key={task.id}
              className={`flex items-center justify-between py-1 rounded hover:bg-[#21262d] cursor-pointer ${selectedTaskDetail?.id === task.id ? 'bg-[#21262d]' : ''}`}
              onClick={() => handleTaskClick(task)}
              onMouseEnter={() => setHoveredTaskId(task.id)}
              onMouseLeave={() => setHoveredTaskId(null)}
            >
              <div className="flex items-center space-x-2 flex-1 min-w-0">
                <div className="flex-shrink-0 w-4 h-4 flex items-center justify-center">
                  {getStatusIcon(task.status)}
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-xs text-gray-400 leading-tight truncate m-0">{task.title}</p>
                  <p className="text-xs text-gray-600 m-0">{formatTimeAgo(task.created_at)}</p>
                </div>
              </div>

              <div className="flex-shrink-0">
                {hoveredTaskId === task.id && (
                  <TaskMenu
                    taskId={task.id}
                    handleCopyTaskId={handleCopyTaskId}
                    handleDeleteTask={handleDeleteTask}
                  />
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  )
}