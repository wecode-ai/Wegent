// SPDX-FileCopyrightText: 2025 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

// Common types shared across multiple API modules

export interface RunningTaskInfo {
  task_id: number
  task_name: string
  task_title: string
  status: string
  team_name?: string // Optional: present in bot running tasks
}

export interface CheckRunningTasksResponse {
  has_running_tasks: boolean
  running_tasks_count: number
  running_tasks: RunningTaskInfo[]
}
