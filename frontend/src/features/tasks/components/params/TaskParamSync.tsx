// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect, useRef } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { useTaskSession } from '@/features/tasks/session/TaskSession'
import type { Task } from '@/types/api'
import { useToast } from '@/hooks/use-toast'

/**
 * Listen to the taskId parameter in the URL and automatically set selectedTask
 *
 * IMPORTANT: This component should ONLY respond to URL changes, not to selectedTaskDetail changes.
 * The selectedTaskDetail is used via ref to avoid unnecessary effect re-runs that could cause
 * race conditions when user clicks "New Task" button.
 */
export default function TaskParamSync() {
  const { toast } = useToast()
  const searchParams = useSearchParams()
  const { selectedTask, selectedTaskDetail, selectTask } = useTaskSession()

  const router = useRouter()

  // Use refs to track selected task state without triggering effect re-runs
  // This prevents race conditions when user clicks "New Task" button
  const selectedTaskRef = useRef(selectedTask)
  selectedTaskRef.current = selectedTask
  const selectedTaskDetailRef = useRef(selectedTaskDetail)
  selectedTaskDetailRef.current = selectedTaskDetail

  useEffect(() => {
    // Support multiple URL parameter formats for taskId
    const taskId =
      searchParams.get('taskId') || searchParams.get('task_id') || searchParams.get('taskid')

    // If no taskId in URL, clear selection
    // Use ref to check current state without adding to dependencies
    if (!taskId) {
      if (selectedTaskRef.current || selectedTaskDetailRef.current) {
        selectTask(null)
      }
      return
    }

    // If taskId in URL already matches selected task, do nothing
    const currentTaskId = selectedTaskRef.current?.id ?? selectedTaskDetailRef.current?.id
    if (String(currentTaskId) === taskId) {
      return
    }

    // If taskId is present but doesn't match, verify and set it
    const verifyAndSetTask = async () => {
      try {
        // Allow completed tasks to be selected, users should be able to view details of any task
        // If it exists, set it. The context will handle fetching the full detail.
        selectTask({ id: Number(taskId) } as Task)
      } catch {
        toast({
          variant: 'destructive',
          title: 'Task not found',
        })
        const url = new URL(window.location.href)
        url.searchParams.delete('taskId')
        router.replace(url.pathname + url.search)
      }
    }

    verifyAndSetTask()
    // IMPORTANT: selectedTaskDetail is intentionally NOT in the dependency array
    // This effect should only run when URL changes, not when task detail changes
    // Using ref to access current value without triggering re-runs
  }, [searchParams, router, selectTask, toast])

  return null // Only responsible for synchronization, does not render any content
}
