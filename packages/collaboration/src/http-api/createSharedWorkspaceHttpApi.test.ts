// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  createSharedWorkspaceHttpApi,
  type SharedWorkspaceHttpTransport,
  workspaceHttpRequestBody,
} from "./createSharedWorkspaceHttpApi";

function createTransport(): {
  transport: SharedWorkspaceHttpTransport;
  get: ReturnType<typeof vi.fn>;
  post: ReturnType<typeof vi.fn>;
  patch: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
} {
  const get = vi.fn();
  const post = vi.fn();
  const patch = vi.fn();
  const remove = vi.fn();
  return {
    transport: { get, post, patch, delete: remove },
    get,
    post,
    patch,
    remove,
  };
}

describe("createSharedWorkspaceHttpApi", () => {
  it("owns canonical workspace resource endpoints and DTO mapping", async () => {
    const { transport, get, post, patch, remove } = createTransport();
    get
      .mockResolvedValueOnce({
        items: [
          {
            id: "workspace-1",
            name: "研发空间",
            accessRole: "Owner",
            memberCount: 2,
          },
        ],
      })
      .mockResolvedValueOnce({
        items: [
          {
            id: "team-kind-12",
            teamId: 12,
            name: "研发智能体",
            ownerType: "user",
          },
        ],
      })
      .mockResolvedValueOnce({
        agents: [],
        executionEnvironments: [
          {
            id: "environment-1",
            deviceId: 22,
            name: "云主机",
            kind: "cloud_host",
            ownerType: "user",
            status: "online",
          },
        ],
      });
    post.mockResolvedValue({
      id: 8,
      userId: 8,
      userName: "王芳",
      role: "Developer",
    });
    const api = createSharedWorkspaceHttpApi(transport);

    await expect(api.workspaces.list()).resolves.toMatchObject([
      { id: "workspace-1", access_role: "Owner", member_count: 2 },
    ]);
    await expect(
      api.workspaces.listAgents("workspace/1"),
    ).resolves.toMatchObject([{ id: "12", team_id: 12 }]);
    await expect(api.resources.list()).resolves.toMatchObject({
      execution_environments: [{ device_id: 22, owner_type: "user" }],
    });
    await expect(
      api.workspaces.addMember("workspace/1", { userId: 8 }),
    ).resolves.toMatchObject({ user_id: 8, user_name: "王芳" });
    await api.workspaces.removeExecutionEnvironment("workspace/1", 22);

    expect(get).toHaveBeenNthCalledWith(
      2,
      "/v1/workspaces/workspace%2F1/agents",
    );
    expect(post).toHaveBeenCalledWith("/v1/workspaces/workspace%2F1/members", {
      user_id: 8,
      role: "Developer",
    });
    expect(remove).toHaveBeenCalledWith(
      "/v1/workspaces/workspace%2F1/execution-environments/22",
    );
  });

  it("shares assignment, comment, and project Agent operations", async () => {
    const { transport, get, post, patch } = createTransport();
    get
      .mockResolvedValueOnce({
        items: [
          {
            id: "comment-1",
            issue_id: "issue-1",
            target_type: "agent",
            target_id: "agent-1",
            target_name: "Codex",
            workflow_step: null,
            body: "",
            comment_id: "comment-1",
          },
        ],
      })
      .mockResolvedValueOnce([
        {
          id: "agent-1",
          project_id: "project-1",
          name: "Codex",
          runtime: "wegent",
          wegent_team_id: 9,
          workspace_binding: { type: "standalone", status: "ready" },
        },
      ]);
    post
      .mockResolvedValueOnce({
        assignment: {
          id: "comment-2",
          issue_id: "issue-1",
          target_type: "human",
          target_id: "8",
          target_name: "王芳",
          workflow_step: "review",
          body: "",
          comment_id: "comment-2",
        },
        comment: null,
        issue: { id: "issue-1" },
      })
      .mockResolvedValueOnce({
        id: "agent-2",
        projectId: "project-1",
        name: "Custom Codex",
        runtime: "codex",
      });
    patch.mockResolvedValue({
      id: "agent-2",
      project_id: "project-1",
      name: "Archived Codex",
      status: "archived",
    });

    const api = createSharedWorkspaceHttpApi(transport);

    await expect(api.assignments.list("issue/1")).resolves.toMatchObject([
      {
        id: "comment-1",
        comment_id: "comment-1",
        target_type: "agent",
        target_id: "agent-1",
      },
    ]);
    await expect(
      api.assignments.create("issue/1", {
        targetType: "human",
        targetId: "8",
        workflowStep: "review",
        notifyTarget: true,
      }),
    ).resolves.toMatchObject({
      assignment: { id: "comment-2", comment_id: "comment-2" },
      comment: null,
    });
    await expect(api.agents.list("project/1")).resolves.toMatchObject([
      {
        id: "agent-1",
        projectId: "project-1",
        wegentTeamId: 9,
        workspaceBinding: { type: "standalone", status: "ready" },
      },
    ]);
    await api.agents.create("project/1", {
      name: "Custom Codex",
      executionDeviceId: "device-1",
      workspaceBinding: { type: "backend_project", projectId: 5 },
    });
    await api.agents.update("project/1", "agent/2", {
      version: 1,
      status: "archived",
    });

    expect(post).toHaveBeenNthCalledWith(
      1,
      "/v1/loop-items/issue%2F1/assignments",
      {
        target_type: "human",
        target_id: "8",
        workflow_step: "review",
        notify_target: true,
      },
    );
    expect(post).toHaveBeenNthCalledWith(
      2,
      "/v1/cloud-projects/project%2F1/chat-agents",
      {
        name: "Custom Codex",
        execution_device_id: "device-1",
        workspace_binding: { type: "backend_project", project_id: 5 },
      },
    );
    expect(patch).toHaveBeenCalledWith(
      "/v1/cloud-projects/project%2F1/chat-agents/agent%2F2",
      { version: 1, status: "archived" },
    );
  });

  it("converts nested request keys without mutating scalar values", () => {
    expect(
      workspaceHttpRequestBody({
        executionDeviceId: "device-1",
        plugins: [{ marketplaceId: "official", enabled: true }],
      }),
    ).toEqual({
      execution_device_id: "device-1",
      plugins: [{ marketplace_id: "official", enabled: true }],
    });
  });
});
