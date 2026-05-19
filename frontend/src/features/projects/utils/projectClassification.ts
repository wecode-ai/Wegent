// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { Project } from '@/types/api'

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

export function canStartProjectConversation(project: ProjectConfigSource): boolean {
  return isWorkspaceProject(project)
}
