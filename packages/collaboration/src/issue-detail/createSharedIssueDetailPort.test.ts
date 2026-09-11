// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import { createSharedIssueDetailPort } from "./createSharedIssueDetailPort";

describe("createSharedIssueDetailPort", () => {
  it("owns the single cloud-to-detail mapping and delegates host file saving", async () => {
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
        create: vi.fn(),
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
      workflowPlans: {},
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

  it("owns the cloud workflow node, delivery, decision, and refresh chain", async () => {
    const refreshedIssue = { id: "issue-1", version: 2 };
    const getIssue = vi.fn().mockResolvedValue(refreshedIssue);
    const runWorkflowNode = vi.fn().mockResolvedValue({ id: "run-1" });
    const decideNode = vi.fn().mockResolvedValue(refreshedIssue);
    const createDelivery = vi.fn().mockResolvedValue({ id: "delivery-1" });
    const addAsset = vi
      .fn()
      .mockResolvedValue({ id: "asset-1", sha256: "sha-1" });
    const finalize = vi.fn().mockResolvedValue({ id: "delivery-1" });
    const discardDraft = vi.fn().mockResolvedValue(undefined);
    const api = {
      issues: {
        get: getIssue,
        create: vi.fn(),
        update: vi.fn(),
        assign: vi.fn(),
      },
      attachments: {
        list: vi.fn(),
        upload: vi.fn(),
        read: vi.fn(),
        remove: vi.fn(),
      },
      collaborators: {
        list: vi.fn(),
        add: vi.fn(),
        remove: vi.fn(),
      },
      taskBindings: { list: vi.fn() },
      workflowPlans: { decideNode },
      members: { list: vi.fn() },
      agents: { list: vi.fn() },
      automations: { runWorkflowNode },
      deliveries: {
        list: vi.fn(),
        get: vi.fn(),
        create: createDelivery,
        addAsset,
        finalize,
        discardDraft,
      },
    } as unknown as SharedWorkspaceApi;
    const port = createSharedIssueDetailPort(api, vi.fn());

    await expect(
      port.workflowNodes.run("project-1", "issue-1", "stage-1", "automation-1"),
    ).resolves.toBe(refreshedIssue);
    expect(runWorkflowNode).toHaveBeenCalledWith(
      "project-1",
      "issue-1",
      "stage-1",
      "automation-1",
    );

    const file = new File(["report"], "report.txt", {
      type: "text/plain",
    });
    await expect(
      port.workflowNodes.complete(
        "issue-1",
        {
          id: "stage-1",
          name: "Review",
          depends_on: [],
          required: true,
          workspace_policy: "composer",
          status: "awaiting_approval",
          required_deliverables: [
            {
              id: "report",
              name: "Report",
              description: "",
              value_type: "file",
            },
          ],
        },
        [
          {
            id: 1,
            cloud_project_id: "project-1",
            loop_item_id: "issue-1",
            task_user_id: 1,
            device_id: "device-1",
            task_id: "task-1",
            task_title: "Task",
            backend_task_id: 2,
            workflow_node_id: "stage-1",
            linked_at: "2026-09-11T00:00:00Z",
          },
        ],
        "approve",
        "",
        [
          {
            requirement: {
              id: "report",
              name: "Report",
              description: "",
              value_type: "file",
            },
            files: [file],
          },
        ],
      ),
    ).resolves.toBe(refreshedIssue);

    expect(createDelivery).toHaveBeenCalledWith(
      "issue-1",
      expect.objectContaining({
        sourceTask: expect.objectContaining({
          deviceId: "device-1",
          taskId: "task-1",
          backendTaskId: 2,
        }),
      }),
    );
    expect(addAsset).toHaveBeenCalledWith(
      "delivery-1",
      file,
      "report/report.txt",
    );
    expect(finalize).toHaveBeenCalledWith("delivery-1", {
      fulfillments: [
        {
          requirement_id: "report",
          kind: "file",
          asset_ids: ["asset-1"],
        },
      ],
    });
    expect(decideNode).toHaveBeenCalledWith(
      "issue-1",
      "stage-1",
      "approve",
      "",
    );
    expect(discardDraft).not.toHaveBeenCalled();
    expect(getIssue).toHaveBeenCalledTimes(2);
  });

  it("keeps an accepted workflow run when the transport reports an error", async () => {
    const refreshedIssue = {
      id: "issue-1",
      workflow: {
        nodes: [{ id: "stage-1", status: "queued" }],
      },
    };
    const runError = new Error("connection closed");
    const api = {
      issues: {
        get: vi.fn().mockResolvedValue(refreshedIssue),
        create: vi.fn(),
        update: vi.fn(),
        assign: vi.fn(),
      },
      attachments: {
        list: vi.fn(),
        upload: vi.fn(),
        read: vi.fn(),
        remove: vi.fn(),
      },
      collaborators: {
        list: vi.fn(),
        add: vi.fn(),
        remove: vi.fn(),
      },
      taskBindings: { list: vi.fn() },
      workflowPlans: { decideNode: vi.fn() },
      members: { list: vi.fn() },
      agents: { list: vi.fn() },
      automations: {
        runWorkflowNode: vi.fn().mockRejectedValue(runError),
      },
      deliveries: {
        list: vi.fn(),
        get: vi.fn(),
        create: vi.fn(),
        addAsset: vi.fn(),
        finalize: vi.fn(),
        discardDraft: vi.fn(),
      },
    } as unknown as SharedWorkspaceApi;
    const port = createSharedIssueDetailPort(api, vi.fn());

    await expect(
      port.workflowNodes.run("project-1", "issue-1", "stage-1", "automation-1"),
    ).resolves.toBe(refreshedIssue);
    expect(api.issues.get).toHaveBeenCalledWith("issue-1");
  });
});
