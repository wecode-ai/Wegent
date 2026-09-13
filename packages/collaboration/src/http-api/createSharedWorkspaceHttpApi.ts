// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import {
  mapCollaborationAssignmentDto,
  mapCollaborationExecutionEnvironmentDto,
  mapCollaborationOwnedAgentDto,
  mapCollaborationPlatformResourcesDto,
  mapCollaborationWorkspaceDto,
} from "../dto-mappers";
import type {
  SharedCollaborationResourcesApi,
  SharedCollaborationWorkspacesApi,
  SharedWorkspaceAgentsApi,
  SharedWorkspaceAssignmentsApi,
  SharedWorkspaceCommentsApi,
  WorkspaceProjectAgent,
} from "../ports/SharedWorkspaceApi";
import type {
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

function mapProjectAgentDto(input: unknown): WorkspaceProjectAgent {
  const row = keysToCamelCase(input) as Record<string, unknown>;
  return {
    ...row,
    id: String(row.id),
    name: String(row.name ?? ""),
    ...(row.agentId == null ? {} : { agent_id: String(row.agentId) }),
    ...(row.teamId == null ? {} : { team_id: Number(row.teamId) }),
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
