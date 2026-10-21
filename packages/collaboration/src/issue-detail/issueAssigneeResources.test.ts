// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { CollaborationOwnedAgent } from "../types";
import type { WorkspaceProjectAgent } from "../ports/SharedWorkspaceApi";
import type { SharedIssueDetailWorkspaceApi } from "./createSharedIssueDetailPort";
import {
  createIssueAssigneeResources,
  type IssueAssigneeResourceProject,
} from "./issueAssigneeResources";

const project: IssueAssigneeResourceProject = {
  id: "project",
  workspace_id: "space",
  project_store: "backend",
  access_role: "Maintainer",
  workspace_access_role: "Viewer",
};
const source: CollaborationOwnedAgent = {
  id: "team:42",
  team_id: 42,
  name: "空间代码助手",
  owner_type: "workspace",
  owner_id: "space",
  owner_name: "Space",
  status: "available",
  execution_environment_ids: [],
};

function setup(resources = [source]) {
  const bindings: WorkspaceProjectAgent[] = [];
  const api = {
    workspaces: {
      list: vi.fn(async () => [{ id: "space" }]),
      listAgents: vi.fn(async () => resources),
    },
    agents: {
      list: vi.fn(async () => bindings),
      create: vi.fn(async (_id: string, input: Record<string, unknown>) => {
        const binding = {
          ...input,
          id: "binding",
          name: String(input.name),
          status: "active",
        };
        bindings.push(binding);
        return binding;
      }),
    },
  };
  return {
    api,
    bindings,
    directory: createIssueAssigneeResources(
      api as unknown as SharedIssueDetailWorkspaceApi,
    ),
  };
}

describe("workspace resources in the Issue assignee directory", () => {
  it("lists an unbound shared Agent and explicitly binds it once before reuse", async () => {
    const { api, directory } = setup();
    expect(await directory.list(project)).toEqual([source]);
    expect(api.agents.create).not.toHaveBeenCalled();
    expect(
      await Promise.all([
        directory.bind(project, source.id),
        directory.bind(project, source.id),
      ]),
    ).toEqual(["binding", "binding"]);
    expect(api.agents.create).toHaveBeenCalledExactlyOnceWith("project", {
      name: source.name,
      runtime: "wegent",
      wegentTeamId: 42,
      shareWithWorkspace: true,
    });
    expect(await directory.list(project)).toEqual([]);
    expect(await directory.bind(project, source.id)).toBe("binding");
    expect(api.agents.create).toHaveBeenCalledOnce();
  });

  it.each(["Owner", "Maintainer"] as const)(
    "allows a project %s with a workspace use grant",
    async (access_role) => {
      const { directory } = setup();
      expect(await directory.list({ ...project, access_role })).toEqual([
        source,
      ]);
    },
  );

  it.each([
    { access_role: "Developer" as const },
    { access_role: "Viewer" as const },
    { workspace_access_role: null },
    { workspace_id: null },
  ])(
    "does not browse or bind outside project administration and workspace access: %j",
    async (override) => {
      const { api, directory } = setup();
      const context = { ...project, ...override };
      expect(await directory.list(context)).toEqual([]);
      await expect(directory.bind(context, source.id)).rejects.toThrow(
        "no longer available",
      );
      expect(api.workspaces.listAgents).not.toHaveBeenCalled();
      expect(api.agents.create).not.toHaveBeenCalled();
    },
  );

  it("proves legacy workspace membership before reading its catalog", async () => {
    const { api, directory } = setup();
    api.workspaces.list.mockResolvedValue([]);
    expect(
      await directory.list({ ...project, workspace_access_role: undefined }),
    ).toEqual([]);
    expect(api.workspaces.listAgents).not.toHaveBeenCalled();
  });

  it("excludes unavailable and other-location resources", async () => {
    const { directory } = setup([
      source,
      { ...source, id: "disabled", status: "unavailable" },
      { ...source, id: "local", location: "local" },
    ]);
    expect(await directory.list(project)).toEqual([source]);
  });

  it("rechecks the workspace grant on save without creating a binding after revocation", async () => {
    const { api, directory } = setup();
    expect(await directory.list(project)).toEqual([source]);
    api.workspaces.listAgents.mockResolvedValue([]);
    await expect(directory.bind(project, source.id)).rejects.toThrow(
      "no longer available",
    );
    expect(api.agents.create).not.toHaveBeenCalled();
  });

  it("does not replace an unusable existing project binding with a new one", async () => {
    const { bindings, api, directory } = setup();
    bindings.push({
      id: "disabled",
      name: "existing",
      wegentTeamId: 42,
      can_use: false,
    });
    expect(await directory.list(project)).toEqual([]);
    await expect(directory.bind(project, source.id)).rejects.toThrow(
      "not available",
    );
    expect(api.agents.create).not.toHaveBeenCalled();
  });

  it("preserves local configuration and distinguishes resource identity from its display name", async () => {
    const localSource: CollaborationOwnedAgent = {
      ...source,
      id: "local-source",
      team_id: undefined,
      location: "local",
      project_binding_input: {
        name: "resource-name",
        namespace: "custom",
        runtime: "codex",
        displayName: source.name,
        model: "model-1",
        systemPrompt: "Review code",
        mcpServers: { review: { command: "review" } },
      },
    };
    const localProject = {
      ...project,
      project_store: "local" as const,
      access_role: undefined,
    };
    const { directory, bindings, api } = setup([localSource]);
    bindings.push({
      id: "same-label",
      name: source.name,
      namespace: "custom",
      runtime: "codex",
    });
    bindings.push({
      id: "other-namespace",
      name: "resource-name",
      namespace: "other",
      runtime: "codex",
    });
    expect(await directory.list(localProject)).toEqual([localSource]);
    await directory.bind(localProject, localSource.id);
    expect(api.agents.create).toHaveBeenCalledExactlyOnceWith(
      "project",
      localSource.project_binding_input,
    );
    expect(await directory.list(localProject)).toEqual([]);
    expect(await directory.bind(localProject, localSource.id)).toBe("binding");
    expect(api.agents.create).toHaveBeenCalledOnce();
  });
});
