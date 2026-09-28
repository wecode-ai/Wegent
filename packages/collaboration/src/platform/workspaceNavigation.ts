// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type {
  CollaborationProject,
  CollaborationWorkspace,
  CollaborationWorkspaceNavigationContext,
} from '../types'

type NavigationWorkspace = {
  workspace: CollaborationWorkspace | CollaborationWorkspaceNavigationContext
  canOpen: boolean
}

/** Parent labels reveal no workspace resources or membership capabilities. */
export function buildWorkspaceNavigation(
  workspaces: CollaborationWorkspace[],
  projects: CollaborationProject[],
  currentContext: CollaborationWorkspaceNavigationContext | null,
): {
  workspaces: NavigationWorkspace[]
  projectsByWorkspace: Map<string, CollaborationProject[]>
} {
  const entries = new Map<string, NavigationWorkspace>(
    workspaces.map((workspace) => [workspace.id, { workspace, canOpen: true }]),
  )
  const projectsByWorkspace = new Map<string, CollaborationProject[]>()
  for (const project of projects) {
    if (!project.workspace_id) continue
    const siblings = projectsByWorkspace.get(project.workspace_id)
    if (siblings) siblings.push(project)
    else projectsByWorkspace.set(project.workspace_id, [project])
    const context = project.workspace_context
    if (context && !entries.has(context.id)) {
      entries.set(context.id, {
        workspace: { ...context, location: 'cloud' },
        canOpen: false,
      })
    }
  }
  if (currentContext && !entries.has(currentContext.id)) {
    entries.set(currentContext.id, {
      workspace: currentContext,
      canOpen: false,
    })
  }
  return { workspaces: [...entries.values()], projectsByWorkspace }
}
