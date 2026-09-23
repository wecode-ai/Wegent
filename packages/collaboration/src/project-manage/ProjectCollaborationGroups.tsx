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
import {
  isCurrentDeviceCollaborationAgent,
  WorkspaceCollaborationGroupsConfiguration,
} from "../platform/WorkspaceResourceConfiguration";
import type { ProjectAgentConfigurationHost } from "../project-agent-config/types";

export function ProjectCollaborationGroups({
  api,
  projectId,
  workspaceId,
  members,
  agents,
  locale,
  currentUserId,
  canManage,
  location = "cloud",
  agentConfiguration,
  agentResourceContext,
}: {
  api: SharedWorkspaceApi;
  projectId: string;
  workspaceId?: string | null;
  members: CollaborationMember[];
  agents: CollaborationAgent[];
  locale: "zh-CN" | "en";
  currentUserId?: number;
  canManage: boolean;
  location?: "local" | "cloud";
  agentConfiguration?: ProjectAgentConfigurationHost;
  agentResourceContext?: {
    name: string;
    namespace: string;
  };
}) {
  const [groups, setGroups] = useState<CollaborationGroup[]>([]);
  const [workspaceGroups, setWorkspaceGroups] = useState<CollaborationGroup[]>(
    [],
  );
  const [availableAgents, setAvailableAgents] =
    useState<CollaborationAgent[]>(agents);

  const reload = useCallback(async () => {
    if (!api.projects.listCollaborationGroups) {
      return [];
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
    return projectAgents;
  }, [api, projectId, workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  useEffect(() => {
    setAvailableAgents(agents);
  }, [agents]);

  const projectGroupIds = new Set(groups.map((group) => group.id));
  const hasCurrentDeviceAgent = availableAgents.some(
    isCurrentDeviceCollaborationAgent,
  );
  const findAgent = (
    projectAgents: CollaborationAgent[],
    id: string,
  ): CollaborationAgent => {
    const agent = projectAgents.find(
      (candidate) => String(candidate.team_id ?? candidate.id) === id,
    );
    if (!agent) {
      throw new Error("Created collaboration group agent was not found");
    }
    return agent;
  };
  const agentActions =
    canManage && agentConfiguration
      ? {
          ...(location === "local" &&
          !hasCurrentDeviceAgent &&
          agentConfiguration.createDefaultLocalAgent
            ? {
                createDefault: async () => {
                  const id =
                    await agentConfiguration.createDefaultLocalAgent!(
                      projectId,
                    );
                  return findAgent(await reload(), id);
                },
              }
            : {}),
          ...((location === "local" &&
            agentConfiguration.renderLocalAgentCreator) ||
          (location === "cloud" && agentConfiguration.renderAgentCreator)
            ? {
                renderCreator: ({
                  onClose,
                  onCreated,
                }: {
                  onClose(): void;
                  onCreated(agent: CollaborationAgent): Promise<void>;
                }) => {
                  if (
                    location === "local" &&
                    agentConfiguration.renderLocalAgentCreator
                  ) {
                    const previousIds = new Set(
                      availableAgents.map((agent) => agent.id),
                    );
                    return agentConfiguration.renderLocalAgentCreator({
                      projectId,
                      onClose,
                      onCreated: async () => {
                        const projectAgents = await reload();
                        const created =
                          projectAgents.find(
                            (agent) => !previousIds.has(agent.id),
                          ) ?? projectAgents.at(-1);
                        if (!created) {
                          throw new Error(
                            "Created collaboration group agent was not found",
                          );
                        }
                        await onCreated(created);
                      },
                    });
                  }
                  if (!agentConfiguration.renderAgentCreator) return null;
                  return agentConfiguration.renderAgentCreator({
                    namespace: agentResourceContext?.namespace ?? "default",
                    workspaceName:
                      agentResourceContext?.name ??
                      (locale === "zh-CN" ? "当前空间" : "Current space"),
                    onClose,
                    onCreated: async (resource) => {
                      const created = await api.agents.create(projectId, {
                        team_id: resource.teamId,
                      });
                      await reload();
                      await onCreated(created);
                    },
                  });
                },
              }
            : {}),
          ...(location === "local"
            ? {
                copy: async (source: CollaborationAgent) => {
                  const record = source as CollaborationAgent &
                    Record<string, unknown>;
                  const suffix = crypto.randomUUID().slice(0, 8);
                  const created = await api.agents.create(projectId, {
                    ...record,
                    id: undefined,
                    version: undefined,
                    name: `copied-agent-${suffix}`,
                    displayName:
                      locale === "zh-CN"
                        ? `${source.name} 副本`
                        : `${source.name} copy`,
                    runtime:
                      record.runtime === "claude_code"
                        ? "claude_code"
                        : "codex",
                  });
                  await reload();
                  return created;
                },
              }
            : {}),
        }
      : undefined;

  return (
    <WorkspaceCollaborationGroupsConfiguration
      groups={groups}
      availableGroups={workspaceGroups.filter(
        (group) => !projectGroupIds.has(group.id),
      )}
      members={members}
      agents={availableAgents}
      locale={locale}
      currentUserId={currentUserId}
      canManage={canManage}
      agentActions={agentActions}
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
