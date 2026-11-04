// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  SharedWorkspaceApi,
  WorkspaceMyWorkItem,
} from "../ports/SharedWorkspaceApi";
import type {
  CollaborationGroup,
  CollaborationExecutionEnvironment,
  CollaborationWorkspaceMember,
  CollaborationOwnedAgent,
  CollaborationPlatformResources,
  CollaborationProject,
  CollaborationWorkspace,
  CollaborationWorkspaceNavigationContext,
} from "../types";
import type { WorkspaceProjectIssuesSnapshot } from "./workspaceOperations";

export interface CollaborationPlatformState {
  workspaces: CollaborationWorkspace[];
  workspace: CollaborationWorkspace | null;
  workspaceNavigationContext: CollaborationWorkspaceNavigationContext | null;
  navigationProjects: CollaborationProject[];
  navigationIncomplete: boolean;
  projects: CollaborationProject[];
  projectIssues: Record<string, WorkspaceProjectIssuesSnapshot>;
  myWork: WorkspaceMyWorkItem[];
  members: CollaborationWorkspaceMember[];
  agents: CollaborationOwnedAgent[];
  collaborationGroups: CollaborationGroup[];
  executionEnvironments: CollaborationExecutionEnvironment[];
  resources: CollaborationPlatformResources;
  loading: boolean;
  error: string | null;
}

export const emptyResources: CollaborationPlatformResources = {
  agents: [],
  execution_environments: [],
};

export function updateCurrentWorkspace(
  state: CollaborationPlatformState,
  update: (workspace: CollaborationWorkspace) => CollaborationWorkspace,
) {
  if (!state.workspace) {
    return {
      workspace: null,
      workspaces: state.workspaces,
    };
  }
  const workspace = update(state.workspace);
  return {
    workspace,
    workspaces: state.workspaces.map((candidate) =>
      candidate.id === workspace.id ? workspace : candidate,
    ),
  };
}

export function registerProjectInState(
  current: CollaborationPlatformState,
  project: CollaborationProject,
): CollaborationPlatformState {
  const projectExists = current.navigationProjects.some(
    (candidate) => candidate.id === project.id,
  );
  const updateWorkspace = (workspace: CollaborationWorkspace) =>
    workspace.id === project.workspace_id && !projectExists
      ? { ...workspace, project_count: workspace.project_count + 1 }
      : workspace;
  return {
    ...current,
    projects: [
      project,
      ...current.projects.filter((candidate) => candidate.id !== project.id),
    ],
    projectIssues: {
      ...current.projectIssues,
      [project.id]: current.projectIssues[project.id] ?? {
        status: "available",
        issues: [],
      },
    },
    navigationProjects: [
      project,
      ...current.navigationProjects.filter(
        (candidate) => candidate.id !== project.id,
      ),
    ],
    workspace: current.workspace ? updateWorkspace(current.workspace) : null,
    workspaces: current.workspaces.map(updateWorkspace),
  };
}

export async function loadRootMyWork(
  api: SharedWorkspaceApi,
): Promise<WorkspaceMyWorkItem[]> {
  try {
    return (await api.myWork?.list()) ?? [];
  } catch {
    return [];
  }
}

export interface RootNavigationSnapshot {
  workspaces: CollaborationWorkspace[];
  projects: CollaborationProject[];
  myWork: WorkspaceMyWorkItem[];
  collaborationGroups: CollaborationGroup[];
  resources: CollaborationPlatformResources;
}

export interface NavigationCollections {
  workspaces: CollaborationWorkspace[];
  projects: CollaborationProject[];
  complete: boolean;
  successfulLoads: number;
}

export function workspaceNavigationState(
  current: CollaborationPlatformState,
  workspace: CollaborationWorkspace,
  collections: NavigationCollections,
): CollaborationPlatformState {
  return {
    ...current,
    workspaces: collections.workspaces,
    workspace,
    workspaceNavigationContext: null,
    navigationProjects: collections.projects,
    navigationIncomplete: !collections.complete,
    projects: collections.projects.filter(
      (project) => project.workspace_id === workspace.id,
    ),
    projectIssues: {},
    myWork: [],
    members: [],
    agents: [],
    collaborationGroups: [],
    executionEnvironments: [],
    resources: emptyResources,
    loading: false,
    error: null,
  };
}

export function mergeByKey<T>(
  collections: T[][],
  keyFor: (item: T) => string,
): T[] {
  const merged = new Map<string, T>();
  for (const collection of collections) {
    for (const item of collection) {
      const key = keyFor(item);
      if (!merged.has(key)) merged.set(key, item);
    }
  }
  return [...merged.values()];
}

export function reconcileNavigationProjects(
  incoming: CollaborationProject[],
  cached: CollaborationProject[],
): CollaborationProject[] {
  const cachedById = new Map(cached.map((project) => [project.id, project]));
  return incoming.map((project) => {
    const cachedProject = cachedById.get(project.id);
    return cachedProject && cachedProject.version >= project.version
      ? cachedProject
      : project;
  });
}

export function reconcilePendingNavigationProjects(
  incoming: CollaborationProject[],
  current: CollaborationProject[],
  initial: CollaborationProject[],
): CollaborationProject[] {
  const initialIds = new Set(initial.map((project) => project.id));
  return reconcileNavigationProjects(
    mergeByKey(
      [incoming, current.filter((project) => !initialIds.has(project.id))],
      (project) => project.id,
    ),
    current,
  );
}

export function reconcilePendingNavigationCollections(
  incoming: NavigationCollections,
  current: Pick<NavigationCollections, "workspaces" | "projects">,
  initialProjects: CollaborationProject[],
): NavigationCollections {
  const initialIds = new Set(initialProjects.map((project) => project.id));
  const changedWorkspaceIds = new Set(
    current.projects
      .filter((project) => !initialIds.has(project.id))
      .map((project) => project.workspace_id),
  );
  const currentWorkspaces = new Map(
    current.workspaces.map((workspace) => [workspace.id, workspace]),
  );
  return {
    ...incoming,
    projects: reconcilePendingNavigationProjects(
      incoming.projects,
      current.projects,
      initialProjects,
    ),
    workspaces: incoming.workspaces.map((workspace) => {
      const currentWorkspace = currentWorkspaces.get(workspace.id);
      return changedWorkspaceIds.has(workspace.id) && currentWorkspace
        ? {
            ...workspace,
            project_count: Math.max(
              workspace.project_count,
              currentWorkspace.project_count,
            ),
          }
        : workspace;
    }),
  };
}

export function mergeRootNavigationSnapshots(
  snapshots: RootNavigationSnapshot[],
): RootNavigationSnapshot {
  return {
    workspaces: mergeByKey(
      snapshots.map((snapshot) => snapshot.workspaces),
      (workspace) => workspace.id,
    ),
    projects: mergeByKey(
      snapshots.map((snapshot) => snapshot.projects),
      (project) => project.id,
    ),
    myWork: mergeByKey(
      snapshots.map((snapshot) => snapshot.myWork),
      (item) => item.id,
    ),
    collaborationGroups: mergeByKey(
      snapshots.map((snapshot) => snapshot.collaborationGroups),
      (group) => group.id,
    ),
    resources: {
      agents: mergeByKey(
        snapshots.map((snapshot) => snapshot.resources.agents),
        (agent) => agent.id,
      ),
      execution_environments: mergeByKey(
        snapshots.map((snapshot) => snapshot.resources.execution_environments),
        (environment) => environment.id,
      ),
    },
  };
}

export async function loadNavigationCollections(
  sources: SharedWorkspaceApi[],
  onProgress?: (collections: NavigationCollections) => void,
): Promise<NavigationCollections> {
  const workspaceCollections: CollaborationWorkspace[][] = [];
  const projectCollections: CollaborationProject[][] = [];
  let successfulLoads = 0;
  const snapshot = (complete = false): NavigationCollections => ({
    workspaces: mergeByKey(workspaceCollections, (workspace) => workspace.id),
    projects: mergeByKey(projectCollections, (project) => project.id),
    complete,
    successfulLoads,
  });
  const results = await Promise.allSettled(
    sources.flatMap((source) => {
      const loads: Promise<void>[] = [
        source.projects.list().then((projects) => {
          successfulLoads += 1;
          projectCollections.push(projects);
          onProgress?.(snapshot());
        }),
      ];
      if (source.workspaces) {
        loads.push(
          source.workspaces.list().then((workspaces) => {
            successfulLoads += 1;
            workspaceCollections.push(workspaces);
            onProgress?.(snapshot());
          }),
        );
      }
      return loads;
    }),
  );
  return snapshot(results.every((result) => result.status === "fulfilled"));
}
