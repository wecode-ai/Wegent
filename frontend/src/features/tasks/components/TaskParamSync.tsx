// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import { taskApis } from '@/apis/tasks'
import { toast } from 'react-toastify'

/**
 * Listen to the taskId parameter in the URL and automatically set selectedTask
 */
export default function TaskParamSync() {
  const searchParams = useSearchParams()
  const { tasks, selectedTask, setSelectedTask, loadMore } = useTaskContext()

  const router = useRouter()

  useEffect(() => {
    const taskId = searchParams.get('taskId')
    if (taskId) {
      const found = tasks.find((t) => String(t.id) === String(taskId))
      if (found && (!selectedTask || found.id !== selectedTask.id)) {
        setSelectedTask(found)
      } else if (!found) {
        // If taskId exists but not found in tasks, check with backend
        const checkTask = async () => {
          try {
            await taskApis.getTaskDetail(Number(taskId))
            // If found in backend, force loadMore
            loadMore()
          } catch (err: any) {
            // If not found in backend, show toast and remove taskId param
            toast.error('Task not found')
            const url = new URL(window.location.href)
            url.searchParams.delete('taskId')
            router.replace(url.pathname + url.search)
          }
        }
        checkTask()
      }
    }
  }, [searchParams, tasks])

  return null // Only responsible for synchronization, does not render any content
}