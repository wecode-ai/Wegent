// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { paths } from '@/config/paths'
import type { TaskType } from '@/types/api'

export interface TaskRouteTarget {
  id: number
  task_type?: TaskType
  knowledge_base_id?: number | null
  git_repo?: string | null
}

interface ChatPageTaskModeInput {
  taskId?: string | null
  selectedTask?: Pick<TaskRouteTarget, 'id' | 'task_type'> | null
  selectedDeviceId?: string | null
  isCodeAgentMode: boolean
}

export function resolveChatPageTaskType({
  taskId,
  selectedTask,
  selectedDeviceId,
  isCodeAgentMode,
}: ChatPageTaskModeInput): TaskType {
  const selectedTaskMatchesUrl = !!taskId && String(selectedTask?.id) === taskId

  if (selectedTaskMatchesUrl && selectedTask) {
    if (selectedTask.task_type === 'task' || selectedTask.task_type === 'code') {
      return selectedTask.task_type
    }
    return 'chat'
  }

  // While an existing task is loading, do not let a stale global device
  // selection change its execution mode.
  if (taskId) {
    return isCodeAgentMode ? 'code' : 'chat'
  }

  if (selectedDeviceId) {
    return 'task'
  }

  return isCodeAgentMode ? 'code' : 'chat'
}

export function getTaskTargetPath(task: TaskRouteTarget): string {
  if (task.task_type === 'knowledge') {
    return task.knowledge_base_id
      ? `/knowledge/document/${task.knowledge_base_id}`
      : paths.wiki.getHref()
  }

  if (task.task_type === 'task') {
    return '/devices/chat'
  }

  if (task.task_type === 'video' || task.task_type === 'image') {
    return paths.generate.getHref()
  }

  return paths.chat.getHref()
}

export function getTaskTargetHref(task: TaskRouteTarget): string {
  const params = new URLSearchParams()
  params.set('taskId', String(task.id))
  return `${getTaskTargetPath(task)}?${params.toString()}`
}
