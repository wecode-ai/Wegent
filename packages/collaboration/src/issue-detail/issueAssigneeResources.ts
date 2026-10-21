// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { WorkspaceProjectAgent } from "../ports/SharedWorkspaceApi";
import type { CollaborationOwnedAgent, CollaborationProject } from "../types";
import {
  createResourceAgentBindingInput,
  normalizeProjectAgent,
} from "../project-agent-config/model";
import type { SharedIssueDetailWorkspaceApi } from "./createSharedIssueDetailPort";

export type IssueAssigneeResourceProject = Pick<
  CollaborationProject,
  | "id"
  | "workspace_id"
  | "project_store"
  | "access_role"
  | "workspace_access_role"
>;

function matchesResource(
  binding: WorkspaceProjectAgent,
  resource: CollaborationOwnedAgent,
): boolean {
  const agent = normalizeProjectAgent(binding);
  if (resource.team_id) return agent.wegentTeamId === resource.team_id;
  const input = resource.project_binding_input;
  return (
    Boolean(input) &&
    (binding.agent_id ?? binding.name) === input?.name &&
    binding.namespace === input?.namespace &&
    binding.runtime === input?.runtime
  );
}

/** Enable a workspace resource explicitly before using it as an Issue assignee. */
export function createIssueAssigneeResources(
  api: SharedIssueDetailWorkspaceApi,
) {
  const pending = new Map<string, Promise<string>>();

  async function sources(
    project: IssueAssigneeResourceProject,
  ): Promise<CollaborationOwnedAgent[]> {
    const local = project.project_store === "local";
    if (
      !api.workspaces ||
      !api.agents.create ||
      !project.workspace_id ||
      (!local &&
        project.access_role !== "Owner" &&
        project.access_role !== "Maintainer") ||
      project.workspace_access_role === null
    )
      return [];
    if (!local && project.workspace_access_role === undefined) {
      const workspaces = await api.workspaces.list();
      if (
        !workspaces.some((workspace) => workspace.id === project.workspace_id)
      )
        return [];
    }
    const resources = await api.workspaces.listAgents(project.workspace_id);
    return resources.filter(
      (resource) =>
        resource.status === "available" &&
        (local
          ? resource.location === "local"
          : resource.location !== "local") &&
        Boolean(resource.team_id || resource.project_binding_input),
    );
  }

  async function bind(
    project: IssueAssigneeResourceProject,
    resourceId: string,
  ): Promise<string> {
    const [resources, bindings] = await Promise.all([
      sources(project),
      api.agents.list(project.id),
    ]);
    const resource = resources.find((candidate) => candidate.id === resourceId);
    if (!resource) throw new Error("Workspace Agent is no longer available");
    const existing = bindings.find((binding) =>
      matchesResource(binding, resource),
    );
    if (existing) {
      const agent = normalizeProjectAgent(existing);
      if (!agent.canUse || agent.status !== "active") {
        throw new Error("Project Agent is not available");
      }
      return existing.id;
    }
    const created = await api.agents.create!(
      project.id,
      createResourceAgentBindingInput(resource),
    );
    return created.id;
  }

  return {
    async list(project: IssueAssigneeResourceProject) {
      const resources = await sources(project);
      if (resources.length === 0) return [];
      const bindings = await api.agents.list(project.id);
      return resources.filter(
        (resource) =>
          !bindings.some((binding) => matchesResource(binding, resource)),
      );
    },
    bind(project: IssueAssigneeResourceProject, resourceId: string) {
      const key = JSON.stringify([project.id, resourceId]);
      const current = pending.get(key);
      if (current) return current;
      const request = bind(project, resourceId).finally(() =>
        pending.delete(key),
      );
      pending.set(key, request);
      return request;
    },
  };
}
