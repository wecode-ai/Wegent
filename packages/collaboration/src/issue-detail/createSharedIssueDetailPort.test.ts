// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import { createSharedIssueDetailPort } from "./createSharedIssueDetailPort";

describe("createSharedIssueDetailPort", () => {
  it("owns the single cloud-to-detail mapping and delegates host file saving", async () => {
    const create = vi.fn().mockResolvedValue({ id: "issue-1" });
    const update = vi.fn().mockResolvedValue({ id: "issue-1" });
    const listBindings = vi.fn().mockResolvedValue([
      {
        id: 2,
        projectId: "project-1",
        issueId: "issue-1",
        taskUserId: 3,
        deviceId: "device-1",
        taskId: "task-1",
        taskTitle: "Task",
        backendTaskId: 4,
        linkedAt: "2026-09-10T00:00:00Z",
      },
    ]);
    const read = vi.fn().mockResolvedValue(new Blob(["result"]));
    const saveFile = vi.fn().mockResolvedValue(undefined);
    const api = {
      issues: {
        get: vi.fn(),
        create,
        update,
        assign: vi.fn(),
      },
      attachments: {
        list: vi.fn(),
        upload: vi.fn(),
        read,
        remove: vi.fn(),
      },
      collaborators: {
        list: vi.fn().mockResolvedValue([
          {
            id: "collaborator-1",
            issueId: "issue-1",
            userId: 5,
            userName: "User",
            email: null,
            source: "manual",
            addedByUserId: 1,
            createdAt: "2026-09-10T00:00:00Z",
          },
        ]),
        add: vi.fn(),
        remove: vi.fn(),
      },
      taskBindings: { list: listBindings },
      members: { list: vi.fn() },
      agents: { list: vi.fn() },
      deliveries: {
        list: vi.fn().mockResolvedValue([
          {
            id: "delivery-1",
            issueId: "issue-1",
            status: "delivered",
            assets: [
              {
                id: "asset-1",
                kind: "file",
                displayName: "result.txt",
                relativePath: "result.txt",
                contentType: "text/plain",
                sizeBytes: 6,
                sha256: "abc",
              },
            ],
            fulfillments: [],
            createdAt: "2026-09-10T00:00:00Z",
            deliveredAt: "2026-09-10T00:01:00Z",
          },
        ]),
        get: vi.fn(),
      },
    } as unknown as SharedWorkspaceApi;

    const port = createSharedIssueDetailPort(api, saveFile);

    await port.issues.create("project-1", {
      title: "Human-owned Issue",
      assignee_user_id: 7,
      notify_assignee: false,
    });
    expect(create).toHaveBeenCalledWith("project-1", {
      title: "Human-owned Issue",
      assigneeUserId: 7,
      notifyAssignee: false,
    });

    await port.issues.update("issue-1", {
      version: 7,
      parent_id: "parent-1",
      due_at: "2026-09-12",
    });
    expect(update).toHaveBeenCalledWith("issue-1", {
      version: 7,
      parentId: "parent-1",
      dueAt: "2026-09-12",
    });

    await expect(
      port.taskBindings.list("issue-1", "project-1"),
    ).resolves.toEqual([
      expect.objectContaining({
        cloud_project_id: "project-1",
        loop_item_id: "issue-1",
        device_id: "device-1",
        task_id: "task-1",
      }),
    ]);
    await expect(port.collaborators.list("issue-1")).resolves.toEqual([
      expect.objectContaining({
        loop_item_id: "issue-1",
        user_id: 5,
        user_name: "User",
      }),
    ]);
    await expect(port.deliveries.list("issue-1")).resolves.toEqual([
      expect.objectContaining({
        loop_item_id: "issue-1",
        assets: [
          expect.objectContaining({
            display_name: "result.txt",
            size_bytes: 6,
          }),
        ],
      }),
    ]);

    await port.attachments.download("attachment-1", "result.txt");
    expect(read).toHaveBeenCalledWith("attachment-1");
    expect(saveFile).toHaveBeenCalledWith(expect.any(Blob), "result.txt");
  });
});
