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
  requestedMode?: string | null
}

export function resolveChatPageTaskType({
  taskId,
  selectedTask,
  selectedDeviceId,
  isCodeAgentMode,
  requestedMode,
}: ChatPageTaskModeInput): TaskType {
  const selectedTaskMatchesUrl = !!taskId && String(selectedTask?.id) === taskId

  if (selectedTaskMatchesUrl && selectedTask) {
    if (
      selectedTask.task_type === 'task' ||
      selectedTask.task_type === 'code' ||
      selectedTask.task_type === 'video' ||
      selectedTask.task_type === 'image'
    ) {
      return selectedTask.task_type
    }
    return 'chat'
  }

  // While an existing task is loading, do not let a stale global device
  // selection change its execution mode.
  if (taskId) {
    if (requestedMode === 'video' || requestedMode === 'image') {
      return requestedMode
    }
    return isCodeAgentMode ? 'code' : 'chat'
  }

  if (requestedMode === 'video' || requestedMode === 'image') {
    return requestedMode
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

  return paths.chat.getHref()
}

export function getTaskTargetHref(task: TaskRouteTarget): string {
  const params = new URLSearchParams()
  if (task.task_type === 'video' || task.task_type === 'image') {
    params.set('mode', task.task_type)
  }
  params.set('taskId', String(task.id))
  return `${getTaskTargetPath(task)}?${params.toString()}`
}
