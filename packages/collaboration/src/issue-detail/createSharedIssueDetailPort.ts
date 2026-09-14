// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type {
  CollaborationAttachment,
  CollaborationIssue,
  CollaborationMember,
} from "../types";
import type { IssueWorkflowPlanView } from "./IssueWorkflowPlanSection";
import type { WorkflowDeliverableDraft } from "./WorkflowStageCompletionDialog";
import type { SharedWorkflowNode } from "./workflowTypes";

export interface SharedIssueDetailTaskBinding {
  id: string;
  cloud_project_id: string;
  loop_item_id: string | null;
  task_user_id: number;
  device_id: string;
  task_id: string;
  task_title: string | null;
  backend_task_id: number | null;
  modelSelection?: Record<string, unknown> | null;
  workflow_node_id?: string | null;
  binding_type?: "system" | "user";
  linked_at: string;
}

export interface SharedIssueDetailCollaborator {
  id: string;
  loop_item_id: string;
  user_id: number;
  user_name: string;
  email: string | null;
  source: string;
  added_by_user_id: number;
  created_at: string;
}

export interface SharedIssueDetailWorkflowPlan {
  run_id: string;
  issue_id: string;
  stage_id: string;
  plan_version: number;
  approval_policy: "required" | "automatic";
  status:
    | "idle"
    | "planning"
    | "awaiting_approval"
    | "dispatching"
    | "running"
    | "awaiting_review"
    | "paused"
    | "completed"
    | "failed";
  summary: string;
  items: object[];
  manager_run?: object | null;
}

export interface SharedIssueDetailDeliveryAsset {
  id: string;
  kind: string;
  display_name: string;
  relative_path: string;
  content_type: string | null;
  size_bytes: number;
  sha256: string;
}

export interface SharedIssueDetailDelivery {
  id: string;
  loop_item_id: string;
  status: "draft" | "delivered";
  assets: SharedIssueDetailDeliveryAsset[];
  fulfillments: Array<Record<string, unknown>>;
  created_at: string;
  delivered_at: string | null;
}

export interface SharedIssueDetailDeliveryDetail extends SharedIssueDetailDelivery {
  markdown: string;
  chat: Record<string, unknown> | null;
}

export interface SharedIssueDetailAgent {
  id: string;
  name: string;
  status?: string;
}

export interface SharedIssueDetailCreateInput {
  title: string;
  description?: string;
  status?: string;
  priority?: CollaborationIssue["priority"];
  due_at?: string;
  parent_id?: string | null;
  tags?: string[];
  local_project_id?: number | null;
  local_project_name?: string | null;
  workflow?: Record<string, unknown> | null;
  execution_config?: Record<string, unknown> | null;
  automation_rule_id?: string | null;
  creator_name?: string;
}

export interface SharedIssueDetailUpdateInput {
  version: number;
  title?: string;
  description?: string;
  status?: string;
  priority?: CollaborationIssue["priority"];
  parent_id?: string | null;
  assignee_user_id?: number | null;
  assignee_agent_id?: string | null;
  assignee_team_id?: number | null;
  due_at?: string | null;
  tags?: string[];
  workflow?: Record<string, unknown> | null;
  execution_config?: Record<string, unknown> | null;
  automation_rule_id?: string | null;
}

export interface SharedIssueDetailAssignmentInput {
  version: number;
  assigneeType: "user" | "agent" | "team";
  assigneeId: string;
  notifyAssignee?: boolean;
}

export interface SharedIssueDetailPort {
  issues: {
    get(issueId: string): Promise<CollaborationIssue>;
    create(
      projectId: string,
      input: SharedIssueDetailCreateInput,
    ): Promise<CollaborationIssue>;
    update(
      issueId: string,
      input: SharedIssueDetailUpdateInput,
    ): Promise<CollaborationIssue>;
    assign(
      projectId: string,
      issueId: string,
      input: SharedIssueDetailAssignmentInput,
    ): Promise<CollaborationIssue>;
  };
  attachments: {
    list(issueId: string): Promise<CollaborationAttachment[]>;
    upload(issueId: string, file: File): Promise<CollaborationAttachment>;
    read(attachmentId: string): Promise<Blob>;
    download(attachmentId: string, filename: string): Promise<void>;
    remove(attachmentId: string): Promise<void>;
  };
  collaborators: {
    list(issueId: string): Promise<SharedIssueDetailCollaborator[]>;
    add(
      issueId: string,
      userId: number,
    ): Promise<SharedIssueDetailCollaborator>;
    remove(issueId: string, userId: number): Promise<void>;
  };
  taskBindings: {
    list(
      issueId: string,
      projectId?: string | number | null,
    ): Promise<SharedIssueDetailTaskBinding[]>;
  };
  workflowPlans: {
    get?: (issueId: string) => Promise<SharedIssueDetailWorkflowPlan | null>;
    approve?: (issueId: string) => Promise<SharedIssueDetailWorkflowPlan>;
    approveReview?: (issueId: string) => Promise<SharedIssueDetailWorkflowPlan>;
    pause?: (issueId: string) => Promise<SharedIssueDetailWorkflowPlan>;
    resume?: (issueId: string) => Promise<SharedIssueDetailWorkflowPlan>;
    replan?: (issueId: string) => Promise<SharedIssueDetailWorkflowPlan>;
  };
  members: {
    list(projectId: string): Promise<CollaborationMember[]>;
  };
  agents: {
    list(projectId: string): Promise<SharedIssueDetailAgent[]>;
  };
  deliveries: {
    list(issueId: string): Promise<SharedIssueDetailDelivery[]>;
    get(deliveryId: string): Promise<SharedIssueDetailDeliveryDetail>;
  };
  workflowNodes: {
    run(
      projectId: string,
      issueId: string,
      workflowNodeId: string,
      automationRuleId: string,
    ): Promise<CollaborationIssue>;
    complete(
      issueId: string,
      stage: SharedWorkflowNode,
      tasks: SharedIssueDetailTaskBinding[],
      action: "submit" | "approve" | "force_advance",
      reason: string,
      values: WorkflowDeliverableDraft[],
    ): Promise<CollaborationIssue>;
    decide(
      issueId: string,
      workflowNodeId: string,
      action: "approve" | "reject" | "force_advance",
      reason: string,
    ): Promise<CollaborationIssue>;
  };
}

export type SharedIssueDetailWorkspaceApi = Omit<
  Pick<
    SharedWorkspaceApi,
    | "issues"
    | "attachments"
    | "collaborators"
    | "taskBindings"
    | "workflowPlans"
    | "automations"
    | "members"
    | "deliveries"
  >,
  "automations"
> & {
  automations?: Pick<SharedWorkspaceApi["automations"], "runWorkflowNode">;
  agents: Pick<SharedWorkspaceApi["agents"], "list">;
};

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function sharedIssueDetailWorkflowPlanView(
  plan: SharedIssueDetailWorkflowPlan | null,
): IssueWorkflowPlanView | null {
  if (!plan) return null;
  const manager = plan.manager_run as
    | Record<string, unknown>
    | null
    | undefined;
  return {
    status: plan.status,
    summary: plan.summary,
    items: plan.items.map((value, index) => {
      const item = value as Record<string, unknown>;
      return {
        id: optionalString(item.id) ?? String(index),
        title:
          optionalString(item.title) ??
          optionalString(item.name) ??
          `#${index + 1}`,
        description: optionalString(item.description),
        assigneeId: optionalString(item.assignee_id),
        assigneeName: optionalString(item.assignee_name),
        rationale: optionalString(item.rationale),
        taskId: optionalString(item.task_id) ?? null,
        taskStatus: optionalString(item.task_status) ?? null,
        outcomeVerdict: optionalString(item.outcome_verdict) ?? null,
        outcomeSummary: optionalString(item.outcome_summary) ?? null,
      };
    }),
    manager:
      manager && typeof manager === "object"
        ? {
            id: optionalString(manager.id),
            status: optionalString(manager.status),
            recentActivity: optionalString(manager.recent_activity),
            error: optionalString(manager.error),
            model: optionalString(manager.model),
            deviceId: optionalString(manager.device_id),
          }
        : null,
  };
}

function toTaskBinding(
  binding: Awaited<
    ReturnType<SharedWorkspaceApi["taskBindings"]["list"]>
  >[number],
): SharedIssueDetailTaskBinding {
  return {
    id: binding.id,
    cloud_project_id: binding.projectId,
    loop_item_id: binding.issueId,
    task_user_id: binding.taskUserId,
    device_id: binding.deviceId,
    task_id: binding.taskId,
    task_title: binding.taskTitle,
    backend_task_id: binding.backendTaskId,
    modelSelection: binding.modelSelection,
    workflow_node_id: binding.workflowNodeId,
    binding_type: binding.bindingType,
    linked_at: binding.linkedAt,
  };
}

function toCollaborator(
  collaborator: Awaited<
    ReturnType<SharedWorkspaceApi["collaborators"]["list"]>
  >[number],
): SharedIssueDetailCollaborator {
  return {
    id: collaborator.id,
    loop_item_id: collaborator.issueId,
    user_id: collaborator.userId,
    user_name: collaborator.userName,
    email: collaborator.email,
    source: collaborator.source,
    added_by_user_id: collaborator.addedByUserId,
    created_at: collaborator.createdAt,
  };
}

function toWorkflowPlan(
  plan: NonNullable<
    Awaited<ReturnType<NonNullable<SharedWorkspaceApi["workflowPlans"]["get"]>>>
  >,
): SharedIssueDetailWorkflowPlan {
  return {
    run_id: plan.runId,
    issue_id: plan.issueId,
    stage_id: plan.stageId,
    plan_version: plan.planVersion,
    approval_policy: plan.approvalPolicy,
    status: plan.status,
    summary: plan.summary,
    items: plan.items,
    manager_run: plan.managerRun,
  };
}

function toDelivery(
  delivery: Awaited<
    ReturnType<SharedWorkspaceApi["deliveries"]["list"]>
  >[number],
): SharedIssueDetailDelivery {
  return {
    id: delivery.id,
    loop_item_id: delivery.issueId,
    status: delivery.status,
    assets: delivery.assets.map((asset) => ({
      id: asset.id,
      kind: asset.kind,
      display_name: asset.displayName,
      relative_path: asset.relativePath,
      content_type: asset.contentType,
      size_bytes: asset.sizeBytes,
      sha256: asset.sha256,
    })),
    fulfillments: delivery.fulfillments,
    created_at: delivery.createdAt,
    delivered_at: delivery.deliveredAt,
  };
}

function toDeliveryDetail(
  delivery: Awaited<ReturnType<SharedWorkspaceApi["deliveries"]["get"]>>,
): SharedIssueDetailDeliveryDetail {
  return {
    ...toDelivery(delivery),
    markdown: delivery.markdown ?? "",
    chat: delivery.chat ?? null,
  };
}

async function uploadWorkflowDeliverables(
  api: SharedWorkspaceApi["deliveries"],
  deliveryId: string,
  values: WorkflowDeliverableDraft[],
): Promise<Array<Record<string, unknown>>> {
  const fulfillments: Array<Record<string, unknown>> = [];
  for (const value of values) {
    const requirementId = value.requirement.id;
    if (value.requirement.value_type === "text" && value.text?.trim()) {
      fulfillments.push({
        requirement_id: requirementId,
        kind: "text",
        text: value.text.trim(),
      });
    } else if (value.requirement.value_type === "url" && value.url?.trim()) {
      fulfillments.push({
        requirement_id: requirementId,
        kind: "url",
        url: value.url.trim(),
        title: value.title?.trim() ?? "",
      });
    } else if (value.requirement.value_type === "file" && value.files?.length) {
      const assets = [];
      for (const file of value.files) {
        assets.push(
          await api.addAsset(deliveryId, file, `${requirementId}/${file.name}`),
        );
      }
      fulfillments.push({
        requirement_id: requirementId,
        kind: "file",
        asset_ids: assets.map((asset) => asset.id),
      });
    } else if (
      value.requirement.value_type === "code_snapshot" &&
      value.files?.[0]
    ) {
      const file = value.files[0];
      const asset = await api.addAsset(
        deliveryId,
        file,
        `${requirementId}/${file.name}`,
      );
      fulfillments.push({
        requirement_id: requirementId,
        kind: "code_snapshot",
        asset_id: asset.id,
        changed_files: [file.name],
        base_revision: null,
        head_revision: null,
        sha256: asset.sha256,
      });
    } else if (
      value.requirement.value_type === "git_branch" &&
      value.remoteUrl?.trim() &&
      value.branch?.trim() &&
      value.commitSha?.trim()
    ) {
      fulfillments.push({
        requirement_id: requirementId,
        kind: "git_branch",
        remote_url: value.remoteUrl.trim(),
        branch: value.branch.trim(),
        commit_sha: value.commitSha.trim(),
      });
    } else if (
      value.requirement.value_type === "pull_request" &&
      value.url?.trim() &&
      value.number?.trim() &&
      value.headBranch?.trim() &&
      value.baseBranch?.trim() &&
      value.commitSha?.trim()
    ) {
      fulfillments.push({
        requirement_id: requirementId,
        kind: "pull_request",
        provider: value.provider ?? "github",
        url: value.url.trim(),
        number: Number(value.number),
        state: "draft",
        head_branch: value.headBranch.trim(),
        base_branch: value.baseBranch.trim(),
        head_commit: value.commitSha.trim(),
      });
    }
  }
  return fulfillments;
}

/**
 * Canonical cloud controller used by every host rendering the shared issue
 * detail. Desktop-only effects are injected instead of encoded in the cloud
 * DTO adapter.
 */
export function createSharedIssueDetailPort(
  api: SharedIssueDetailWorkspaceApi,
  saveFile: (blob: Blob, filename: string) => Promise<void>,
): SharedIssueDetailPort {
  const workflowOperation = (
    operation:
      | SharedWorkspaceApi["workflowPlans"]["approve"]
      | SharedWorkspaceApi["workflowPlans"]["approveReview"]
      | SharedWorkspaceApi["workflowPlans"]["pause"]
      | SharedWorkspaceApi["workflowPlans"]["resume"]
      | SharedWorkspaceApi["workflowPlans"]["replan"],
  ) =>
    operation
      ? (issueId: string) => operation(issueId).then(toWorkflowPlan)
      : undefined;

  return {
    issues: {
      get: api.issues.get,
      create: (projectId, input) =>
        api.issues.create(projectId, {
          title: input.title,
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.due_at !== undefined ? { dueAt: input.due_at } : {}),
          ...(input.parent_id !== undefined
            ? { parentId: input.parent_id }
            : {}),
          ...(input.tags !== undefined ? { tags: input.tags } : {}),
          ...(input.local_project_id !== undefined
            ? { localProjectId: input.local_project_id }
            : {}),
          ...(input.local_project_name !== undefined
            ? { localProjectName: input.local_project_name }
            : {}),
          ...(input.workflow !== undefined ? { workflow: input.workflow } : {}),
          ...(input.execution_config !== undefined
            ? { executionConfig: input.execution_config }
            : {}),
          ...(input.automation_rule_id !== undefined
            ? { automationRuleId: input.automation_rule_id }
            : {}),
        }),
      update: (issueId, input) =>
        api.issues.update(issueId, {
          version: input.version,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.description !== undefined
            ? { description: input.description }
            : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.priority !== undefined ? { priority: input.priority } : {}),
          ...(input.parent_id !== undefined
            ? { parentId: input.parent_id }
            : {}),
          ...(input.assignee_user_id !== undefined
            ? { assigneeUserId: input.assignee_user_id }
            : {}),
          ...(input.assignee_agent_id !== undefined
            ? { assigneeAgentId: input.assignee_agent_id }
            : {}),
          ...(input.assignee_team_id !== undefined
            ? { assigneeTeamId: input.assignee_team_id }
            : {}),
          ...(input.due_at !== undefined ? { dueAt: input.due_at } : {}),
          ...(input.tags !== undefined ? { tags: input.tags } : {}),
          ...(input.workflow !== undefined ? { workflow: input.workflow } : {}),
          ...(input.execution_config !== undefined
            ? { executionConfig: input.execution_config }
            : {}),
          ...(input.automation_rule_id !== undefined
            ? { automationRuleId: input.automation_rule_id }
            : {}),
        }),
      assign: api.issues.assign,
    },
    attachments: {
      list: api.attachments.list,
      upload: api.attachments.upload,
      read: api.attachments.read,
      async download(attachmentId, filename) {
        if (api.attachments.download) {
          await api.attachments.download(attachmentId, filename);
          return;
        }
        await saveFile(await api.attachments.read(attachmentId), filename);
      },
      remove: api.attachments.remove,
    },
    collaborators: {
      list: (issueId) =>
        api.collaborators
          .list(issueId)
          .then((items) => items.map(toCollaborator)),
      add: (issueId, userId) =>
        api.collaborators.add(issueId, userId).then(toCollaborator),
      remove: api.collaborators.remove,
    },
    taskBindings: {
      list: (issueId, projectId) =>
        api.taskBindings
          .list(issueId, projectId == null ? undefined : String(projectId))
          .then((items) => items.map(toTaskBinding)),
    },
    workflowPlans: {
      get: api.workflowPlans.get
        ? (issueId) =>
            api.workflowPlans.get!(issueId).then((plan) =>
              plan ? toWorkflowPlan(plan) : null,
            )
        : undefined,
      approve: workflowOperation(api.workflowPlans.approve),
      approveReview: workflowOperation(api.workflowPlans.approveReview),
      pause: workflowOperation(api.workflowPlans.pause),
      resume: workflowOperation(api.workflowPlans.resume),
      replan: workflowOperation(api.workflowPlans.replan),
    },
    members: api.members,
    agents: {
      list: (projectId) =>
        api.agents.list(projectId).then((agents) =>
          agents.map((agent) => ({
            id: agent.id,
            name: agent.name,
            status: typeof agent.status === "string" ? agent.status : undefined,
          })),
        ),
    },
    deliveries: {
      list: (issueId) =>
        api.deliveries.list(issueId).then((items) => items.map(toDelivery)),
      get: (deliveryId) =>
        api.deliveries.get(deliveryId).then(toDeliveryDetail),
    },
    workflowNodes: {
      async run(projectId, issueId, workflowNodeId, automationRuleId) {
        if (!api.automations) {
          throw new Error(
            "Workflow automation is unavailable for this workspace host",
          );
        }
        try {
          await api.automations.runWorkflowNode(
            projectId,
            issueId,
            workflowNodeId,
            automationRuleId,
          );
        } catch (error) {
          const refreshed = await api.issues.get(issueId).catch(() => null);
          const workflow = refreshed?.workflow as
            | { nodes?: Array<{ id?: unknown; status?: unknown }> }
            | null
            | undefined;
          const node = workflow?.nodes?.find(
            (candidate) => candidate.id === workflowNodeId,
          );
          const status =
            typeof node?.status === "string" ? node.status : undefined;
          if (refreshed && ["queued", "running"].includes(status ?? "")) {
            return refreshed;
          }
          throw error;
        }
        return api.issues.get(issueId);
      },
      decide: api.workflowPlans.decideNode,
      async complete(issueId, stage, tasks, action, reason, values) {
        if (values.length > 0) {
          const source = tasks
            .filter((binding) => binding.workflow_node_id === stage.id)
            .at(-1);
          if (!source) {
            throw new Error("The workflow stage has no execution task");
          }
          const markdown = [
            `# ${stage.name} stage deliverables`,
            ...(stage.required_deliverables ?? []).map(
              (requirement) =>
                `- ${requirement.name} (${requirement.value_type})`,
            ),
          ].join("\n");
          const delivery = await api.deliveries.create(issueId, {
            markdown,
            sourceTask: {
              deviceId: source.device_id,
              taskId: source.task_id,
              backendTaskId: source.backend_task_id,
              modelSelection: source.modelSelection,
            },
          });
          try {
            const fulfillments = await uploadWorkflowDeliverables(
              api.deliveries,
              delivery.id,
              values,
            );
            await api.deliveries.finalize(delivery.id, { fulfillments });
          } catch (error) {
            await api.deliveries
              .discardDraft(delivery.id)
              .catch(() => undefined);
            throw error;
          }
        }
        if (action !== "submit") {
          await api.workflowPlans.decideNode(issueId, stage.id, action, reason);
        }
        return api.issues.get(issueId);
      },
    },
  };
}
