// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { ProjectTask, Task } from '@/types/api'

/** Project task summaries only need identity and ordering fields for @ mentions. */
export function projectTaskToMentionTask(task: ProjectTask): Task {
  return {
    id: task.task_id,
    project_id: task.project_id,
    title: task.task_title,
    team_id: 0,
    git_url: '',
    git_repo: '',
    git_repo_id: 0,
    git_domain: '',
    branch_name: '',
    prompt: '',
    status: task.task_status,
    progress: 0,
    batch: 0,
    result: {},
    error_message: '',
    user_id: 0,
    user_name: '',
    created_at: task.updated_at ?? '',
    updated_at: task.updated_at ?? '',
    completed_at: '',
    device_id: task.device_id ?? null,
    is_group_chat: task.is_group_chat,
  }
}

export function mergeTaskMentionTasks(
  tasks: Task[] | null | undefined,
  projectTaskGroups: Array<ProjectTask[] | null | undefined>
): Task[] {
  const merged = new Map((tasks ?? []).map(task => [task.id, task]))
  projectTaskGroups.forEach(projectTasks => {
    projectTasks?.forEach(task => {
      if (!merged.has(task.task_id)) {
        merged.set(task.task_id, projectTaskToMentionTask(task))
      }
    })
  })
  return [...merged.values()]
}
