// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useRef, useState } from "react";

import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type {
  CollaborationGroupCreateInput,
  CollaborationGroupUpdateInput,
} from "../ports/SharedWorkspaceApi";
import type {
  CollaborationGroup,
  CollaborationExecutionEnvironment,
  CollaborationExecution,
  CollaborationMember,
  CollaborationOwnedAgent,
  CollaborationPlatformResources,
  CollaborationProject,
  CollaborationRole,
  CollaborationUser,
  CollaborationWorkspace,
  CollaborationWorkspaceNavigationContext,
} from "../types";
import type { WorkspaceMyWorkItem } from "../ports/SharedWorkspaceApi";
import type { CollaborationPlatformLocation } from "./types";
import type { WorkspaceProjectIssuesSnapshot } from "./workspaceOperations";

export interface CollaborationPlatformState {
  workspaces: CollaborationWorkspace[];
  workspace: CollaborationWorkspace | null;
  workspaceNavigationContext: CollaborationWorkspaceNavigationContext | null;
  navigationProjects: CollaborationProject[];
  projects: CollaborationProject[];
  projectIssues: Record<string, WorkspaceProjectIssuesSnapshot>;
  myWork: WorkspaceMyWorkItem[];
  executions: Array<{
    project: CollaborationProject;
    execution: CollaborationExecution;
  }>;
  members: CollaborationMember[];
  agents: CollaborationOwnedAgent[];
  collaborationGroups: CollaborationGroup[];
  executionEnvironments: CollaborationExecutionEnvironment[];
  resources: CollaborationPlatformResources;
  loading: boolean;
  error: string | null;
}

const emptyResources: CollaborationPlatformResources = {
  agents: [],
  execution_environments: [],
};

function updateCurrentWorkspace(
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

async function loadRootMyWork(
  api: SharedWorkspaceApi,
): Promise<WorkspaceMyWorkItem[]> {
  try {
    return (await api.myWork?.list()) ?? [];
  } catch {
    return [];
  }
}

async function loadRootExecutions(
  api: SharedWorkspaceApi,
  projects: CollaborationProject[],
): Promise<CollaborationPlatformState["executions"]> {
  const entries = await Promise.all(
    projects.map(async (project) => {
      try {
        const projectExecutions = await api.executions.list(project.id, {
          includeTerminal: true,
        });
        return projectExecutions.map((execution) => ({
          project,
          execution,
        }));
      } catch {
        return [];
      }
    }),
  );
  return entries
    .flat()
    .sort((left, right) =>
      right.execution.updated_at.localeCompare(left.execution.updated_at),
    );
}

interface RootNavigationSnapshot {
  workspaces: CollaborationWorkspace[];
  projects: CollaborationProject[];
  myWork: WorkspaceMyWorkItem[];
  executions: CollaborationPlatformState["executions"];
}

function mergeByKey<T>(collections: T[][], keyFor: (item: T) => string): T[] {
  const merged = new Map<string, T>();
  for (const collection of collections) {
    for (const item of collection) {
      const key = keyFor(item);
      if (!merged.has(key)) merged.set(key, item);
    }
  }
  return [...merged.values()];
}

function mergeRootNavigationSnapshots(
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
    executions: mergeByKey(
      snapshots.map((snapshot) => snapshot.executions),
      ({ project, execution }) => `${project.id}:${execution.id}`,
    ),
  };
}

export function useCollaborationPlatformController({
  api,
  navigationApis,
  location,
  loadFailedMessage,
}: {
  api: SharedWorkspaceApi;
  navigationApis?: SharedWorkspaceApi[];
  location: CollaborationPlatformLocation;
  loadFailedMessage: string;
}) {
  const [state, setState] = useState<CollaborationPlatformState>({
    workspaces: [],
    workspace: null,
    workspaceNavigationContext: null,
    navigationProjects: [],
    projects: [],
    projectIssues: {},
    myWork: [],
    executions: [],
    members: [],
    agents: [],
    collaborationGroups: [],
    executionEnvironments: [],
    resources: emptyResources,
    loading: true,
    error: null,
  });
  const loadRevisionRef = useRef(0);

  const load = useCallback(async () => {
    const revision = ++loadRevisionRef.current;
    if (!api.workspaces) {
      if (revision !== loadRevisionRef.current) return;
      setState((current) => ({
        ...current,
        loading: false,
        error: loadFailedMessage,
      }));
      return;
    }
    setState((current) => ({
      ...current,
      loading:
        current.workspace?.id !== location.workspaceId ||
        Boolean(location.projectId),
      error: null,
    }));
    if (!location.workspaceId) {
      const sources = navigationApis?.length ? navigationApis : [api];
      const snapshots = sources.map<RootNavigationSnapshot>(() => ({
        workspaces: [],
        projects: [],
        myWork: [],
        executions: [],
      }));
      let successfulNavigationLoads = 0;
      const publish = () => {
        if (revision !== loadRevisionRef.current) return;
        const snapshot = mergeRootNavigationSnapshots(snapshots);
        setState((current) => ({
          ...current,
          workspaces: snapshot.workspaces,
          workspace: null,
          workspaceNavigationContext: null,
          navigationProjects: snapshot.projects,
          projects: snapshot.projects,
          projectIssues: {},
          myWork: snapshot.myWork,
          executions: snapshot.executions,
          members: [],
          agents: [],
          collaborationGroups: [],
          executionEnvironments: [],
          resources: emptyResources,
          loading: false,
          error: null,
        }));
      };
      const updateSnapshot = (
        index: number,
        update: Partial<RootNavigationSnapshot>,
      ) => {
        if (revision !== loadRevisionRef.current) return;
        snapshots[index] = {
          ...snapshots[index],
          ...update,
        };
        if (successfulNavigationLoads > 0) publish();
      };
      for (const [index, source] of sources.entries()) {
        void loadRootMyWork(source).then((myWork) => {
          updateSnapshot(index, { myWork });
        });
      }
      const results = await Promise.allSettled(
        sources.flatMap((source, index) => {
          const loads: Promise<void>[] = [
            source.projects.list().then((projects) => {
              if (revision !== loadRevisionRef.current) return;
              successfulNavigationLoads += 1;
              updateSnapshot(index, { projects });
              if (location.rootView === "runs") {
                void loadRootExecutions(source, projects).then((executions) => {
                  updateSnapshot(index, { executions });
                });
              }
            }),
          ];
          if (source.workspaces) {
            loads.push(
              source.workspaces.list().then((workspaces) => {
                if (revision !== loadRevisionRef.current) return;
                successfulNavigationLoads += 1;
                updateSnapshot(index, { workspaces });
              }),
            );
          }
          return loads;
        }),
      );
      if (
        revision === loadRevisionRef.current &&
        successfulNavigationLoads === 0 &&
        results.every((result) => result.status === "rejected")
      ) {
        setState((current) => ({
          ...current,
          loading: false,
          error: loadFailedMessage,
        }));
      }
      return;
    }
    try {
      const [workspaces, navigationProjects] = await Promise.all([
        api.workspaces.list(),
        api.projects.list(),
      ]);
      if (revision !== loadRevisionRef.current) return;
      if (location.projectId) {
        const workspace =
          workspaces.find(
            (candidate) => candidate.id === location.workspaceId,
          ) ?? null;
        const workspaceNavigationContext =
          workspace || !api.workspaces.getNavigationContext
            ? null
            : await api.workspaces.getNavigationContext(location.workspaceId);
        if (revision !== loadRevisionRef.current) return;
        setState((current) => ({
          ...current,
          workspaces,
          workspace,
          workspaceNavigationContext,
          navigationProjects,
          projects: navigationProjects.filter(
            (project) => project.workspace_id === location.workspaceId,
          ),
          projectIssues: {},
          myWork: [],
          executions: [],
          members: [],
          agents: [],
          collaborationGroups: [],
          executionEnvironments: [],
          resources: emptyResources,
          loading: false,
        }));
        return;
      }
      const workspaceProjects = navigationProjects.filter(
        (project) => project.workspace_id === location.workspaceId,
      );
      const [
        workspace,
        members,
        agents,
        collaborationGroups,
        executionEnvironments,
        resources,
        projectSnapshots,
      ] = await Promise.all([
        api.workspaces.get(location.workspaceId),
        api.workspaces.listMembers(location.workspaceId),
        api.workspaces.listAgents(location.workspaceId),
        api.workspaces.listCollaborationGroups(location.workspaceId),
        api.workspaces.listExecutionEnvironments(location.workspaceId),
        api.resources ? api.resources.list() : emptyResources,
        location.workspaceView === "home"
          ? Promise.all(
              workspaceProjects.map(async (project) => {
                try {
                  const snapshot = await api.issues.getBoardSnapshot(
                    project.id,
                  );
                  return {
                    projectId: project.id,
                    value: {
                      status: "available",
                      issues: snapshot.items,
                    } satisfies WorkspaceProjectIssuesSnapshot,
                  };
                } catch {
                  return {
                    projectId: project.id,
                    value: {
                      status: "unavailable",
                    } satisfies WorkspaceProjectIssuesSnapshot,
                  };
                }
              }),
            )
          : Promise.resolve([]),
      ]);
      if (revision !== loadRevisionRef.current) return;
      setState((current) => ({
        ...current,
        workspaces,
        workspace,
        workspaceNavigationContext: null,
        navigationProjects,
        projects: workspaceProjects,
        projectIssues: Object.fromEntries(
          projectSnapshots.map(({ projectId, value }) => [projectId, value]),
        ),
        myWork: [],
        executions: [],
        members,
        agents,
        collaborationGroups,
        executionEnvironments,
        resources,
        loading: false,
      }));
    } catch {
      if (revision !== loadRevisionRef.current) return;
      setState((current) => ({
        ...current,
        loading: false,
        error: loadFailedMessage,
      }));
    }
  }, [
    api,
    loadFailedMessage,
    navigationApis,
    location.projectId,
    location.rootView,
    location.workspaceId,
    location.workspaceView,
  ]);

  useEffect(() => {
    void load();
    return () => {
      loadRevisionRef.current += 1;
    };
  }, [load]);

  return {
    state,
    commands: {
      reload: load,
      async createWorkspace(input: { name: string; description?: string }) {
        if (!api.workspaces) throw new Error("Workspace API is unavailable");
        const workspace = await api.workspaces.create(input);
        setState((current) => ({
          ...current,
          workspaces: [workspace, ...current.workspaces],
        }));
        return workspace;
      },
      async updateWorkspace(input: {
        version: number;
        name?: string;
        description?: string;
      }) {
        if (!api.workspaces || !location.workspaceId) {
          throw new Error("Workspace API is unavailable");
        }
        const workspace = await api.workspaces.update(
          location.workspaceId,
          input,
        );
        setState((current) => ({
          ...current,
          workspace,
          workspaces: current.workspaces.map((candidate) =>
            candidate.id === workspace.id ? workspace : candidate,
          ),
        }));
        return workspace;
      },
      async createProject(input: {
        name: string;
        description?: string;
        projectKey?: string;
        taskProvider?: "local" | "github" | "gitlab" | "dingtalk_aitable";
        visibility?: "private" | "public";
        providerConfig?: Record<string, unknown>;
      }) {
        if (!location.workspaceId) {
          throw new Error("Workspace is unavailable");
        }
        const project = await api.projects.create({
          ...input,
          workspaceId: location.workspaceId,
        });
        setState((current) => ({
          ...current,
          projects: [project, ...current.projects],
          projectIssues: {
            ...current.projectIssues,
            [project.id]: { status: "available", issues: [] },
          },
          navigationProjects: [project, ...current.navigationProjects],
          ...updateCurrentWorkspace(current, (workspace) => ({
            ...workspace,
            project_count: workspace.project_count + 1,
          })),
        }));
        return project;
      },
      async searchUsers(query: string): Promise<CollaborationUser[]> {
        return api.members.searchUsers(query);
      },
      async addMember(
        userId: number,
        role: Exclude<CollaborationRole, "Owner">,
      ) {
        if (!api.workspaces || !location.workspaceId) {
          throw new Error("Workspace API is unavailable");
        }
        const member = await api.workspaces.addMember(location.workspaceId, {
          userId,
          role,
        });
        setState((current) => ({
          ...current,
          members: [
            ...current.members.filter(
              (candidate) => candidate.user_id !== member.user_id,
            ),
            member,
          ],
          ...updateCurrentWorkspace(current, (workspace) => ({
            ...workspace,
            member_count: current.members.some(
              (candidate) => candidate.user_id === member.user_id,
            )
              ? workspace.member_count
              : workspace.member_count + 1,
          })),
        }));
        return member;
      },
      async updateMember(
        userId: number,
        role: Exclude<CollaborationRole, "Owner">,
      ) {
        if (!api.workspaces || !location.workspaceId) {
          throw new Error("Workspace API is unavailable");
        }
        const member = await api.workspaces.updateMember(
          location.workspaceId,
          userId,
          { role },
        );
        setState((current) => ({
          ...current,
          members: current.members.map((candidate) =>
            candidate.user_id === member.user_id ? member : candidate,
          ),
        }));
        return member;
      },
      async removeMember(userId: number) {
        if (!api.workspaces || !location.workspaceId) {
          throw new Error("Workspace API is unavailable");
        }
        await api.workspaces.removeMember(location.workspaceId, userId);
        setState((current) => ({
          ...current,
          members: current.members.filter(
            (candidate) => candidate.user_id !== userId,
          ),
          ...updateCurrentWorkspace(current, (workspace) => ({
            ...workspace,
            member_count: Math.max(0, workspace.member_count - 1),
          })),
        }));
      },
      async addAgent(agent: CollaborationOwnedAgent) {
        if (!api.workspaces || !location.workspaceId || !agent.team_id) {
          throw new Error("Agent cannot be authorized");
        }
        const added = await api.workspaces.addAgent(location.workspaceId, {
          teamId: agent.team_id,
        });
        setState((current) => ({
          ...current,
          agents: [
            ...current.agents.filter(
              (candidate) => candidate.team_id !== added.team_id,
            ),
            added,
          ],
          resources: {
            ...current.resources,
            agents: current.resources.agents.map((candidate) =>
              candidate.team_id === added.team_id ? added : candidate,
            ),
          },
          ...updateCurrentWorkspace(current, (workspace) => ({
            ...workspace,
            agent_count: current.agents.some(
              (candidate) => candidate.team_id === added.team_id,
            )
              ? workspace.agent_count
              : workspace.agent_count + 1,
          })),
        }));
        return added;
      },
      async removeAgent(agent: CollaborationOwnedAgent) {
        if (!api.workspaces || !location.workspaceId || !agent.team_id) {
          throw new Error("Agent cannot be removed");
        }
        await api.workspaces.removeAgent(location.workspaceId, agent.team_id);
        setState((current) => ({
          ...current,
          agents: current.agents.filter(
            (candidate) => candidate.team_id !== agent.team_id,
          ),
          resources: {
            ...current.resources,
            agents: current.resources.agents,
          },
          ...updateCurrentWorkspace(current, (workspace) => ({
            ...workspace,
            agent_count: Math.max(0, workspace.agent_count - 1),
          })),
        }));
      },
      async createCollaborationGroup(input: CollaborationGroupCreateInput) {
        if (!api.workspaces || !location.workspaceId) {
          throw new Error("Workspace API is unavailable");
        }
        const group = await api.workspaces.createCollaborationGroup(
          location.workspaceId,
          input,
        );
        setState((current) => ({
          ...current,
          collaborationGroups: [...current.collaborationGroups, group],
        }));
        return group;
      },
      async updateCollaborationGroup(
        groupId: string,
        input: CollaborationGroupUpdateInput,
      ) {
        if (!api.workspaces || !location.workspaceId) {
          throw new Error("Workspace API is unavailable");
        }
        const group = await api.workspaces.updateCollaborationGroup(
          location.workspaceId,
          groupId,
          input,
        );
        setState((current) => ({
          ...current,
          collaborationGroups: current.collaborationGroups.map((candidate) =>
            candidate.id === group.id ? group : candidate,
          ),
        }));
        return group;
      },
      async removeCollaborationGroup(groupId: string) {
        if (!api.workspaces || !location.workspaceId) {
          throw new Error("Workspace API is unavailable");
        }
        await api.workspaces.removeCollaborationGroup(
          location.workspaceId,
          groupId,
        );
        setState((current) => ({
          ...current,
          collaborationGroups: current.collaborationGroups.filter(
            (group) => group.id !== groupId,
          ),
        }));
      },
      async addExecutionEnvironment(
        environment: CollaborationExecutionEnvironment,
      ) {
        if (
          !api.workspaces ||
          !location.workspaceId ||
          !environment.device_id
        ) {
          throw new Error("Execution environment cannot be authorized");
        }
        const added = await api.workspaces.addExecutionEnvironment(
          location.workspaceId,
          { deviceId: environment.device_id },
        );
        setState((current) => ({
          ...current,
          executionEnvironments: [
            ...current.executionEnvironments.filter(
              (candidate) => candidate.device_id !== added.device_id,
            ),
            added,
          ],
          resources: {
            ...current.resources,
            execution_environments:
              current.resources.execution_environments.map((candidate) =>
                candidate.device_id === added.device_id ? added : candidate,
              ),
          },
          ...updateCurrentWorkspace(current, (workspace) => ({
            ...workspace,
            execution_environment_count: current.executionEnvironments.some(
              (candidate) => candidate.device_id === added.device_id,
            )
              ? workspace.execution_environment_count
              : workspace.execution_environment_count + 1,
          })),
        }));
        return added;
      },
      async removeExecutionEnvironment(
        environment: CollaborationExecutionEnvironment,
      ) {
        if (
          !api.workspaces ||
          !location.workspaceId ||
          !environment.device_id
        ) {
          throw new Error("Execution environment cannot be removed");
        }
        await api.workspaces.removeExecutionEnvironment(
          location.workspaceId,
          environment.device_id,
        );
        setState((current) => ({
          ...current,
          executionEnvironments: current.executionEnvironments.filter(
            (candidate) => candidate.device_id !== environment.device_id,
          ),
          resources: {
            ...current.resources,
            execution_environments: current.resources.execution_environments,
          },
          ...updateCurrentWorkspace(current, (workspace) => ({
            ...workspace,
            execution_environment_count: Math.max(
              0,
              workspace.execution_environment_count - 1,
            ),
          })),
        }));
      },
    },
  };
}
