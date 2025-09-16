// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

'use client'

import { useEffect } from 'react'
import { useSearchParams, useRouter } from 'next/navigation'
import { useTaskContext } from '@/features/tasks/contexts/taskContext'
import { Task } from '@/types/api'
import { taskApis } from '@/apis/tasks'
import { App } from 'antd'

/**
 * Listen to the taskId parameter in the URL and automatically set selectedTask
 */
export default function TaskParamSync() {
  const { message } = App.useApp()
  const searchParams = useSearchParams()
  const { selectedTaskDetail, setSelectedTask } = useTaskContext()

  const router = useRouter()

  useEffect(() => {
    const taskId = searchParams.get('taskId')

    // If no taskId in URL, clear selection
    if (!taskId) {
      if (selectedTaskDetail) {
        setSelectedTask(null)
      }
      return
    }

    // If taskId in URL already matches selected task, do nothing
    if (String(selectedTaskDetail?.id) === taskId) {
      return
    }

    // If taskId is present but doesn't match, verify and set it
    const verifyAndSetTask = async () => {
      try {
        // Use getTask for a lighter check to see if the task exists
        const task = await taskApis.getTask(Number(taskId))
        
        // 允许已完成的任务被选中，用户应该能够查看任何任务的详情
        // If it exists, set it. The context will handle fetching the full detail.
        setSelectedTask({ id: Number(taskId) } as Task)
      } catch (err) {
        message.error('Task not found')
        const url = new URL(window.location.href)
        url.searchParams.delete('taskId')
        router.replace(url.pathname + url.search)
      }
    }

    verifyAndSetTask()
  }, [searchParams, selectedTaskDetail, router, setSelectedTask])

  return null // Only responsible for synchronization, does not render any content
}