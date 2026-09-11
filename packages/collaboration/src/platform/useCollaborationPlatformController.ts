// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from "react";

import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type {
  CollaborationExecutionEnvironment,
  CollaborationMember,
  CollaborationOwnedAgent,
  CollaborationPlatformResources,
  CollaborationProject,
  CollaborationRole,
  CollaborationUser,
  CollaborationWorkspace,
} from "../types";
import type { CollaborationPlatformLocation } from "./types";

export interface CollaborationPlatformState {
  workspaces: CollaborationWorkspace[];
  workspace: CollaborationWorkspace | null;
  projects: CollaborationProject[];
  members: CollaborationMember[];
  agents: CollaborationOwnedAgent[];
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

export function useCollaborationPlatformController({
  api,
  location,
  loadFailedMessage,
}: {
  api: SharedWorkspaceApi;
  location: CollaborationPlatformLocation;
  loadFailedMessage: string;
}) {
  const [state, setState] = useState<CollaborationPlatformState>({
    workspaces: [],
    workspace: null,
    projects: [],
    members: [],
    agents: [],
    executionEnvironments: [],
    resources: emptyResources,
    loading: true,
    error: null,
  });

  const load = useCallback(async () => {
    if (!api.workspaces) {
      setState((current) => ({
        ...current,
        loading: false,
        error: loadFailedMessage,
      }));
      return;
    }
    setState((current) => ({ ...current, loading: true, error: null }));
    try {
      const workspaces = await api.workspaces.list();
      if (!location.workspaceId) {
        const resources =
          location.platformView === "resources" && api.resources
            ? await api.resources.list()
            : emptyResources;
        setState((current) => ({
          ...current,
          workspaces,
          workspace: null,
          projects: [],
          members: [],
          agents: [],
          executionEnvironments: [],
          resources,
          loading: false,
        }));
        return;
      }
      const [
        workspace,
        projects,
        members,
        agents,
        executionEnvironments,
        resources,
      ] = await Promise.all([
          api.workspaces.get(location.workspaceId),
          api.projects.list(location.workspaceId),
          api.workspaces.listMembers(location.workspaceId),
          api.workspaces.listAgents(location.workspaceId),
          api.workspaces.listExecutionEnvironments(location.workspaceId),
          api.resources ? api.resources.list() : emptyResources,
        ]);
      setState((current) => ({
        ...current,
        workspaces,
        workspace,
        projects,
        members,
        agents,
        executionEnvironments,
        resources,
        loading: false,
      }));
    } catch {
      setState((current) => ({
        ...current,
        loading: false,
        error: loadFailedMessage,
      }));
    }
  }, [api, loadFailedMessage, location.platformView, location.workspaceId]);

  useEffect(() => {
    void load();
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
      async addAgent(
        agent: CollaborationOwnedAgent,
        ownerType: "user" | "workspace",
      ) {
        if (!api.workspaces || !location.workspaceId || !agent.team_id) {
          throw new Error("Agent cannot be authorized");
        }
        const added = await api.workspaces.addAgent(location.workspaceId, {
          teamId: agent.team_id,
          ownerType,
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
      async updateAgent(
        agent: CollaborationOwnedAgent,
        ownerType: "user" | "workspace",
      ) {
        if (!api.workspaces || !location.workspaceId || !agent.team_id) {
          throw new Error("Agent cannot be updated");
        }
        const updated = await api.workspaces.updateAgent(
          location.workspaceId,
          agent.team_id,
          { ownerType },
        );
        setState((current) => ({
          ...current,
          agents: current.agents.map((candidate) =>
            candidate.team_id === updated.team_id ? updated : candidate,
          ),
          resources: {
            ...current.resources,
            agents: current.resources.agents.map((candidate) =>
              candidate.team_id === updated.team_id ? updated : candidate,
            ),
          },
        }));
        return updated;
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
            agents: current.resources.agents.map((candidate) =>
              candidate.team_id === agent.team_id
                ? {
                    ...candidate,
                    workspace_ids: candidate.workspace_ids.filter(
                      (workspaceId) => workspaceId !== location.workspaceId,
                    ),
                  }
                : candidate,
            ),
          },
          ...updateCurrentWorkspace(current, (workspace) => ({
            ...workspace,
            agent_count: Math.max(0, workspace.agent_count - 1),
          })),
        }));
      },
      async addExecutionEnvironment(
        environment: CollaborationExecutionEnvironment,
        ownerType: "user" | "workspace",
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
          {
            deviceId: environment.device_id,
            ownerType,
          },
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
            execution_environments:
              current.resources.execution_environments.map((candidate) =>
                candidate.device_id === environment.device_id
                  ? {
                      ...candidate,
                      workspace_ids: candidate.workspace_ids.filter(
                        (workspaceId) => workspaceId !== location.workspaceId,
                      ),
                    }
                  : candidate,
              ),
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
