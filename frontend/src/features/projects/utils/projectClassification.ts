// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Project, Task } from '@/types/api'

type ProjectConfigSource = Pick<Project, 'config'>

export function isWorkspaceProject(project: ProjectConfigSource): boolean {
  return project.config?.mode === 'workspace'
}

export function isPathlessProject(project: ProjectConfigSource): boolean {
  return !isWorkspaceProject(project)
}

export function canImportOrdinaryTaskToProject(project: ProjectConfigSource): boolean {
  return isPathlessProject(project)
}

export function isTaskInProject(
  task: Pick<Task, 'id' | 'project_id'>,
  projects: Project[],
  loadedProjectTaskIds: Set<number>,
  workspaceEnabled: boolean
): boolean {
  if (loadedProjectTaskIds.has(task.id)) return true
  return projects.some(
    project => project.id === task.project_id && (workspaceEnabled || !isWorkspaceProject(project))
  )
}
