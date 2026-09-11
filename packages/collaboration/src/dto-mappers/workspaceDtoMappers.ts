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
import type {
  CollaborationAssignment,
  CollaborationExecution,
  CollaborationExecutionEnvironment,
  CollaborationIssue,
  CollaborationOwnedAgent,
  CollaborationPlatformResources,
  CollaborationWorkspace,
} from "../types";

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

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
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

export function mapCollaborationWorkspaceDto(
  input: WorkspaceDto,
): CollaborationWorkspace {
  const row = asRecord(input);
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    access_role: (row.access_role ??
      row.accessRole ??
      "Member") as CollaborationWorkspace["access_role"],
    member_count: Number(row.member_count ?? row.memberCount ?? 0),
    agent_count: Number(row.agent_count ?? row.agentCount ?? 0),
    execution_environment_count: Number(
      row.execution_environment_count ?? row.executionEnvironmentCount ?? 0,
    ),
    project_count: Number(row.project_count ?? row.projectCount ?? 0),
    created_by_user_id: Number(
      row.created_by_user_id ?? row.createdByUserId ?? 0,
    ),
    version: Number(row.version ?? 0),
    created_at: String(row.created_at ?? row.createdAt ?? ""),
    updated_at: String(row.updated_at ?? row.updatedAt ?? ""),
  };
}

export function mapCollaborationExecutionEnvironmentDto(
  input: WorkspaceDto,
): CollaborationExecutionEnvironment {
  const row = asRecord(input);
  return {
    id: String(row.id),
    ...((row.device_id ?? row.deviceId)
      ? { device_id: Number(row.device_id ?? row.deviceId) }
      : {}),
    ...((row.device_key ?? row.deviceKey)
      ? { device_key: String(row.device_key ?? row.deviceKey) }
      : {}),
    name: String(row.name ?? ""),
    kind:
      (row.kind ?? row.environment_type ?? row.environmentType) === "cloud_host"
        ? "cloud_host"
        : "local_device",
    owner_type:
      (row.owner_type ?? row.ownerType) === "workspace" ? "workspace" : "user",
    owner_id: String(row.owner_id ?? row.ownerId ?? ""),
    owner_name: String(row.owner_name ?? row.ownerName ?? ""),
    status: (row.status ??
      "offline") as CollaborationExecutionEnvironment["status"],
    workspace_ids: stringArray(row.workspace_ids ?? row.workspaceIds),
    updated_at: String(row.updated_at ?? row.updatedAt ?? ""),
  };
}

export function mapCollaborationOwnedAgentDto(
  input: WorkspaceDto,
): CollaborationOwnedAgent {
  const row = asRecord(input);
  return {
    id: String(row.id),
    name: String(row.name ?? ""),
    ...((row.agent_id ?? row.agentId)
      ? { agent_id: String(row.agent_id ?? row.agentId) }
      : {}),
    ...((row.team_id ?? row.teamId)
      ? { team_id: Number(row.team_id ?? row.teamId) }
      : {}),
    owner_type:
      (row.owner_type ?? row.ownerType) === "workspace" ? "workspace" : "user",
    owner_id: String(row.owner_id ?? row.ownerId ?? ""),
    owner_name: String(row.owner_name ?? row.ownerName ?? ""),
    status:
      (row.status ?? "unavailable") === "available"
        ? "available"
        : "unavailable",
    execution_environment_ids: stringArray(
      row.execution_environment_ids ?? row.executionEnvironmentIds,
    ),
    workspace_ids: stringArray(row.workspace_ids ?? row.workspaceIds),
  };
}

export function mapCollaborationPlatformResourcesDto(
  input: WorkspaceDto,
): CollaborationPlatformResources {
  const row = asRecord(input);
  const agents = row.agents;
  const environments = row.execution_environments ?? row.executionEnvironments;
  return {
    agents: Array.isArray(agents)
      ? agents.map((agent) =>
          mapCollaborationOwnedAgentDto(agent as WorkspaceDto),
        )
      : [],
    execution_environments: Array.isArray(environments)
      ? environments.map((environment) =>
          mapCollaborationExecutionEnvironmentDto(environment as WorkspaceDto),
        )
      : [],
  };
}

export function mapCollaborationAssignmentDto(
  input: WorkspaceDto,
): CollaborationAssignment {
  const row = asRecord(input);
  const rawType = row.target_type ?? row.targetType;
  return {
    id: String(row.id),
    issue_id: String(row.issue_id ?? row.issueId ?? row.loop_item_id ?? ""),
    target_type: rawType === "agent" ? "agent" : "human",
    target_id: String(row.target_id ?? row.targetId ?? ""),
    target_name: String(row.target_name ?? row.targetName ?? ""),
    workflow_step: nullableString(row.workflow_step ?? row.workflowStep),
    comment_id: nullableString(row.comment_id ?? row.commentId),
    created_by_user_id: Number(
      row.created_by_user_id ?? row.createdByUserId ?? 0,
    ),
    created_by_user_name: nullableString(
      row.created_by_user_name ?? row.createdByUserName,
    ),
    status:
      row.status === "completed" || row.status === "cancelled"
        ? row.status
        : "active",
    created_at: String(row.created_at ?? row.createdAt ?? ""),
    updated_at: String(row.updated_at ?? row.updatedAt ?? ""),
  };
}

/**
 * Reads the old exclusive assignee projection as one active assignment.
 * New writes always use the non-exclusive assignments API.
 */
export function legacyIssueAssignmentProjection(
  issue: CollaborationIssue,
): CollaborationAssignment[] {
  const agentId =
    issue.assignee_agent_id ??
    (issue.assignee_team_id == null ? null : String(issue.assignee_team_id));
  if (agentId) {
    return [
      {
        id: `legacy-agent:${issue.id}:${agentId}`,
        issue_id: issue.id,
        target_type: "agent",
        target_id: agentId,
        target_name:
          issue.assignee_agent_name ?? issue.assignee_team_name ?? "Agent",
        workflow_step: null,
        comment_id: null,
        created_by_user_id: issue.created_by_user_id,
        created_by_user_name: issue.created_by_user_name ?? null,
        status: "active",
        created_at: issue.updated_at,
        updated_at: issue.updated_at,
      },
    ];
  }
  if (issue.assignee_user_id != null) {
    return [
      {
        id: `legacy-human:${issue.id}:${issue.assignee_user_id}`,
        issue_id: issue.id,
        target_type: "human",
        target_id: String(issue.assignee_user_id),
        target_name: issue.assignee_name ?? "Member",
        workflow_step: null,
        comment_id: null,
        created_by_user_id: issue.created_by_user_id,
        created_by_user_name: issue.created_by_user_name ?? null,
        status: "active",
        created_at: issue.updated_at,
        updated_at: issue.updated_at,
      },
    ];
  }
  return [];
}
