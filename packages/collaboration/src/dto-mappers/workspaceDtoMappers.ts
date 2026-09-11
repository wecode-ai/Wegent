// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type {
  WorkspaceDelivery,
  WorkspaceDeliveryAsset,
  WorkspaceIssueCollaborator,
  WorkspaceTaskBinding,
  WorkspaceWorkflowPlan,
} from "../ports/SharedWorkspaceApi";
import type { CollaborationExecution } from "../types";

type WorkspaceDto = object | Record<string, unknown>;

function asRecord(input: WorkspaceDto): Record<string, unknown> {
  return input as Record<string, unknown>;
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value == null ? null : Number(value);
}

function camelOrSnake(
  row: Record<string, unknown>,
  camel: string,
  snake: string,
): unknown {
  return row[camel] ?? row[snake];
}

export function mapWorkspaceTaskBindingDto(
  input: WorkspaceDto,
  contextProjectId?: string,
): WorkspaceTaskBinding {
  const row = asRecord(input);
  const projectId = row.cloud_project_id ?? row.projectId ?? contextProjectId;
  if (projectId == null) {
    throw new Error(
      `Workspace task binding ${String(row.id)} is missing cloud_project_id`,
    );
  }
  const bindingType = row.binding_type ?? row.bindingType;
  return {
    id: String(row.id),
    projectId: String(projectId),
    issueId: nullableString(row.loop_item_id ?? row.issueId),
    taskUserId: Number(row.task_user_id ?? row.taskUserId),
    deviceId: String(row.device_id ?? row.deviceId ?? ""),
    taskId: String(row.task_id ?? row.taskId ?? ""),
    taskTitle: nullableString(row.task_title ?? row.taskTitle),
    backendTaskId: nullableNumber(row.backend_task_id ?? row.backendTaskId),
    modelSelection:
      (row.modelSelection as Record<string, unknown> | null | undefined) ??
      (row.model_selection as Record<string, unknown> | null | undefined) ??
      null,
    workflowNodeId: nullableString(row.workflow_node_id ?? row.workflowNodeId),
    ...(bindingType === "system" || bindingType === "user"
      ? { bindingType }
      : {}),
    linkedAt: String(row.linked_at ?? row.linkedAt ?? ""),
  };
}

export function mapWorkspaceWorkflowPlanDto(
  input: WorkspaceDto,
): WorkspaceWorkflowPlan {
  const row = asRecord(input);
  return {
    runId: String(row.run_id ?? row.runId ?? ""),
    issueId: String(row.issue_id ?? row.issueId ?? ""),
    stageId: String(row.stage_id ?? row.stageId ?? ""),
    planVersion: Number(row.plan_version ?? row.planVersion),
    approvalPolicy:
      (row.approval_policy ?? row.approvalPolicy) === "automatic"
        ? "automatic"
        : "required",
    status: row.status as WorkspaceWorkflowPlan["status"],
    summary: String(row.summary ?? ""),
    items: Array.isArray(row.items)
      ? row.items.map((item) => ({ ...(item as Record<string, unknown>) }))
      : [],
    managerRun:
      ((row.manager_run ?? row.managerRun) as
        | Record<string, unknown>
        | null
        | undefined) ?? null,
  };
}

export function mapWorkspaceWorkflowStageContextDto(
  input: WorkspaceDto,
): Record<string, unknown> & { compiledTaskInstruction: string } {
  const row = asRecord(input);
  const {
    compiled_task_instruction: compiledTaskInstructionSnake,
    compiledTaskInstruction: compiledTaskInstructionCamel,
    ...context
  } = row;
  const compiledTaskInstruction =
    compiledTaskInstructionCamel ?? compiledTaskInstructionSnake;
  if (typeof compiledTaskInstruction !== "string") {
    throw new TypeError(
      "Workspace workflow stage context is missing compiled_task_instruction",
    );
  }
  return {
    ...context,
    compiledTaskInstruction,
  };
}

export function mapWorkspaceIssueCollaboratorDto(
  input: WorkspaceDto,
): WorkspaceIssueCollaborator {
  const row = asRecord(input);
  return {
    id: String(row.id),
    issueId: String(row.loop_item_id ?? row.issueId ?? ""),
    userId: Number(row.user_id ?? row.userId),
    userName: String(row.user_name ?? row.userName ?? ""),
    email: nullableString(row.email),
    source: String(row.source ?? ""),
    addedByUserId: Number(row.added_by_user_id ?? row.addedByUserId),
    createdAt: String(row.created_at ?? row.createdAt ?? ""),
  };
}

export function mapWorkspaceDeliveryAssetDto(
  input: WorkspaceDto,
): WorkspaceDeliveryAsset {
  const row = asRecord(input);
  return {
    id: String(row.id),
    kind: String(row.kind ?? ""),
    displayName: String(row.display_name ?? row.displayName ?? ""),
    relativePath: String(row.relative_path ?? row.relativePath ?? ""),
    contentType: nullableString(row.content_type ?? row.contentType),
    sizeBytes: Number(row.size_bytes ?? row.sizeBytes),
    sha256: String(row.sha256 ?? ""),
  };
}

export function mapWorkspaceDeliveryDto(
  input: WorkspaceDto,
): WorkspaceDelivery {
  const row = asRecord(input);
  const markdown = row.markdown;
  return {
    id: String(row.id),
    issueId: String(row.loop_item_id ?? row.issueId ?? ""),
    status: row.status === "delivered" ? "delivered" : "draft",
    ...(markdown === undefined ? {} : { markdown: String(markdown) }),
    chat: (row.chat as Record<string, unknown> | null | undefined) ?? null,
    assets: Array.isArray(row.assets)
      ? row.assets.map((asset) =>
          mapWorkspaceDeliveryAssetDto(asset as WorkspaceDto),
        )
      : [],
    fulfillments: Array.isArray(row.fulfillments)
      ? row.fulfillments.map((item) => ({
          ...(item as Record<string, unknown>),
        }))
      : [],
    createdAt: String(row.created_at ?? row.createdAt ?? ""),
    deliveredAt: nullableString(row.delivered_at ?? row.deliveredAt),
  };
}

export function mapCollaborationExecutionDto(
  input: WorkspaceDto,
): CollaborationExecution {
  const row = asRecord(input);
  return {
    id: Number(row.id),
    loop_item_id: String(camelOrSnake(row, "loopItemId", "loop_item_id") ?? ""),
    cloud_project_id: String(
      camelOrSnake(row, "cloudProjectId", "cloud_project_id") ?? "",
    ),
    task_title: String(camelOrSnake(row, "taskTitle", "task_title") ?? ""),
    task_status: nullableString(camelOrSnake(row, "taskStatus", "task_status")),
    task_priority: nullableString(
      camelOrSnake(row, "taskPriority", "task_priority"),
    ),
    executor_type: String(
      camelOrSnake(row, "executorType", "executor_type") ?? "project_robot",
    ),
    agent_id: nullableString(camelOrSnake(row, "agentId", "agent_id")),
    team_id: nullableNumber(camelOrSnake(row, "teamId", "team_id")),
    assigner_user_id: Number(
      camelOrSnake(row, "assignerUserId", "assigner_user_id") ?? 0,
    ),
    executor_owner_user_id: nullableNumber(
      camelOrSnake(row, "executorOwnerUserId", "executor_owner_user_id"),
    ),
    status: String(row.status ?? ""),
    display_state: String(
      camelOrSnake(row, "displayState", "display_state") ?? "unknown",
    ),
    observed_state: String(
      camelOrSnake(row, "observedState", "observed_state") ?? "unconfirmed",
    ),
    sync_state: String(
      camelOrSnake(row, "syncState", "sync_state") ?? "pending",
    ),
    queued_at: nullableString(camelOrSnake(row, "queuedAt", "queued_at")),
    started_at: nullableString(camelOrSnake(row, "startedAt", "started_at")),
    completed_at: nullableString(
      camelOrSnake(row, "completedAt", "completed_at"),
    ),
    error_message: nullableString(
      camelOrSnake(row, "errorMessage", "error_message"),
    ),
    execution_note: nullableString(
      camelOrSnake(row, "executionNote", "execution_note"),
    ),
    runtime_profile_id: nullableString(
      camelOrSnake(row, "runtimeProfileId", "runtime_profile_id"),
    ),
    runtime_source: nullableString(
      camelOrSnake(row, "runtimeSource", "runtime_source"),
    ),
    can_select_runtime: Boolean(
      camelOrSnake(row, "canSelectRuntime", "can_select_runtime"),
    ),
    waiting_runtime_reason: nullableString(
      camelOrSnake(row, "waitingRuntimeReason", "waiting_runtime_reason"),
    ),
    version: Number(row.version ?? 0),
    created_at: String(camelOrSnake(row, "createdAt", "created_at") ?? ""),
    updated_at: String(camelOrSnake(row, "updatedAt", "updated_at") ?? ""),
  };
}
