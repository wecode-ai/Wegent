// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  mapCollaborationAssignmentDto,
  mapCollaborationExecutionEnvironmentDto,
  mapCollaborationOwnedAgentDto,
  mapCollaborationPlatformResourcesDto,
  mapCollaborationWorkspaceDto,
  mapCollaborationWorkspaceNavigationContextDto,
} from "../dto-mappers";
import type {
  SharedCollaborationResourcesApi,
  SharedCollaborationWorkspacesApi,
  SharedWorkspaceAgentsApi,
  SharedWorkspaceAssignmentsApi,
  SharedWorkspaceCommentsApi,
  SharedWorkspaceProjectsApi,
  WorkspaceProjectAgent,
} from "../ports/SharedWorkspaceApi";
import type {
  CollaborationGroup,
  CollaborationComment,
  CollaborationIssue,
  CollaborationMember,
} from "../types";

export interface SharedWorkspaceHttpTransport {
  get<T>(endpoint: string): Promise<T>;
  post<T>(endpoint: string, data?: unknown): Promise<T>;
  patch<T>(endpoint: string, data?: unknown): Promise<T>;
  delete<T>(endpoint: string, data?: unknown): Promise<T>;
}

export interface SharedWorkspaceHttpApi {
  workspaces: SharedCollaborationWorkspacesApi;
  resources: SharedCollaborationResourcesApi;
  projects: Pick<
    SharedWorkspaceProjectsApi,
    | "listCollaborationGroups"
    | "addCollaborationGroup"
    | "createCollaborationGroup"
    | "runCollaborationGroup"
    | "listCollaborationGroupRuns"
    | "removeCollaborationGroup"
  >;
  comments: SharedWorkspaceCommentsApi;
  assignments: SharedWorkspaceAssignmentsApi;
  agents: SharedWorkspaceAgentsApi;
}

function encoded(value: string | number): string {
  return encodeURIComponent(String(value));
}

function snakeCaseKey(key: string): string {
  return key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

export function workspaceHttpRequestBody(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(workspaceHttpRequestBody);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      snakeCaseKey(key),
      workspaceHttpRequestBody(nested),
    ]),
  );
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function camelCaseKey(key: string): string {
  return key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function keysToCamelCase(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(keysToCamelCase);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      camelCaseKey(key),
      keysToCamelCase(nested),
    ]),
  );
}

function mapWorkspaceMemberDto(input: unknown): CollaborationMember {
  const row = record(input);
  return {
    id: Number(row.id),
    user_id: Number(row.user_id ?? row.userId),
    user_name: String(row.user_name ?? row.userName ?? ""),
    email: row.email == null ? null : String(row.email),
    role: (row.role ?? "Developer") as CollaborationMember["role"],
    ...((row.capability_description ?? row.capabilityDescription) == null
      ? {}
      : {
          capability_description: String(
            row.capability_description ?? row.capabilityDescription,
          ),
        }),
  };
}

function mapCollaborationGroupDto(input: unknown): CollaborationGroup {
  const row = record(input);
  const members = Array.isArray(row.members) ? row.members : [];
  const leader = record(row.leader);
  const policy = record(row.policy);
  return {
    id: String(row.id),
    workspace_id: String(row.workspace_id ?? row.workspaceId),
    owner_type:
      (row.owner_type ?? row.ownerType) === "project" ? "project" : "workspace",
    owner_id: String(row.owner_id ?? row.ownerId),
    name: String(row.name ?? ""),
    description: String(row.description ?? ""),
    leader: {
      kind: leader.kind === "human" ? "human" : "agent",
      id: String(leader.id),
    },
    members: members.map((member) => {
      const value = record(member);
      return {
        kind: value.kind === "human" ? "human" : "agent",
        id: String(value.id),
      };
    }),
    coordination_mode: "manager",
    policy: {
      prompt: String(policy.prompt ?? ""),
      trigger_type:
        policy.trigger_type === "schedule" || policy.triggerType === "schedule"
          ? "schedule"
          : policy.trigger_type === "event" || policy.triggerType === "event"
            ? "event"
            : "manual",
      event_type:
        (policy.event_type ?? policy.eventType) == null
          ? null
          : String(policy.event_type ?? policy.eventType),
      event_config: record(policy.event_config ?? policy.eventConfig),
      cron_expression:
        (policy.cron_expression ?? policy.cronExpression) == null
          ? null
          : String(policy.cron_expression ?? policy.cronExpression),
      timezone: String(policy.timezone ?? "Asia/Shanghai"),
      issue_selector: record(policy.issue_selector ?? policy.issueSelector),
      output_policy: record(policy.output_policy ?? policy.outputPolicy),
      enabled: policy.enabled !== false,
    },
    version: Number(row.version ?? 1),
    created_by_user_id: Number(
      row.created_by_user_id ?? row.createdByUserId ?? 0,
    ),
    created_at: String(row.created_at ?? row.createdAt ?? ""),
    updated_at: String(row.updated_at ?? row.updatedAt ?? ""),
  };
}

function mapProjectAgentDto(input: unknown): WorkspaceProjectAgent {
  const row = keysToCamelCase(input) as Record<string, unknown>;
  const teamId = row.teamId ?? row.wegentTeamId;
  return {
    ...row,
    id: String(row.id),
    name: String(row.name ?? ""),
    ...(row.agentId == null ? {} : { agent_id: String(row.agentId) }),
    ...(teamId == null ? {} : { team_id: Number(teamId) }),
  };
}

export function createSharedWorkspaceHttpApi(
  transport: SharedWorkspaceHttpTransport,
): SharedWorkspaceHttpApi {
  return {
    workspaces: {
      async list() {
        const response = await transport.get<{ items: unknown[] }>(
          "/v1/workspaces",
        );
        return response.items.map((item) =>
          mapCollaborationWorkspaceDto(record(item)),
        );
      },
      async get(workspaceId) {
        return mapCollaborationWorkspaceDto(
          await transport.get(`/v1/workspaces/${encoded(workspaceId)}`),
        );
      },
      async getNavigationContext(workspaceId) {
        return mapCollaborationWorkspaceNavigationContextDto(
          await transport.get(
            `/v1/workspaces/${encoded(workspaceId)}/navigation-context`,
          ),
        );
      },
      async create(input) {
        return mapCollaborationWorkspaceDto(
          await transport.post(
            "/v1/workspaces",
            workspaceHttpRequestBody(input),
          ),
        );
      },
      async update(workspaceId, input) {
        return mapCollaborationWorkspaceDto(
          await transport.patch(
            `/v1/workspaces/${encoded(workspaceId)}`,
            workspaceHttpRequestBody(input),
          ),
        );
      },
      async archive(workspaceId, version) {
        await transport.delete(
          `/v1/workspaces/${encoded(workspaceId)}?version=${encoded(version)}`,
        );
      },
      async listMembers(workspaceId) {
        const response = await transport.get<{ items: unknown[] }>(
          `/v1/workspaces/${encoded(workspaceId)}/members`,
        );
        return response.items.map(mapWorkspaceMemberDto);
      },
      async addMember(workspaceId, input) {
        return mapWorkspaceMemberDto(
          await transport.post(
            `/v1/workspaces/${encoded(workspaceId)}/members`,
            workspaceHttpRequestBody({
              userId: input.userId,
              role: input.role ?? "Developer",
            }),
          ),
        );
      },
      async updateMember(workspaceId, userId, input) {
        return mapWorkspaceMemberDto(
          await transport.patch(
            `/v1/workspaces/${encoded(workspaceId)}/members/${encoded(userId)}`,
            workspaceHttpRequestBody(input),
          ),
        );
      },
      async removeMember(workspaceId, userId) {
        await transport.delete(
          `/v1/workspaces/${encoded(workspaceId)}/members/${encoded(userId)}`,
        );
      },
      async listAgents(workspaceId) {
        const response = await transport.get<{ items: unknown[] }>(
          `/v1/workspaces/${encoded(workspaceId)}/agents`,
        );
        return response.items.map((item) =>
          mapCollaborationOwnedAgentDto(record(item)),
        );
      },
      async addAgent(workspaceId, input) {
        return mapCollaborationOwnedAgentDto(
          await transport.post(
            `/v1/workspaces/${encoded(workspaceId)}/agents`,
            workspaceHttpRequestBody({ teamId: input.teamId }),
          ),
        );
      },
      async removeAgent(workspaceId, teamId) {
        await transport.delete(
          `/v1/workspaces/${encoded(workspaceId)}/agents/${encoded(teamId)}`,
        );
      },
      async listCollaborationGroups(workspaceId) {
        const response = await transport.get<{ items: unknown[] }>(
          `/v1/workspaces/${encoded(workspaceId)}/collaboration-groups`,
        );
        return response.items.map(mapCollaborationGroupDto);
      },
      async createCollaborationGroup(workspaceId, input) {
        return mapCollaborationGroupDto(
          await transport.post(
            `/v1/workspaces/${encoded(workspaceId)}/collaboration-groups`,
            workspaceHttpRequestBody(input),
          ),
        );
      },
      async updateCollaborationGroup(workspaceId, groupId, input) {
        return mapCollaborationGroupDto(
          await transport.patch(
            `/v1/workspaces/${encoded(workspaceId)}/collaboration-groups/${encoded(groupId)}`,
            workspaceHttpRequestBody(input),
          ),
        );
      },
      async removeCollaborationGroup(workspaceId, groupId) {
        await transport.delete(
          `/v1/workspaces/${encoded(workspaceId)}/collaboration-groups/${encoded(groupId)}`,
        );
      },
      async listExecutionEnvironments(workspaceId) {
        const response = await transport.get<{ items: unknown[] }>(
          `/v1/workspaces/${encoded(workspaceId)}/execution-environments`,
        );
        return response.items.map((item) =>
          mapCollaborationExecutionEnvironmentDto(record(item)),
        );
      },
      async addExecutionEnvironment(workspaceId, input) {
        return mapCollaborationExecutionEnvironmentDto(
          await transport.post(
            `/v1/workspaces/${encoded(workspaceId)}/execution-environments`,
            workspaceHttpRequestBody({ deviceId: input.deviceId }),
          ),
        );
      },
      async removeExecutionEnvironment(workspaceId, deviceId) {
        await transport.delete(
          `/v1/workspaces/${encoded(workspaceId)}/execution-environments/${encoded(deviceId)}`,
        );
      },
    },
    resources: {
      async list() {
        return mapCollaborationPlatformResourcesDto(
          await transport.get("/v1/resources"),
        );
      },
    },
    projects: {
      async listCollaborationGroups(projectId) {
        const response = await transport.get<{ items: unknown[] }>(
          `/v1/cloud-projects/${encoded(projectId)}/collaboration-groups`,
        );
        return response.items.map(mapCollaborationGroupDto);
      },
      async addCollaborationGroup(projectId, groupId) {
        return mapCollaborationGroupDto(
          await transport.post(
            `/v1/cloud-projects/${encoded(projectId)}/collaboration-groups/${encoded(groupId)}`,
          ),
        );
      },
      async createCollaborationGroup(projectId, input) {
        return mapCollaborationGroupDto(
          await transport.post(
            `/v1/cloud-projects/${encoded(projectId)}/collaboration-groups`,
            workspaceHttpRequestBody(input),
          ),
        );
      },
      async runCollaborationGroup(projectId, groupId) {
        return transport.post<{ id: string; status: string }>(
          `/v1/cloud-projects/${encoded(projectId)}/collaboration-groups/${encoded(groupId)}/run`,
        );
      },
      async listCollaborationGroupRuns(projectId, groupId) {
        const response = await transport.get<unknown[]>(
          `/v1/cloud-projects/${encoded(projectId)}/collaboration-groups/${encoded(groupId)}/runs`,
        );
        return response.map(
          (run) =>
            keysToCamelCase(
              run,
            ) as import("../ports/SharedWorkspaceApi").WorkspaceAutomationRun,
        );
      },
      async removeCollaborationGroup(projectId, groupId) {
        await transport.delete(
          `/v1/cloud-projects/${encoded(projectId)}/collaboration-groups/${encoded(groupId)}`,
        );
      },
    },
    comments: {
      list(issueId) {
        return transport.get<CollaborationComment[]>(
          `/v1/loop-items/${encoded(issueId)}/comments`,
        );
      },
      create(issueId, body) {
        return transport.post<CollaborationComment>(
          `/v1/loop-items/${encoded(issueId)}/comments`,
          { body },
        );
      },
    },
    assignments: {
      async list(issueId) {
        const response = await transport.get<{ items: unknown[] }>(
          `/v1/loop-items/${encoded(issueId)}/assignments`,
        );
        return response.items.map((item) =>
          mapCollaborationAssignmentDto(record(item)),
        );
      },
      async create(issueId, input) {
        const response = await transport.post<{
          assignment: unknown;
          comment: CollaborationComment | null;
          issue: CollaborationIssue;
        }>(
          `/v1/loop-items/${encoded(issueId)}/assignments`,
          workspaceHttpRequestBody(input),
        );
        const assignment = mapCollaborationAssignmentDto(
          record(response.assignment),
        );
        const comment =
          response.comment && response.comment.id !== assignment.id
            ? response.comment
            : null;
        return {
          assignment,
          comment,
          issue: response.issue,
        };
      },
    },
    agents: {
      async list(projectId) {
        const response = await transport.get<unknown[]>(
          `/v1/cloud-projects/${encoded(projectId)}/chat-agents`,
        );
        return response.map(mapProjectAgentDto);
      },
      async create(projectId, input) {
        return mapProjectAgentDto(
          await transport.post(
            `/v1/cloud-projects/${encoded(projectId)}/chat-agents`,
            workspaceHttpRequestBody(input),
          ),
        );
      },
      async update(projectId, agentId, input) {
        return mapProjectAgentDto(
          await transport.patch(
            `/v1/cloud-projects/${encoded(projectId)}/chat-agents/${encoded(agentId)}`,
            workspaceHttpRequestBody(input),
          ),
        );
      },
    },
  };
}
