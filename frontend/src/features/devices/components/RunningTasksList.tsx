// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { DeviceRunningTask } from '@/apis/devices'
import { Button } from '@/components/ui/button'
import { cn, parseUTCDate } from '@/lib/utils'
import { ChevronDown, ChevronUp, X, Clock, Loader2 } from 'lucide-react'
import { useTranslation } from '@/hooks/useTranslation'
import { formatDistanceToNow } from 'date-fns'
import { zhCN, enUS } from 'date-fns/locale'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import { TaskStatus } from '@/types/api'

interface RunningTasksListProps {
  tasks: DeviceRunningTask[]
  deviceName: string
  onCancelTask?: (taskId: number) => Promise<void>
  className?: string
}

export function RunningTasksList({
  tasks,
  deviceName,
  onCancelTask,
  className,
}: RunningTasksListProps) {
  const { t, i18n } = useTranslation('devices')
  const router = useRouter()
  const { setSelectedTask } = useTaskContext()
  const [isExpanded, setIsExpanded] = useState(tasks.length > 0)
  const [cancellingTaskId, setCancellingTaskId] = useState<number | null>(null)
  const [taskToCancel, setTaskToCancel] = useState<DeviceRunningTask | null>(null)

  const handleCancelClick = (e: React.MouseEvent, task: DeviceRunningTask) => {
    e.stopPropagation() // Prevent triggering task click
    setTaskToCancel(task)
  }

  const handleTaskClick = (task: DeviceRunningTask) => {
    // Convert DeviceRunningTask to Task format for setSelectedTask
    setSelectedTask({
      id: task.task_id,
      title: task.title,
      team_id: 0,
      git_url: '',
      git_repo: '',
      git_repo_id: 0,
      git_domain: '',
      branch_name: '',
      prompt: '',
      status: task.status.toUpperCase() as TaskStatus,
      task_type: 'chat',
      progress: 0,
      batch: 0,
      result: {},
      error_message: '',
      user_id: 0,
      user_name: '',
      created_at: task.created_at || '',
      updated_at: '',
      completed_at: '',
      is_group_chat: false,
    })
    router.push(`/devices/chat?taskId=${task.task_id}`)
  }

  const handleConfirmCancel = async () => {
    if (!taskToCancel || !onCancelTask) return

    setCancellingTaskId(taskToCancel.task_id)
    try {
      await onCancelTask(taskToCancel.task_id)
    } finally {
      setCancellingTaskId(null)
      setTaskToCancel(null)
    }
  }

  const getStatusColor = (status: string) => {
    switch (status.toLowerCase()) {
      case 'running':
        return 'text-blue-600 bg-blue-50'
      case 'pending':
        return 'text-yellow-600 bg-yellow-50'
      default:
        return 'text-gray-600 bg-gray-50'
    }
  }

  const getStatusText = (status: string) => {
    switch (status.toLowerCase()) {
      case 'running':
        return t('task_status_running')
      case 'pending':
        return t('task_status_pending')
      default:
        return status
    }
  }

  const formatTime = (dateString?: string) => {
    if (!dateString) return ''
    try {
      const date = parseUTCDate(dateString)
      if (!date) return ''
      const locale = i18n.language.startsWith('zh') ? zhCN : enUS
      return formatDistanceToNow(date, { addSuffix: true, locale })
    } catch {
      return ''
    }
  }

  if (tasks.length === 0) {
    return null
  }

  return (
    <>
      <div className={cn('mt-2', className)}>
        {/* Expandable header */}
        <button
          onClick={() => setIsExpanded(!isExpanded)}
          className="w-full flex items-center justify-between px-3 py-2 text-sm text-text-secondary hover:bg-surface/50 rounded-md transition-colors"
        >
          <span className="font-medium">{t('running_tasks_count', { count: tasks.length })}</span>
          {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </button>

        {/* Tasks list */}
        {isExpanded && (
          <div className="mt-2 space-y-2">
            {tasks.map(task => (
              <div
                key={task.task_id}
                onClick={() => handleTaskClick(task)}
                className="flex items-center justify-between px-3 py-2 bg-surface rounded-md border border-border hover:border-primary hover:bg-primary/5 cursor-pointer transition-colors"
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <h4 className="text-sm font-medium text-text-primary truncate">{task.title}</h4>
                    <span
                      className={cn(
                        'px-2 py-0.5 text-xs font-medium rounded-full',
                        getStatusColor(task.status)
                      )}
                    >
                      {getStatusText(task.status)}
                    </span>
                  </div>
                  {task.created_at && (
                    <div className="flex items-center gap-1 mt-1 text-xs text-text-muted">
                      <Clock className="w-3 h-3" />
                      <span>{formatTime(task.created_at)}</span>
                    </div>
                  )}
                </div>
                {onCancelTask && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={e => handleCancelClick(e, task)}
                    disabled={cancellingTaskId === task.task_id}
                    className="ml-2 h-8 w-8 p-0 text-text-muted hover:text-red-600 hover:bg-red-50"
                  >
                    {cancellingTaskId === task.task_id ? (
                      <Loader2 className="w-4 h-4 animate-spin" />
                    ) : (
                      <X className="w-4 h-4" />
                    )}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Cancel confirmation dialog */}
      <AlertDialog open={!!taskToCancel} onOpenChange={() => setTaskToCancel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('close_session_confirm_title')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('close_session_confirm_description', {
                taskTitle: taskToCancel?.title || '',
                deviceName,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('common:actions.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleConfirmCancel}
              className="bg-red-600 hover:bg-red-700"
            >
              {t('common:actions.confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
