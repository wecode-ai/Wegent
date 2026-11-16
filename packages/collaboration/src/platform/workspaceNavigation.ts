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
  isDefault?: boolean
}

/** Parent labels reveal no workspace resources or membership capabilities. */
export function buildWorkspaceNavigation(
  workspaces: CollaborationWorkspace[],
  projects: CollaborationProject[],
  currentContext: CollaborationWorkspaceNavigationContext | null,
  defaultSpaceName?: string
): {
  workspaces: NavigationWorkspace[]
  projectsByWorkspace: Map<string, CollaborationProject[]>
} {
  const entries = new Map<string, NavigationWorkspace>(
    workspaces.map(workspace => [workspace.id, { workspace, canOpen: true }])
  )
  const localIds = new Set(
    workspaces.filter(workspace => workspace.location === 'local').map(workspace => workspace.id)
  )
  const defaultWorkspace = defaultSpaceName
    ? (workspaces.find(
        workspace =>
          workspace.is_system_default &&
          workspace.access_role === 'Owner' &&
          workspace.location === 'cloud'
      ) ?? workspaces.find(workspace => localIds.has(workspace.id)))
    : undefined
  const defaultId = defaultWorkspace?.id ?? 'collaboration-default-workspace'
  if (defaultSpaceName) {
    for (const id of localIds) entries.delete(id)
    entries.set(defaultId, {
      workspace: defaultWorkspace
        ? { ...defaultWorkspace, name: defaultSpaceName }
        : {
            id: defaultId,
            name: defaultSpaceName,
            location: 'cloud',
            public_id: '',
          },
      canOpen: Boolean(defaultWorkspace),
      isDefault: true,
    })
  }
  const projectsByWorkspace = new Map<string, CollaborationProject[]>()
  for (const project of projects) {
    const workspaceId =
      defaultSpaceName &&
      (!project.workspace_id ||
        localIds.has(project.workspace_id) ||
        (!entries.has(project.workspace_id) && !project.workspace_context))
        ? defaultId
        : project.workspace_id
    if (!workspaceId) continue
    const siblings = projectsByWorkspace.get(workspaceId)
    if (siblings) siblings.push(project)
    else projectsByWorkspace.set(workspaceId, [project])
    const context = project.workspace_context
    if (context && !localIds.has(context.id) && !entries.has(context.id)) {
      entries.set(context.id, {
        workspace: { ...context, location: 'cloud' },
        canOpen: false,
      })
    }
  }
  if (
    currentContext &&
    !(defaultSpaceName && localIds.has(currentContext.id)) &&
    !entries.has(currentContext.id)
  ) {
    entries.set(currentContext.id, {
      workspace: currentContext,
      canOpen: false,
    })
  }
  const priority = ({ workspace, isDefault }: NavigationWorkspace) =>
    isDefault ||
    (!defaultSpaceName && 'is_system_default' in workspace && workspace.is_system_default)
      ? 0
      : 1
  return {
    workspaces: [...entries.values()].sort((left, right) => priority(left) - priority(right)),
    projectsByWorkspace,
  }
}
