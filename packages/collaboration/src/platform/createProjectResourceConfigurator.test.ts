// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type { ProjectCreateResourceSelection } from "../project-create/types";
import type {
  CollaborationOwnedAgent,
  CollaborationProject,
  CollaborationWorkspace,
  CollaborationWorkspaceMember,
} from "../types";
import { createProjectResourceConfigurator } from "./createProjectResourceConfigurator";

const member: CollaborationWorkspaceMember = {
  id: 2,
  user_id: 2,
  user_name: "Contributor",
  email: null,
  role: "Developer",
};

function agent(id: string, teamId: number): CollaborationOwnedAgent {
  return {
    id,
    team_id: teamId,
    name: id,
    owner_type: "user",
    owner_id: "1",
    owner_name: "Owner",
    status: "available",
  };
}

function createInput() {
  const savedMembers: CollaborationWorkspaceMember[] = [];
  const api = {
    members: {
      list: vi.fn(async () => [...savedMembers]),
      add: vi.fn(async () => {
        savedMembers.push(member);
        return member;
      }),
    },
    workspaces: {
      listExecutionEnvironments: vi.fn(async () => []),
      addExecutionEnvironment: vi.fn(async () => undefined),
    },
    projects: {
      addExecutionEnvironment: vi.fn(async () => undefined),
      createCollaborationGroup: vi.fn(async () => undefined),
    },
    agents: {
      list: vi.fn(async () => []),
      create: vi.fn(async (_projectId: string, input: { name: string }) => ({
        id: `project-${input.name}`,
        name: input.name,
      })),
    },
  };
  const selection: ProjectCreateResourceSelection = {
    memberUserIds: [2],
    agentResourceIds: ["first", "second"],
    executionEnvironmentDeviceIds: [21, 22],
    collaborationGroupDraft: {
      name: "Team",
      description: "Team description",
      instructions: "Preserve team instructions",
      leader: { kind: "human", id: "1" },
      members: [
        { kind: "human", id: "2" },
        { kind: "agent", id: "first" },
        { kind: "agent", id: "second" },
      ],
      stages: [
        {
          id: "implement",
          name: "Implement",
          description: "Deliver",
          assignee: { kind: "agent", id: "first" },
        },
      ],
      executionRequirements: { requiredTags: ["trusted"] },
    },
  };
  return {
    api,
    input: {
      api: api as unknown as SharedWorkspaceApi,
      project: { id: "project-1" } as CollaborationProject,
      workspace: {
        id: "workspace-1",
        location: "cloud",
      } as CollaborationWorkspace,
      currentUserId: 1,
      members: [member],
      agents: [agent("first", 11), agent("second", 12)],
      selection,
      locale: "en" as const,
    },
  };
}

describe("createProjectResourceConfigurator", () => {
  it("keeps completed template resources when later setup steps fail and retry", async () => {
    const { api, input } = createInput();
    const configurator = createProjectResourceConfigurator();
    api.projects.addExecutionEnvironment
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("Device unavailable"));
    api.agents.create
      .mockResolvedValueOnce({ id: "project-first", name: "first" })
      .mockRejectedValueOnce(new Error("Agent unavailable"));
    api.projects.createCollaborationGroup.mockRejectedValueOnce(
      new Error("Group unavailable"),
    );

    await expect(configurator.configure(input)).rejects.toThrow(
      "Device unavailable",
    );
    expect(api.agents.create).not.toHaveBeenCalled();
    await expect(configurator.configure(input)).rejects.toThrow(
      "Agent unavailable",
    );
    await expect(configurator.configure(input)).rejects.toThrow(
      "Group unavailable",
    );
    await expect(configurator.configure(input)).resolves.toEqual([member]);

    expect(api.members.add).toHaveBeenCalledTimes(1);
    expect(api.projects.addExecutionEnvironment.mock.calls).toEqual([
      ["project-1", 21],
      ["project-1", 22],
      ["project-1", 22],
    ]);
    expect(api.agents.create.mock.calls.map(([, input]) => input.name)).toEqual(
      ["first", "second", "second"],
    );
    expect(api.projects.createCollaborationGroup).toHaveBeenLastCalledWith(
      "project-1",
      {
        ...input.selection.collaborationGroupDraft,
        members: [
          { kind: "human", id: "1" },
          { kind: "human", id: "2" },
          { kind: "agent", id: "project-first" },
          { kind: "agent", id: "project-second" },
        ],
        stages: [
          {
            ...input.selection.collaborationGroupDraft!.stages[0],
            assignee: { kind: "agent", id: "project-first" },
          },
        ],
        coordinationMode: "manager",
      },
    );
  });

  it("does not configure template resources before all selected members are verified", async () => {
    const { api, input } = createInput();
    const configurator = createProjectResourceConfigurator();
    api.members.add.mockRejectedValueOnce(new Error("Permission denied"));

    await expect(configurator.configure(input)).rejects.toThrow(
      "Contributor: Permission denied",
    );

    expect(api.workspaces.addExecutionEnvironment).not.toHaveBeenCalled();
    expect(api.projects.addExecutionEnvironment).not.toHaveBeenCalled();
    expect(api.agents.create).not.toHaveBeenCalled();
    expect(api.projects.createCollaborationGroup).not.toHaveBeenCalled();
    await expect(configurator.configure(input)).resolves.toEqual([member]);
    expect(api.agents.create).toHaveBeenCalledTimes(2);
    expect(api.projects.createCollaborationGroup).toHaveBeenCalledTimes(1);
  });
});
