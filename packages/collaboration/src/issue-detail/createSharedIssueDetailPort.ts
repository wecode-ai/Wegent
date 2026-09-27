// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type {
  CollaborationAttachment,
  CollaborationGroup,
  CollaborationIssue,
  CollaborationMember,
} from "../types";
import type { ExecutionDisplayStatus } from "./executionStatus";

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
  binding_type?: "system" | "user";
  linked_at: string;
}

export interface SharedIssueDetailTaskExecutionState {
  status: ExecutionDisplayStatus;
  queuePosition?: number | null;
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
  assignee_user_id?: number | null;
  notify_assignee?: boolean;
  creator_name?: string;
}

export interface SharedIssueDetailUpdateInput {
  version: number;
  security_level?: "open" | "related";
  title?: string;
  description?: string;
  status?: string;
  priority?: CollaborationIssue["priority"];
  parent_id?: string | null;
  assignee_user_id?: number | null;
  assignee_agent_id?: string | null;
  assignee_team_id?: number | null;
  assignee_group_id?: string | null;
  due_at?: string | null;
  tags?: string[];
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
  members: {
    list(projectId: string): Promise<CollaborationMember[]>;
  };
  agents: {
    list(projectId: string): Promise<SharedIssueDetailAgent[]>;
  };
  collaborationGroups: {
    list(projectId: string): Promise<CollaborationGroup[]>;
  };
  deliveries: {
    list(issueId: string): Promise<SharedIssueDetailDelivery[]>;
    get(deliveryId: string): Promise<SharedIssueDetailDeliveryDetail>;
  };
}

export type SharedIssueDetailWorkspaceApi = Omit<
  Pick<
    SharedWorkspaceApi,
    | "issues"
    | "attachments"
    | "collaborators"
    | "taskBindings"
    | "members"
    | "deliveries"
  >,
  never
> & {
  agents: Pick<SharedWorkspaceApi["agents"], "list">;
};

export function toSharedIssueDetailTaskBinding(
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

/**
 * Canonical cloud controller used by every host rendering the shared issue
 * detail. Desktop-only effects are injected instead of encoded in the cloud
 * DTO adapter.
 */
export function createSharedIssueDetailPort(
  api: SharedIssueDetailWorkspaceApi,
  saveFile: (blob: Blob, filename: string) => Promise<void>,
): SharedIssueDetailPort {
  const projects = (
    api as SharedIssueDetailWorkspaceApi & {
      projects?: Pick<
        SharedWorkspaceApi["projects"],
        "listCollaborationGroups"
      >;
    }
  ).projects;

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
          ...(input.assignee_user_id !== undefined
            ? { assigneeUserId: input.assignee_user_id }
            : {}),
          ...(input.notify_assignee !== undefined
            ? { notifyAssignee: input.notify_assignee }
            : {}),
        }),
      update: (issueId, input) =>
        api.issues.update(issueId, {
          version: input.version,
          ...(input.security_level !== undefined
            ? { securityLevel: input.security_level }
            : {}),
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
          ...(input.assignee_group_id !== undefined
            ? { assigneeGroupId: input.assignee_group_id }
            : {}),
          ...(input.due_at !== undefined ? { dueAt: input.due_at } : {}),
          ...(input.tags !== undefined ? { tags: input.tags } : {}),
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
          .then((items) => items.map(toSharedIssueDetailTaskBinding)),
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
    collaborationGroups: {
      list: (projectId) =>
        projects?.listCollaborationGroups?.(projectId) ?? Promise.resolve([]),
    },
    deliveries: {
      list: (issueId) =>
        api.deliveries.list(issueId).then((items) => items.map(toDelivery)),
      get: (deliveryId) =>
        api.deliveries.get(deliveryId).then(toDeliveryDetail),
    },
  };
}
