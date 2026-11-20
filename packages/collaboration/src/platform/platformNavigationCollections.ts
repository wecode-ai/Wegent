// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import type { SharedWorkspaceApi } from '../ports/SharedWorkspaceApi'
import type {
  CollaborationGroup,
  CollaborationExecutionEnvironment,
  CollaborationWorkspaceMember,
  CollaborationOwnedAgent,
  CollaborationPlatformResources,
  CollaborationProject,
  CollaborationWorkspace,
  CollaborationWorkspaceNavigationContext,
} from '../types'
import type { WorkspaceMyWorkItem } from '../ports/SharedWorkspaceApi'
import type { WorkspaceProjectIssuesSnapshot } from './workspaceOperations'
export interface CollaborationPlatformState {
  workspaces: CollaborationWorkspace[]
  workspace: CollaborationWorkspace | null
  workspaceNavigationContext: CollaborationWorkspaceNavigationContext | null
  navigationProjects: CollaborationProject[]
  navigationIncomplete: boolean
  projects: CollaborationProject[]
  projectIssues: Record<string, WorkspaceProjectIssuesSnapshot>
  myWork: WorkspaceMyWorkItem[]
  members: CollaborationWorkspaceMember[]
  agents: CollaborationOwnedAgent[]
  collaborationGroups: CollaborationGroup[]
  executionEnvironments: CollaborationExecutionEnvironment[]
  resources: CollaborationPlatformResources
  loading: boolean
  error: string | null
}
export const emptyResources: CollaborationPlatformResources = {
  agents: [],
  execution_environments: [],
}
export function updateCurrentWorkspace(
  state: CollaborationPlatformState,
  update: (workspace: CollaborationWorkspace) => CollaborationWorkspace
) {
  if (!state.workspace) {
    return {
      workspace: null,
      workspaces: state.workspaces,
    }
  }
  const workspace = update(state.workspace)
  return {
    workspace,
    workspaces: state.workspaces.map(candidate =>
      candidate.id === workspace.id ? workspace : candidate
    ),
  }
}
export async function loadRootMyWork(api: SharedWorkspaceApi): Promise<WorkspaceMyWorkItem[]> {
  try {
    return (await api.myWork?.list()) ?? []
  } catch {
    return []
  }
}
export interface RootNavigationSnapshot {
  workspaces: CollaborationWorkspace[]
  projects: CollaborationProject[]
  myWork: WorkspaceMyWorkItem[]
  collaborationGroups: CollaborationGroup[]
  resources: CollaborationPlatformResources
}
export interface NavigationCollections {
  workspaces: CollaborationWorkspace[]
  projects: CollaborationProject[]
  complete: boolean
  successfulLoads: number
}
export function mergeByKey<T>(collections: T[][], keyFor: (item: T) => string): T[] {
  const merged = new Map<string, T>()
  for (const collection of collections) {
    for (const item of collection) {
      const key = keyFor(item)
      if (!merged.has(key)) merged.set(key, item)
    }
  }
  return [...merged.values()]
}
export function reconcileNavigationProjects(
  incoming: CollaborationProject[],
  cached: CollaborationProject[]
): CollaborationProject[] {
  const cachedById = new Map(cached.map(project => [project.id, project]))
  return incoming.map(project => {
    const cachedProject = cachedById.get(project.id)
    if (
      !cachedProject ||
      cachedProject.project_store !== project.project_store ||
      (cachedProject.current_user_id !== undefined &&
        project.current_user_id !== undefined &&
        cachedProject.current_user_id !== project.current_user_id) ||
      !(cachedProject.version >= project.version)
    )
      return project
    // Viewer authorization is not versioned with the project resource.
    return {
      ...cachedProject,
      ...('current_user_id' in project ? { current_user_id: project.current_user_id } : {}),
      ...('current_user_name' in project ? { current_user_name: project.current_user_name } : {}),
      ...('access_role' in project ? { access_role: project.access_role } : {}),
      ...('workspace_access_role' in project
        ? { workspace_access_role: project.workspace_access_role }
        : {}),
      ...('permission_sources' in project
        ? { permission_sources: project.permission_sources }
        : {}),
      ...('workspace_context' in project ? { workspace_context: project.workspace_context } : {}),
    }
  })
}
export function mergeRootNavigationSnapshots(
  snapshots: RootNavigationSnapshot[]
): RootNavigationSnapshot {
  return {
    workspaces: mergeByKey(
      snapshots.map(snapshot => snapshot.workspaces),
      workspace => workspace.id
    ),
    projects: mergeByKey(
      snapshots.map(snapshot => snapshot.projects),
      project => project.id
    ),
    myWork: mergeByKey(
      snapshots.map(snapshot => snapshot.myWork),
      item => item.id
    ),
    collaborationGroups: mergeByKey(
      snapshots.map(snapshot => snapshot.collaborationGroups),
      group => group.id
    ),
    resources: {
      agents: mergeByKey(
        snapshots.map(snapshot => snapshot.resources.agents),
        agent => agent.id
      ),
      execution_environments: mergeByKey(
        snapshots.map(snapshot => snapshot.resources.execution_environments),
        environment => environment.id
      ),
    },
  }
}
export async function loadNavigationCollections(
  sources: SharedWorkspaceApi[],
  onProgress?: (collections: NavigationCollections) => void
): Promise<NavigationCollections> {
  const workspaceCollections: CollaborationWorkspace[][] = []
  const projectCollections: CollaborationProject[][] = []
  let successfulLoads = 0
  const snapshot = (complete = false): NavigationCollections => ({
    workspaces: mergeByKey(workspaceCollections, workspace => workspace.id),
    projects: mergeByKey(projectCollections, project => project.id),
    complete,
    successfulLoads,
  })
  const results = await Promise.allSettled(
    sources.flatMap(source => {
      const loads: Promise<void>[] = [
        source.projects.list().then(projects => {
          successfulLoads += 1
          projectCollections.push(projects)
          onProgress?.(snapshot())
        }),
      ]
      if (source.workspaces) {
        loads.push(
          source.workspaces.list().then(workspaces => {
            successfulLoads += 1
            workspaceCollections.push(workspaces)
            onProgress?.(snapshot())
          })
        )
      }
      return loads
    })
  )
  return snapshot(results.every(result => result.status === 'fulfilled'))
}
