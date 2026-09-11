// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type {
  CollaborationIssue,
  CollaborationMember,
  CollaborationProject,
  CollaborationUser,
} from "../types";
import type { ProjectManageApi } from "./types";

export interface SharedProjectManageWorkspaceApi {
  projects: Pick<SharedWorkspaceApi["projects"], "update">;
  issues: Pick<SharedWorkspaceApi["issues"], "getBoardSnapshot" | "update">;
  members: SharedWorkspaceApi["members"];
}

export function createSharedWorkspaceProjectManageApi(
  api: SharedProjectManageWorkspaceApi,
): ProjectManageApi<
  CollaborationProject,
  CollaborationMember,
  CollaborationIssue,
  CollaborationUser
> {
  return {
    listMembers: (projectId) => api.members.list(projectId),
    listItems: async (projectId) => {
      const snapshot = await api.issues.getBoardSnapshot(projectId);
      return { items: snapshot.items };
    },
    searchUsers: async (query) => ({
      users: await api.members.searchUsers(query),
    }),
    addMember: (projectId, userId, role) =>
      api.members.add(projectId, userId, role === "Owner" ? undefined : role),
    updateMember: (projectId, userId, values) =>
      api.members.update(projectId, userId, {
        role: values.role,
        capabilityDescription: values.capability_description,
      }),
    removeMember: (projectId, userId) => api.members.remove(projectId, userId),
    updateItem: (itemId, values) =>
      api.issues.update(itemId, {
        version: values.version,
        tags: values.tags,
      }),
    updateProject: (projectId, values) =>
      api.projects.update(projectId, {
        version: values.version,
        tags: values.tags,
        visibility: values.visibility,
        providerConfig: values.provider_config,
        boardConfig: values.board_config,
        cardDisplay: values.card_display,
      }),
  };
}
