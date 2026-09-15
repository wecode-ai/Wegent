// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useState } from "react";

import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import type {
  CollaborationAgent,
  CollaborationGroup,
  CollaborationMember,
} from "../types";
import { WorkspaceCollaborationGroupsConfiguration } from "../platform/WorkspaceResourceConfiguration";

export function ProjectCollaborationGroups({
  api,
  projectId,
  workspaceId,
  members,
  agents,
  locale,
  canManage,
}: {
  api: SharedWorkspaceApi;
  projectId: string;
  workspaceId?: string | null;
  members: CollaborationMember[];
  agents: CollaborationAgent[];
  locale: "zh-CN" | "en";
  canManage: boolean;
}) {
  const [groups, setGroups] = useState<CollaborationGroup[]>([]);
  const [workspaceGroups, setWorkspaceGroups] = useState<CollaborationGroup[]>(
    [],
  );
  const [availableAgents, setAvailableAgents] =
    useState<CollaborationAgent[]>(agents);

  const reload = useCallback(async () => {
    if (!api.projects.listCollaborationGroups) {
      return;
    }
    const [available, projectGroups, projectAgents] = await Promise.all([
      workspaceId && api.workspaces?.listCollaborationGroups
        ? api.workspaces.listCollaborationGroups(workspaceId)
        : Promise.resolve([]),
      api.projects.listCollaborationGroups(projectId),
      api.agents.list(projectId),
    ]);
    setWorkspaceGroups(available);
    setGroups(projectGroups);
    setAvailableAgents(projectAgents);
  }, [api, projectId, workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    setAvailableAgents(agents);
  }, [agents]);

  const projectGroupIds = new Set(groups.map((group) => group.id));

  return (
    <WorkspaceCollaborationGroupsConfiguration
      groups={groups}
      availableGroups={workspaceGroups.filter(
        (group) => !projectGroupIds.has(group.id),
      )}
      members={members}
      agents={availableAgents}
      locale={locale}
      canManage={canManage}
      commands={{
        searchUsers: async () => [],
        addMember: async () => {
          throw new Error("Project collaboration groups cannot add members");
        },
        updateMember: async () => {
          throw new Error("Project collaboration groups cannot update members");
        },
        removeMember: async () => undefined,
        async createCollaborationGroup(input) {
          if (!api.projects.createCollaborationGroup) {
            throw new Error("Project collaboration group API is unavailable");
          }
          const created = await api.projects.createCollaborationGroup(
            projectId,
            input,
          );
          await reload();
          return created;
        },
        async updateCollaborationGroup(groupId, input) {
          const group = groups.find((candidate) => candidate.id === groupId);
          if (!group) {
            throw new Error("Project collaboration group was not found");
          }
          let updated: CollaborationGroup | undefined;
          if (group.owner_type === "workspace") {
            if (!workspaceId || !api.workspaces?.updateCollaborationGroup) {
              throw new Error(
                "Workspace collaboration group API is unavailable",
              );
            }
            updated = await api.workspaces.updateCollaborationGroup(
              workspaceId,
              groupId,
              input,
            );
          } else {
            updated = await api.projects.updateCollaborationGroup?.(
              projectId,
              groupId,
              input,
            );
          }
          if (!updated) {
            throw new Error("Project collaboration group API is unavailable");
          }
          await reload();
          return updated;
        },
        async addCollaborationGroup(groupId) {
          if (!api.projects.addCollaborationGroup) {
            throw new Error("Project collaboration group API is unavailable");
          }
          const added = await api.projects.addCollaborationGroup(
            projectId,
            groupId,
          );
          await reload();
          return added;
        },
        async removeCollaborationGroup(groupId) {
          if (!api.projects.removeCollaborationGroup) {
            throw new Error("Project collaboration group API is unavailable");
          }
          await api.projects.removeCollaborationGroup(projectId, groupId);
          await reload();
        },
      }}
    />
  );
}
