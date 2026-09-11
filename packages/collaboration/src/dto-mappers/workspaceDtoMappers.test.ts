// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  mapCollaborationExecutionDto,
  mapWorkspaceDeliveryDto,
  mapWorkspaceIssueCollaboratorDto,
  mapWorkspaceTaskBindingDto,
  mapWorkspaceWorkflowPlanDto,
  mapWorkspaceWorkflowStageContextDto,
} from "./workspaceDtoMappers";

describe("workspace DTO mappers", () => {
  it("normalizes task bindings and uses the request project context when needed", () => {
    expect(
      mapWorkspaceTaskBindingDto(
        {
          id: "42",
          loop_item_id: "issue-1",
          task_user_id: "7",
          device_id: "device-1",
          task_id: "task-1",
          task_title: "Task",
          backend_task_id: "99",
          modelSelection: { model: "gpt" },
          workflow_node_id: "node-1",
          binding_type: "user",
          linked_at: "2026-09-10T00:00:00Z",
        },
        "project-1",
      ),
    ).toEqual({
      id: "42",
      projectId: "project-1",
      issueId: "issue-1",
      taskUserId: 7,
      deviceId: "device-1",
      taskId: "task-1",
      taskTitle: "Task",
      backendTaskId: 99,
      modelSelection: { model: "gpt" },
      workflowNodeId: "node-1",
      bindingType: "user",
      linkedAt: "2026-09-10T00:00:00Z",
    });
    expect(() => mapWorkspaceTaskBindingDto({ id: 43 })).toThrow(
      "Workspace task binding 43 is missing cloud_project_id",
    );
  });

  it("normalizes workflow plans and collaborators without sharing transport types", () => {
    expect(
      mapWorkspaceWorkflowPlanDto({
        run_id: "run-1",
        issue_id: "issue-1",
        stage_id: "stage-1",
        plan_version: 2,
        approval_policy: "automatic",
        status: "running",
        summary: "Plan",
        items: [{ id: "item-1" }],
        manager_run: { id: "manager-1" },
      }),
    ).toMatchObject({
      runId: "run-1",
      issueId: "issue-1",
      stageId: "stage-1",
      planVersion: 2,
      approvalPolicy: "automatic",
      status: "running",
    });
    expect(
      mapWorkspaceIssueCollaboratorDto({
        id: 5,
        loop_item_id: "issue-1",
        user_id: "8",
        user_name: "User",
        email: null,
        source: "manual",
        added_by_user_id: "1",
        created_at: "2026-09-10T00:00:00Z",
      }),
    ).toEqual({
      id: "5",
      issueId: "issue-1",
      userId: 8,
      userName: "User",
      email: null,
      source: "manual",
      addedByUserId: 1,
      createdAt: "2026-09-10T00:00:00Z",
    });
  });

  it("normalizes workflow stage context instruction casing", () => {
    expect(
      mapWorkspaceWorkflowStageContextDto({
        compiled_task_instruction: "Run the deployment",
        source: "delivery",
      }),
    ).toEqual({
      compiledTaskInstruction: "Run the deployment",
      source: "delivery",
    });
    expect(
      mapWorkspaceWorkflowStageContextDto({
        compiledTaskInstruction: "Already normalized",
        source: "shared",
      }),
    ).toEqual({
      compiledTaskInstruction: "Already normalized",
      source: "shared",
    });
    expect(() =>
      mapWorkspaceWorkflowStageContextDto({ source: "delivery" }),
    ).toThrow(
      "Workspace workflow stage context is missing compiled_task_instruction",
    );
  });

  it("normalizes delivery details and nested assets", () => {
    expect(
      mapWorkspaceDeliveryDto({
        id: "delivery-1",
        loop_item_id: "issue-1",
        status: "delivered",
        markdown: "# Result",
        chat: { message: "done" },
        assets: [
          {
            id: "asset-1",
            kind: "file",
            display_name: "report.txt",
            relative_path: "report.txt",
            content_type: "text/plain",
            size_bytes: "12",
            sha256: "abc",
          },
        ],
        fulfillments: [{ requirement_id: "result", kind: "file" }],
        created_at: "2026-09-10T00:00:00Z",
        delivered_at: "2026-09-10T01:00:00Z",
      }),
    ).toMatchObject({
      id: "delivery-1",
      issueId: "issue-1",
      status: "delivered",
      markdown: "# Result",
      assets: [{ displayName: "report.txt", sizeBytes: 12 }],
    });
  });

  it("uses one execution normalization for camelCase and snake_case responses", () => {
    const camel = mapCollaborationExecutionDto({
      id: "7",
      loopItemId: "issue-1",
      cloudProjectId: "project-1",
      taskTitle: "Issue",
      status: "waiting_runtime",
      displayState: "waiting_runtime",
      canSelectRuntime: true,
      version: "2",
    });
    const snake = mapCollaborationExecutionDto({
      id: "7",
      loop_item_id: "issue-1",
      cloud_project_id: "project-1",
      task_title: "Issue",
      status: "waiting_runtime",
      display_state: "waiting_runtime",
      can_select_runtime: true,
      version: "2",
    });

    expect(camel).toEqual(snake);
    expect(camel).toMatchObject({
      id: 7,
      executor_type: "project_robot",
      observed_state: "unconfirmed",
      sync_state: "pending",
      can_select_runtime: true,
      version: 2,
    });
  });
});
