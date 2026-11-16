// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { ensureWorkspaceEnvironmentSharing } from "../execution-environment/ensureWorkspaceEnvironmentSharing";
import type {
  SharedWorkspaceApi,
  WorkspaceProjectAgent,
} from "../ports/SharedWorkspaceApi";
import { createResourceAgentBindingInput } from "../project-agent-config";
import { normalizeCollaborationGroupDraftForPersistence } from "../project-create/collaborationGroupDraft";
import { configureProjectMembers } from "../project-create/configureProjectMembers";
import type { ProjectCreateResourceSelection } from "../project-create/types";
import type {
  CollaborationOwnedAgent,
  CollaborationProject,
  CollaborationWorkspace,
  CollaborationWorkspaceMember,
} from "../types";
import { isCurrentDeviceCollaborationAgent } from "./WorkspaceResourceConfiguration";

interface ProjectResourceConfigurationInput {
  api: SharedWorkspaceApi;
  project: CollaborationProject;
  workspace: CollaborationWorkspace;
  currentUserId: number;
  members: CollaborationWorkspaceMember[];
  agents: CollaborationOwnedAgent[];
  selection: ProjectCreateResourceSelection;
  locale: "zh-CN" | "en";
}

interface ProjectResourceConfigurationProgress {
  environmentDeviceIds: Set<number>;
  agents: Map<string, WorkspaceProjectAgent>;
  groupCreated: boolean;
}

async function configureEnvironments(
  { api, project, workspace, selection }: ProjectResourceConfigurationInput,
  progress: ProjectResourceConfigurationProgress,
) {
  const pendingDeviceIds = [
    ...new Set(selection.executionEnvironmentDeviceIds),
  ].filter((deviceId) => !progress.environmentDeviceIds.has(deviceId));
  const sharedDeviceIds = new Set<number>(
    workspace.location === "cloud" && pendingDeviceIds.length
      ? (await api.workspaces!.listExecutionEnvironments(workspace.id)).flatMap(
          (environment) =>
            environment.device_id == null ? [] : [environment.device_id],
        )
      : [],
  );
  for (const deviceId of pendingDeviceIds) {
    if (workspace.location === "cloud") {
      await ensureWorkspaceEnvironmentSharing(
        api,
        workspace.id,
        deviceId,
        sharedDeviceIds,
      );
    }
    await api.projects.addExecutionEnvironment(project.id, deviceId);
    progress.environmentDeviceIds.add(deviceId);
  }
}

async function configureAgents(
  { api, project, agents, selection }: ProjectResourceConfigurationInput,
  progress: ProjectResourceConfigurationProgress,
) {
  const pendingAgents = agents.filter(
    (agent) =>
      selection.agentResourceIds.includes(agent.id) &&
      !progress.agents.has(agent.id),
  );
  const selectedDefaultAgent = pendingAgents.find(
    isCurrentDeviceCollaborationAgent,
  );
  if (selectedDefaultAgent) {
    const existingDefaultAgent = (await api.agents.list(project.id)).find(
      isCurrentDeviceCollaborationAgent,
    );
    if (existingDefaultAgent)
      progress.agents.set(selectedDefaultAgent.id, existingDefaultAgent);
  }
  for (const agent of pendingAgents) {
    if (progress.agents.has(agent.id)) continue;
    const created = await api.agents.create(
      project.id,
      createResourceAgentBindingInput(agent),
    );
    progress.agents.set(agent.id, created);
  }
}

async function configureGroup(
  { api, project, selection, locale }: ProjectResourceConfigurationInput,
  progress: ProjectResourceConfigurationProgress,
) {
  if (!selection.collaborationGroupDraft || progress.groupCreated) return;
  const group = normalizeCollaborationGroupDraftForPersistence(
    selection.collaborationGroupDraft,
  );
  if (!api.projects.createCollaborationGroup) {
    throw new Error(
      locale === "zh-CN"
        ? "当前项目不支持创建协作小组"
        : "This project does not support collaboration groups",
    );
  }
  const mapParticipant = (participant: typeof group.leader) => {
    if (participant.kind === "human") return participant;
    const agent = progress.agents.get(participant.id);
    if (!agent) {
      throw new Error(
        locale === "zh-CN"
          ? "协作小组中的智能体未成功加入项目"
          : "An Agent in the group was not added to the project",
      );
    }
    return { ...participant, id: String(agent.id) };
  };
  const leader = mapParticipant(group.leader);
  if (!leader.id) {
    throw new Error(
      locale === "zh-CN"
        ? "负责人不在当前协作成员中"
        : "The owner is not a current collaborator",
    );
  }
  await api.projects.createCollaborationGroup(project.id, {
    name: group.name,
    description: group.description,
    instructions: group.instructions,
    leader,
    members: group.members.map(mapParticipant),
    coordinationMode: "manager",
    stages: group.stages.map((stage) => ({
      ...stage,
      assignee: stage.assignee ? mapParticipant(stage.assignee) : null,
    })),
    executionRequirements: group.executionRequirements,
  });
  progress.groupCreated = true;
}

/** Retains completed resource bindings while the creation dialog retries setup. */
export function createProjectResourceConfigurator() {
  const projects = new Map<string, ProjectResourceConfigurationProgress>();
  return {
    reset: () => projects.clear(),
    configure: async (input: ProjectResourceConfigurationInput) => {
      const verifiedMembers = await configureProjectMembers({
        api: input.api,
        projectId: input.project.id,
        memberUserIds: input.selection.memberUserIds,
        currentUserId: input.currentUserId,
        members: input.members,
        verificationFailureMessage:
          input.locale === "zh-CN"
            ? "保存后未在项目成员列表中找到该成员，请重试"
            : "The member was not found in the project after saving. Please retry.",
      });
      const progress = projects.get(input.project.id) ?? {
        environmentDeviceIds: new Set<number>(),
        agents: new Map<string, WorkspaceProjectAgent>(),
        groupCreated: false,
      };
      projects.set(input.project.id, progress);
      await configureEnvironments(input, progress);
      await configureAgents(input, progress);
      await configureGroup(input, progress);
      return verifiedMembers;
    },
  };
}
