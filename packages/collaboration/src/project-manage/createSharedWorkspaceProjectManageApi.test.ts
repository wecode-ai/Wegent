// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";
import type { CollaborationIssue, CollaborationProject } from "../types";
import {
  createSharedWorkspaceProjectManageApi,
  type SharedProjectManageWorkspaceApi,
} from "./createSharedWorkspaceProjectManageApi";

const project = {
  id: "project-1",
  version: 2,
} as CollaborationProject;

const issue = {
  id: "issue-1",
  version: 3,
  tags: ["bug"],
} as CollaborationIssue;

function createWorkspaceApi() {
  const updateProject = vi.fn().mockResolvedValue(project);
  const updateIssue = vi.fn().mockResolvedValue(issue);
  const getBoardSnapshot = vi.fn().mockResolvedValue({
    items: [issue],
    members: [],
    agents: [],
    taskBindings: [],
  });
  const listMembers = vi.fn().mockResolvedValue([]);
  const searchUsers = vi
    .fn()
    .mockResolvedValue([{ id: 7, user_name: "Ada", email: "ada@example.com" }]);
  const addMember = vi.fn().mockResolvedValue({
    id: 1,
    user_id: 7,
    user_name: "Ada",
    email: "ada@example.com",
    role: "Developer",
  });
  const updateMember = vi.fn().mockResolvedValue({
    id: 1,
    user_id: 7,
    user_name: "Ada",
    email: "ada@example.com",
    role: "Maintainer",
    capability_description: "Release owner",
  });
  const removeMember = vi.fn().mockResolvedValue(undefined);

  const workspaceApi: SharedProjectManageWorkspaceApi = {
    projects: { update: updateProject },
    issues: {
      getBoardSnapshot,
      update: updateIssue,
    },
    members: {
      list: listMembers,
      searchUsers,
      add: addMember,
      update: updateMember,
      remove: removeMember,
    },
  };

  return {
    workspaceApi,
    updateProject,
    updateIssue,
    getBoardSnapshot,
    listMembers,
    searchUsers,
    addMember,
    updateMember,
    removeMember,
  };
}

describe("createSharedWorkspaceProjectManageApi", () => {
  it("maps project, issue, member, and user reads to the canonical workspace API", async () => {
    const mocks = createWorkspaceApi();
    const api = createSharedWorkspaceProjectManageApi(mocks.workspaceApi);

    await expect(api.listMembers("project-1")).resolves.toEqual([]);
    await expect(api.listItems("project-1")).resolves.toEqual({
      items: [issue],
    });
    await expect(api.searchUsers("Ada")).resolves.toEqual({
      users: [{ id: 7, user_name: "Ada", email: "ada@example.com" }],
    });

    expect(mocks.listMembers).toHaveBeenCalledWith("project-1");
    expect(mocks.getBoardSnapshot).toHaveBeenCalledWith("project-1");
    expect(mocks.searchUsers).toHaveBeenCalledWith("Ada");
  });

  it("maps member mutations once and preserves the Owner invitation contract", async () => {
    const mocks = createWorkspaceApi();
    const api = createSharedWorkspaceProjectManageApi(mocks.workspaceApi);

    await api.addMember("project-1", 7, "Owner");
    await api.updateMember("project-1", 7, {
      role: "Maintainer",
      capability_description: "Release owner",
    });
    await api.removeMember("project-1", 7);

    expect(mocks.addMember).toHaveBeenCalledWith("project-1", 7, undefined);
    expect(mocks.updateMember).toHaveBeenCalledWith("project-1", 7, {
      role: "Maintainer",
      capabilityDescription: "Release owner",
    });
    expect(mocks.removeMember).toHaveBeenCalledWith("project-1", 7);
  });

  it("converts manage form updates to canonical workspace input names", async () => {
    const mocks = createWorkspaceApi();
    const api = createSharedWorkspaceProjectManageApi(mocks.workspaceApi);
    const statuses = [{ id: "todo", name: "Todo", color: "gray" as const }];

    await api.updateItem("issue-1", { version: 3, tags: ["bug"] });
    await api.updateProject("project-1", {
      version: 2,
      tags: ["backend"],
      visibility: "public",
      provider_config: { repository: "wecode-ai/Wegent" },
      board_config: {
        group_by: "status",
        processing_start_status_id: "todo",
        statuses,
      },
      card_display: {
        show_assignee: true,
        show_priority: false,
        show_tags: true,
        show_date: false,
      },
    });

    expect(mocks.updateIssue).toHaveBeenCalledWith("issue-1", {
      version: 3,
      tags: ["bug"],
    });
    expect(mocks.updateProject).toHaveBeenCalledWith("project-1", {
      version: 2,
      tags: ["backend"],
      visibility: "public",
      providerConfig: { repository: "wecode-ai/Wegent" },
      boardConfig: {
        group_by: "status",
        processing_start_status_id: "todo",
        statuses,
      },
      cardDisplay: {
        show_assignee: true,
        show_priority: false,
        show_tags: true,
        show_date: false,
      },
    });
  });
});
