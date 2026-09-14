// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState } from "react";

import {
  clearMemberResultsForEmptyQuery,
  runActiveMemberSearch,
} from "../project-manage/memberSearch";
import type {
  CollaborationAgent,
  CollaborationGroup,
  CollaborationExecutionEnvironment,
  CollaborationMember,
  CollaborationOwnedAgent,
  CollaborationPlatformResources,
  CollaborationRole,
  CollaborationUser,
  CollaborationWorkspace,
} from "../types";
import { ResourceAuthorizationForm } from "./ResourceAuthorizationForm";

type MemberRole = Exclude<CollaborationRole, "Owner">;

export interface WorkspaceResourceCommands {
  searchUsers(query: string): Promise<CollaborationUser[]>;
  addMember(userId: number, role: MemberRole): Promise<CollaborationMember>;
  updateMember(userId: number, role: MemberRole): Promise<CollaborationMember>;
  removeMember(userId: number): Promise<void>;
  addAgent(agent: CollaborationOwnedAgent): Promise<CollaborationOwnedAgent>;
  removeAgent(agent: CollaborationOwnedAgent): Promise<void>;
  createCollaborationGroup(input: {
    name: string;
    description?: string;
    leader: {
      kind: "human" | "agent";
      id: string;
      responsibility?: string;
    };
    members: Array<{
      kind: "human" | "agent";
      id: string;
      responsibility?: string;
    }>;
    coordinationMode: "manager";
    stages?: Array<{
      id: string;
      name: string;
      description?: string;
      assignee?: {
        kind: "human" | "agent";
        id: string;
        responsibility?: string;
      } | null;
    }>;
  }): Promise<CollaborationGroup>;
  updateCollaborationGroup?(
    groupId: string,
    input: {
      version: number;
      name?: string;
      description?: string;
      leader?: {
        kind: "human" | "agent";
        id: string;
        responsibility?: string;
      };
      members?: Array<{
        kind: "human" | "agent";
        id: string;
        responsibility?: string;
      }>;
      coordinationMode?: "manager";
      stages?: Array<{
        id: string;
        name: string;
        description?: string;
        assignee?: {
          kind: "human" | "agent";
          id: string;
          responsibility?: string;
        } | null;
      }>;
    },
  ): Promise<CollaborationGroup>;
  removeCollaborationGroup(groupId: string): Promise<void>;
  addCollaborationGroup?(groupId: string): Promise<CollaborationGroup>;
  addExecutionEnvironment(
    environment: CollaborationExecutionEnvironment,
  ): Promise<CollaborationExecutionEnvironment>;
  removeExecutionEnvironment(
    environment: CollaborationExecutionEnvironment,
  ): Promise<void>;
}

const copy = {
  "zh-CN": {
    inviteMember: "邀请成员",
    searchUser: "搜索姓名或邮箱",
    searchHint: "输入姓名或邮箱，从已有用户中邀请成员。",
    noSearchResults: "没有找到可邀请的用户",
    role: "角色",
    remove: "移除",
    cancel: "取消",
    owner: "所有者",
    maintainer: "管理员",
    developer: "开发者",
    reporter: "参与者",
    authorizeAgent: "智能体管理",
    authorizeEnvironment: "执行环境管理",
    chooseAgent: "选择我的智能体",
    chooseEnvironment: "选择我的执行环境",
    authorize: "添加到空间",
    noCandidates: "没有可以添加的资源",
    noMembers: "空间中还没有成员",
    noAgents: "空间中还没有智能体",
    collaborationGroups: "协作小组",
    collaborationGroupHint:
      "把空间中的人与智能体组织成可复用的协作小组。负责人负责分解、委派、收敛和最终汇报。",
    groupName: "协作小组名称",
    groupDescription: "协作目标与边界",
    managerMode: "负责人协调",
    leader: "负责人",
    membersLabel: "成员",
    memberResponsibility: "职责",
    stages: "工作阶段",
    stagesHint: "阶段是协作小组接单后的可选推进方式；留空时由负责人动态分解。",
    addStage: "添加阶段",
    dynamicAssignment: "由负责人动态分配",
    manageGroup: "管理",
    saveGroup: "保存",
    backToGroups: "返回协作小组",
    createHint: "先定义协作小组身份和负责人，创建后再维护成员职责与工作阶段。",
    humanLeaderHint: "人类负责人负责人工协调，不会自动启动智能体。",
    agentLeaderHint: "智能体负责人可以接收人工分配或被调度规则选中。",
    createGroup: "创建协作小组",
    noGroups: "空间中还没有协作小组",
    projectGroups: "项目正在使用",
    noProjectGroups: "当前项目还没有使用协作小组",
    availableWorkspaceGroups: "可从协作空间添加",
    workspaceOwned: "空间资源",
    projectOwned: "项目资源",
    removeFromProject: "移出项目",
    deleteProjectGroup: "删除",
    noEnvironments: "空间中还没有执行环境",
    memberHint: "统一管理空间成员，方便空间内项目复用；项目仍可独立管理成员。",
    agentHint: "统一管理空间共享智能体，项目也可以直接添加自己的智能体。",
    environmentHint:
      "统一管理空间共享的本地设备和云端环境，项目也可以直接添加自己的执行环境。",
    operationFailed: "操作失败，请稍后重试",
  },
  en: {
    inviteMember: "Invite member",
    searchUser: "Search name or email",
    searchHint: "Search existing users by name or email.",
    noSearchResults: "No users available to invite",
    role: "Role",
    remove: "Remove",
    cancel: "Cancel",
    owner: "Owner",
    maintainer: "Maintainer",
    developer: "Developer",
    reporter: "Reporter",
    authorizeAgent: "Agent management",
    authorizeEnvironment: "Execution environment management",
    chooseAgent: "Choose one of my agents",
    chooseEnvironment: "Choose one of my execution environments",
    authorize: "Add to space",
    noCandidates: "No resources available to add",
    noMembers: "No members in this workspace",
    noAgents: "No agents in this workspace",
    collaborationGroups: "Collaboration groups",
    collaborationGroupHint:
      "Organize people and agents into reusable execution units. The leader plans, delegates, consolidates, and reports.",
    groupName: "Group name",
    groupDescription: "Goal and boundaries",
    managerMode: "Leader coordinated",
    leader: "Leader",
    membersLabel: "Members",
    memberResponsibility: "Responsibility",
    stages: "Work stages",
    stagesHint:
      "Stages optionally guide work after assignment. Leave them empty for dynamic planning by the leader.",
    addStage: "Add stage",
    dynamicAssignment: "Assigned dynamically by leader",
    manageGroup: "Manage",
    saveGroup: "Save",
    backToGroups: "Back to groups",
    createHint:
      "Define the group identity and leader first, then maintain responsibilities and stages.",
    humanLeaderHint:
      "A human leader coordinates manually and does not automatically start an agent.",
    agentLeaderHint:
      "An agent leader can receive manual assignments or be targeted by dispatch rules.",
    createGroup: "Create group",
    noGroups: "No collaboration groups in this workspace",
    projectGroups: "Used by this project",
    noProjectGroups: "This project is not using a collaboration group",
    availableWorkspaceGroups: "Available from workspace",
    workspaceOwned: "Workspace resource",
    projectOwned: "Project resource",
    removeFromProject: "Remove from project",
    deleteProjectGroup: "Delete",
    noEnvironments: "No execution environments in this workspace",
    memberHint:
      "Manage shared space members for reuse. Projects can still manage members independently.",
    agentHint:
      "Manage shared space agents. Projects can also add agents directly.",
    environmentHint:
      "Manage shared local devices and cloud environments. Projects can also add execution environments directly.",
    operationFailed: "Operation failed. Please try again.",
  },
} as const;

type ResourceCopy = (typeof copy)[keyof typeof copy];

function roleLabel(role: CollaborationRole, messages: ResourceCopy) {
  if (role === "Owner") return messages.owner;
  if (role === "Maintainer") return messages.maintainer;
  if (role === "Developer") return messages.developer;
  return messages.reporter;
}

function ErrorMessage({ message }: { message: string | null }) {
  return message ? (
    <div className="collaboration-alert" role="alert">
      {message}
    </div>
  ) : null;
}

function MemberInviteDialog({
  members,
  messages,
  commands,
  onClose,
}: {
  members: CollaborationMember[];
  messages: ResourceCopy;
  commands: WorkspaceResourceCommands;
  onClose(): void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CollaborationUser[]>([]);
  const [role, setRole] = useState<MemberRole>("Developer");
  const [error, setError] = useState<string | null>(null);
  const [savingUserId, setSavingUserId] = useState<number | null>(null);
  const searchVersion = useRef(0);
  const existingUserIds = useMemo(
    () => new Set(members.map((member) => member.user_id)),
    [members],
  );

  useEffect(() => {
    const version = ++searchVersion.current;
    if (clearMemberResultsForEmptyQuery(query, setResults)) return;
    const timeout = window.setTimeout(() => {
      void runActiveMemberSearch({
        query,
        existingUserIds,
        search: async (value) => ({
          users: await commands.searchUsers(value),
        }),
        userId: (user) => user.id,
        isActive: () => searchVersion.current === version,
        onResults: setResults,
        onError: () => setError(messages.operationFailed),
      });
    }, 180);
    return () => window.clearTimeout(timeout);
  }, [commands, existingUserIds, messages.operationFailed, query]);

  return (
    <div className="collaboration-dialog-backdrop">
      <section
        className="collaboration-dialog collaboration-resource-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={messages.inviteMember}
      >
        <h2>{messages.inviteMember}</h2>
        <p>{messages.searchHint}</p>
        <label>
          {messages.role}
          <select
            data-testid="collaboration-workspace-member-invite-role"
            value={role}
            onChange={(event) => setRole(event.target.value as MemberRole)}
          >
            <option value="Maintainer">{messages.maintainer}</option>
            <option value="Developer">{messages.developer}</option>
            <option value="Reporter">{messages.reporter}</option>
          </select>
        </label>
        <label>
          {messages.searchUser}
          <input
            autoFocus
            data-testid="collaboration-workspace-member-search"
            value={query}
            onChange={(event) => {
              setError(null);
              setQuery(event.target.value);
            }}
          />
        </label>
        <ErrorMessage message={error} />
        <div className="collaboration-resource-candidates">
          {query.trim() && !results.length ? (
            <span>{messages.noSearchResults}</span>
          ) : null}
          {results.map((user) => (
            <button
              type="button"
              data-testid={`collaboration-workspace-member-result-${user.id}`}
              disabled={savingUserId !== null}
              key={user.id}
              onClick={() => {
                setSavingUserId(user.id);
                setError(null);
                void commands
                  .addMember(user.id, role)
                  .then(onClose)
                  .catch(() => setError(messages.operationFailed))
                  .finally(() => setSavingUserId(null));
              }}
            >
              <span className="collaboration-resource-avatar">
                {user.user_name.slice(0, 1).toUpperCase()}
              </span>
              <span>
                <strong>{user.user_name}</strong>
                <small>{user.email ?? ""}</small>
              </span>
            </button>
          ))}
        </div>
        <footer>
          <button
            type="button"
            data-testid="collaboration-workspace-member-invite-cancel"
            onClick={onClose}
          >
            {messages.cancel}
          </button>
        </footer>
      </section>
    </div>
  );
}

export function WorkspaceMembersConfiguration({
  workspace,
  members,
  locale,
  commands,
}: {
  workspace: CollaborationWorkspace;
  members: CollaborationMember[];
  locale: "zh-CN" | "en";
  commands: WorkspaceResourceCommands;
}) {
  const messages = copy[locale];
  const [dialogOpen, setDialogOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingUserId, setPendingUserId] = useState<number | null>(null);
  const canManage =
    workspace.access_role === "Owner" || workspace.access_role === "Maintainer";

  return (
    <>
      <section className="collaboration-platform-panel">
        <div className="collaboration-resource-heading">
          <div>
            <h2>{messages.inviteMember}</h2>
            <p>{messages.memberHint}</p>
          </div>
          {canManage ? (
            <button
              type="button"
              className="collaboration-primary-button"
              data-testid="collaboration-workspace-member-invite"
              onClick={() => setDialogOpen(true)}
            >
              ＋ {messages.inviteMember}
            </button>
          ) : null}
        </div>
        <ErrorMessage message={error} />
        {members.length ? (
          <div className="collaboration-resource-list">
            {members.map((member) => (
              <div key={member.user_id}>
                <span className="collaboration-resource-avatar">
                  {member.user_name.slice(0, 1).toUpperCase()}
                </span>
                <span>
                  <strong>{member.user_name}</strong>
                  <small>{member.email ?? ""}</small>
                </span>
                {canManage && member.role !== "Owner" ? (
                  <>
                    <select
                      aria-label={`${member.user_name} ${messages.role}`}
                      data-testid={`collaboration-workspace-member-role-${member.user_id}`}
                      disabled={pendingUserId === member.user_id}
                      value={member.role}
                      onChange={(event) => {
                        setPendingUserId(member.user_id);
                        setError(null);
                        void commands
                          .updateMember(
                            member.user_id,
                            event.target.value as MemberRole,
                          )
                          .catch(() => setError(messages.operationFailed))
                          .finally(() => setPendingUserId(null));
                      }}
                    >
                      <option value="Maintainer">{messages.maintainer}</option>
                      <option value="Developer">{messages.developer}</option>
                      <option value="Reporter">{messages.reporter}</option>
                    </select>
                    <button
                      type="button"
                      className="collaboration-link-button collaboration-resource-remove"
                      data-testid={`collaboration-workspace-member-remove-${member.user_id}`}
                      disabled={pendingUserId === member.user_id}
                      onClick={() => {
                        setPendingUserId(member.user_id);
                        setError(null);
                        void commands
                          .removeMember(member.user_id)
                          .catch(() => setError(messages.operationFailed))
                          .finally(() => setPendingUserId(null));
                      }}
                    >
                      {messages.remove}
                    </button>
                  </>
                ) : (
                  <em>{roleLabel(member.role, messages)}</em>
                )}
              </div>
            ))}
          </div>
        ) : (
          <div className="collaboration-resource-empty">
            {messages.noMembers}
          </div>
        )}
      </section>
      {dialogOpen ? (
        <MemberInviteDialog
          members={members}
          messages={messages}
          commands={commands}
          onClose={() => setDialogOpen(false)}
        />
      ) : null}
    </>
  );
}

export function WorkspaceAgentsConfiguration({
  workspace,
  agents,
  resources,
  locale,
  commands,
}: {
  workspace: CollaborationWorkspace;
  agents: CollaborationOwnedAgent[];
  resources: CollaborationPlatformResources;
  locale: "zh-CN" | "en";
  commands: WorkspaceResourceCommands;
}) {
  const messages = copy[locale];
  const [pendingTeamId, setPendingTeamId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const assignedTeamIds = new Set(
    agents.flatMap((agent) => (agent.team_id ? [agent.team_id] : [])),
  );
  const candidates = resources.agents.filter(
    (candidate) => candidate.team_id && !assignedTeamIds.has(candidate.team_id),
  );
  const canAuthorize =
    workspace.access_role === "Owner" ||
    workspace.access_role === "Maintainer" ||
    workspace.access_role === "Developer";
  return (
    <section className="collaboration-platform-panel">
      <div className="collaboration-resource-heading">
        <div>
          <h2>{messages.authorizeAgent}</h2>
          <p>{messages.agentHint}</p>
        </div>
      </div>
      {canAuthorize ? (
        <ResourceAuthorizationForm
          kind="agent"
          candidates={candidates}
          messages={messages}
          getValue={(candidate) => String(candidate.team_id)}
          onAuthorize={(candidate) => commands.addAgent(candidate)}
        />
      ) : null}
      <ErrorMessage message={error} />
      {agents.length ? (
        <div className="collaboration-resource-list">
          {agents.map((agent) => (
            <div key={agent.id}>
              <span className="collaboration-resource-avatar">
                {agent.name.slice(0, 1).toUpperCase()}
              </span>
              <span>
                <strong>{agent.name}</strong>
                {agent.owner_name ? <small>{agent.owner_name}</small> : null}
              </span>
              <em>{agent.status}</em>
              {canAuthorize ? (
                <button
                  type="button"
                  className="collaboration-link-button collaboration-resource-remove"
                  data-testid={`collaboration-workspace-agent-remove-${agent.team_id}`}
                  disabled={pendingTeamId === agent.team_id}
                  onClick={() => {
                    setPendingTeamId(agent.team_id ?? null);
                    setError(null);
                    void commands
                      .removeAgent(agent)
                      .catch(() => setError(messages.operationFailed))
                      .finally(() => setPendingTeamId(null));
                  }}
                >
                  {messages.remove}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="collaboration-resource-empty">{messages.noAgents}</div>
      )}
    </section>
  );
}

export function WorkspaceCollaborationGroupsConfiguration({
  workspace,
  groups,
  availableGroups = [],
  members,
  agents,
  locale,
  commands,
  canManage: canManageOverride,
}: {
  workspace?: CollaborationWorkspace;
  groups: CollaborationGroup[];
  availableGroups?: CollaborationGroup[];
  members: CollaborationMember[];
  agents: CollaborationAgent[];
  locale: "zh-CN" | "en";
  commands: WorkspaceResourceCommands;
  canManage?: boolean;
}) {
  const messages = copy[locale];
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [leader, setLeader] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftLeader, setDraftLeader] = useState("");
  const [draftMembers, setDraftMembers] = useState<
    CollaborationGroup["members"]
  >([]);
  const [draftStages, setDraftStages] = useState<CollaborationGroup["stages"]>(
    [],
  );
  const canManage =
    canManageOverride ??
    (workspace?.access_role === "Owner" ||
      workspace?.access_role === "Maintainer" ||
      workspace?.access_role === "Developer");
  const collaborationGroupAgentId = (agent: CollaborationAgent) =>
    String(agent.team_id ?? agent.id);
  const candidates = [
    ...agents.map((agent) => ({
      value: `agent:${collaborationGroupAgentId(agent)}`,
      kind: "agent" as const,
      id: collaborationGroupAgentId(agent),
      name: agent.name,
    })),
    ...members.map((member) => ({
      value: `human:${member.user_id}`,
      kind: "human" as const,
      id: String(member.user_id),
      name: member.user_name,
    })),
  ];
  const selectedGroup =
    groups.find((group) => group.id === selectedGroupId) ?? null;

  useEffect(() => {
    if (!selectedGroup) return;
    setDraftName(selectedGroup.name);
    setDraftDescription(selectedGroup.description);
    setDraftLeader(`${selectedGroup.leader.kind}:${selectedGroup.leader.id}`);
    setDraftMembers(selectedGroup.members.map((member) => ({ ...member })));
    setDraftStages(
      selectedGroup.stages.map((stage) => ({
        ...stage,
        assignee: stage.assignee ? { ...stage.assignee } : null,
      })),
    );
    setError(null);
  }, [selectedGroup]);

  const displayName = (kind: "human" | "agent", id: string) =>
    candidates.find(
      (candidate) => candidate.kind === kind && candidate.id === id,
    )?.name ?? id;

  const updateMemberSelection = (
    candidate: (typeof candidates)[number],
    selected: boolean,
  ) => {
    const identity = `${candidate.kind}:${candidate.id}`;
    setDraftMembers((current) => {
      if (selected) {
        return current.some(
          (member) =>
            member.kind === candidate.kind && member.id === candidate.id,
        )
          ? current
          : [
              ...current,
              {
                kind: candidate.kind,
                id: candidate.id,
                responsibility: "",
              },
            ];
      }
      return current.filter(
        (member) =>
          member.kind !== candidate.kind || member.id !== candidate.id,
      );
    });
    if (!selected && draftLeader === identity) {
      const replacement = draftMembers.find(
        (member) => `${member.kind}:${member.id}` !== identity,
      );
      setDraftLeader(
        replacement ? `${replacement.kind}:${replacement.id}` : "",
      );
    }
  };

  return (
    <section className="collaboration-platform-panel">
      {selectedGroup ? (
        <div
          className="collaboration-group-detail"
          data-testid={`collaboration-group-detail-${selectedGroup.id}`}
        >
          <div className="collaboration-resource-heading">
            <div>
              <button
                type="button"
                className="collaboration-link-button collaboration-group-back"
                data-testid="collaboration-group-detail-back"
                onClick={() => setSelectedGroupId(null)}
              >
                ← {messages.backToGroups}
              </button>
              <h2>{selectedGroup.name}</h2>
              <p>
                {selectedGroup.owner_type === "project"
                  ? messages.projectOwned
                  : messages.workspaceOwned}
              </p>
            </div>
          </div>
          <form
            className="collaboration-group-detail-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (
                !commands.updateCollaborationGroup ||
                !draftName.trim() ||
                !draftLeader ||
                draftMembers.length === 0
              ) {
                return;
              }
              const [leaderKind, leaderId] = draftLeader.split(":");
              const leaderMember = draftMembers.find(
                (member) =>
                  member.kind === leaderKind && member.id === leaderId,
              );
              setSaving(true);
              setError(null);
              void commands
                .updateCollaborationGroup(selectedGroup.id, {
                  version: selectedGroup.version,
                  name: draftName.trim(),
                  description: draftDescription.trim(),
                  leader: {
                    kind: leaderKind as "human" | "agent",
                    id: leaderId,
                    responsibility: leaderMember?.responsibility ?? "",
                  },
                  members: draftMembers,
                  coordinationMode: "manager",
                  stages: draftStages,
                })
                .catch(() => setError(messages.operationFailed))
                .finally(() => setSaving(false));
            }}
          >
            <section className="collaboration-group-detail-section">
              <div className="collaboration-group-section-heading">
                <div>
                  <h3>{locale === "zh-CN" ? "基本信息" : "Basics"}</h3>
                  <p>{messages.createHint}</p>
                </div>
              </div>
              <div className="collaboration-group-field-grid">
                <label>
                  <span>{messages.groupName}</span>
                  <input
                    data-testid="collaboration-group-detail-name"
                    value={draftName}
                    disabled={!canManage}
                    onChange={(event) => setDraftName(event.target.value)}
                  />
                </label>
                <label className="collaboration-resource-form-wide">
                  <span>{messages.groupDescription}</span>
                  <textarea
                    data-testid="collaboration-group-detail-description"
                    value={draftDescription}
                    disabled={!canManage}
                    onChange={(event) =>
                      setDraftDescription(event.target.value)
                    }
                  />
                </label>
                <label>
                  <span>{messages.leader}</span>
                  <select
                    data-testid="collaboration-group-detail-leader"
                    value={draftLeader}
                    disabled={!canManage}
                    onChange={(event) => setDraftLeader(event.target.value)}
                  >
                    {draftMembers.map((member) => (
                      <option
                        key={`${member.kind}:${member.id}`}
                        value={`${member.kind}:${member.id}`}
                      >
                        {displayName(member.kind, member.id)}
                      </option>
                    ))}
                  </select>
                  <small>
                    {draftLeader.startsWith("human:")
                      ? messages.humanLeaderHint
                      : messages.agentLeaderHint}
                  </small>
                </label>
              </div>
            </section>

            <section className="collaboration-group-detail-section">
              <div className="collaboration-group-section-heading">
                <div>
                  <h3>{messages.membersLabel}</h3>
                  <p>
                    {locale === "zh-CN"
                      ? "成员可以是人或智能体；职责用于帮助负责人正确委派任务。"
                      : "Members can be people or agents. Responsibilities help the leader delegate correctly."}
                  </p>
                </div>
              </div>
              <div className="collaboration-group-member-picker">
                {candidates.map((candidate) => {
                  const selectedMember = draftMembers.find(
                    (member) =>
                      member.kind === candidate.kind &&
                      member.id === candidate.id,
                  );
                  return (
                    <div
                      key={candidate.value}
                      className="collaboration-group-member-row"
                    >
                      <label>
                        <input
                          type="checkbox"
                          data-testid={`collaboration-group-detail-member-${candidate.kind}-${candidate.id}`}
                          checked={Boolean(selectedMember)}
                          disabled={!canManage}
                          onChange={(event) =>
                            updateMemberSelection(
                              candidate,
                              event.target.checked,
                            )
                          }
                        />
                        <span className="collaboration-resource-avatar">
                          {candidate.name.slice(0, 1).toUpperCase()}
                        </span>
                        <span>
                          <strong>{candidate.name}</strong>
                          <small>
                            {candidate.kind === "human"
                              ? locale === "zh-CN"
                                ? "成员"
                                : "Person"
                              : locale === "zh-CN"
                                ? "智能体"
                                : "Agent"}
                          </small>
                        </span>
                      </label>
                      {selectedMember ? (
                        <input
                          data-testid={`collaboration-group-detail-responsibility-${candidate.kind}-${candidate.id}`}
                          value={selectedMember.responsibility}
                          disabled={!canManage}
                          placeholder={messages.memberResponsibility}
                          onChange={(event) =>
                            setDraftMembers((current) =>
                              current.map((member) =>
                                member.kind === candidate.kind &&
                                member.id === candidate.id
                                  ? {
                                      ...member,
                                      responsibility: event.target.value,
                                    }
                                  : member,
                              ),
                            )
                          }
                        />
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="collaboration-group-detail-section">
              <div className="collaboration-group-section-heading">
                <div>
                  <h3>{messages.stages}</h3>
                  <p>{messages.stagesHint}</p>
                </div>
                {canManage ? (
                  <button
                    type="button"
                    className="collaboration-secondary-button"
                    data-testid="collaboration-group-stage-add"
                    onClick={() =>
                      setDraftStages((current) => [
                        ...current,
                        {
                          id: crypto.randomUUID(),
                          name:
                            locale === "zh-CN"
                              ? `阶段 ${current.length + 1}`
                              : `Stage ${current.length + 1}`,
                          description: "",
                          assignee: null,
                        },
                      ])
                    }
                  >
                    + {messages.addStage}
                  </button>
                ) : null}
              </div>
              {draftStages.length ? (
                <div className="collaboration-group-stage-list">
                  {draftStages.map((stage, index) => (
                    <div
                      key={stage.id}
                      className="collaboration-group-stage-row"
                      data-testid={`collaboration-group-stage-${stage.id}`}
                    >
                      <span className="collaboration-group-stage-index">
                        {index + 1}
                      </span>
                      <div>
                        <input
                          value={stage.name}
                          disabled={!canManage}
                          aria-label={`${messages.stages} ${index + 1}`}
                          onChange={(event) =>
                            setDraftStages((current) =>
                              current.map((candidate) =>
                                candidate.id === stage.id
                                  ? {
                                      ...candidate,
                                      name: event.target.value,
                                    }
                                  : candidate,
                              ),
                            )
                          }
                        />
                        <textarea
                          value={stage.description}
                          disabled={!canManage}
                          placeholder={
                            locale === "zh-CN"
                              ? "说明这一阶段要完成什么"
                              : "Describe what this stage should accomplish"
                          }
                          onChange={(event) =>
                            setDraftStages((current) =>
                              current.map((candidate) =>
                                candidate.id === stage.id
                                  ? {
                                      ...candidate,
                                      description: event.target.value,
                                    }
                                  : candidate,
                              ),
                            )
                          }
                        />
                      </div>
                      <select
                        value={
                          stage.assignee
                            ? `${stage.assignee.kind}:${stage.assignee.id}`
                            : ""
                        }
                        disabled={!canManage}
                        aria-label={`${messages.leader} ${index + 1}`}
                        onChange={(event) => {
                          const [kind, id] = event.target.value.split(":");
                          const member = draftMembers.find(
                            (candidate) =>
                              candidate.kind === kind && candidate.id === id,
                          );
                          setDraftStages((current) =>
                            current.map((candidate) =>
                              candidate.id === stage.id
                                ? {
                                    ...candidate,
                                    assignee: member ? { ...member } : null,
                                  }
                                : candidate,
                            ),
                          );
                        }}
                      >
                        <option value="">{messages.dynamicAssignment}</option>
                        {draftMembers.map((member) => (
                          <option
                            key={`${member.kind}:${member.id}`}
                            value={`${member.kind}:${member.id}`}
                          >
                            {displayName(member.kind, member.id)}
                          </option>
                        ))}
                      </select>
                      {canManage ? (
                        <button
                          type="button"
                          className="collaboration-link-button collaboration-resource-remove"
                          aria-label={messages.remove}
                          onClick={() =>
                            setDraftStages((current) =>
                              current.filter(
                                (candidate) => candidate.id !== stage.id,
                              ),
                            )
                          }
                        >
                          {messages.remove}
                        </button>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="collaboration-resource-empty">
                  {locale === "zh-CN"
                    ? "当前由负责人动态分解工作。"
                    : "The leader currently plans work dynamically."}
                </div>
              )}
            </section>
            <ErrorMessage message={error} />
            {canManage && commands.updateCollaborationGroup ? (
              <div className="collaboration-resource-form-actions collaboration-group-save-actions">
                <button
                  type="submit"
                  className="collaboration-primary-button"
                  data-testid="collaboration-group-detail-save"
                  disabled={
                    saving ||
                    !draftName.trim() ||
                    !draftLeader ||
                    draftMembers.length === 0
                  }
                >
                  {saving
                    ? locale === "zh-CN"
                      ? "保存中…"
                      : "Saving…"
                    : messages.saveGroup}
                </button>
              </div>
            ) : null}
          </form>
        </div>
      ) : (
        <>
          <div className="collaboration-resource-heading">
            <div>
              {workspace ? <h2>{messages.collaborationGroups}</h2> : null}
              <p>{messages.collaborationGroupHint}</p>
            </div>
            {canManage && !formOpen ? (
              <button
                type="button"
                className="collaboration-primary-button"
                data-testid="collaboration-group-open-create"
                onClick={() => setFormOpen(true)}
              >
                {messages.createGroup}
              </button>
            ) : null}
          </div>
          {canManage && formOpen ? (
            <form
              className="collaboration-group-create-card"
              data-testid="collaboration-group-form"
              onSubmit={(event) => {
                event.preventDefault();
                if (!name.trim() || !leader) return;
                const [leaderKind, leaderId] = leader.split(":");
                setSaving(true);
                setError(null);
                void commands
                  .createCollaborationGroup({
                    name: name.trim(),
                    description: description.trim(),
                    leader: {
                      kind: leaderKind as "human" | "agent",
                      id: leaderId,
                      responsibility: "",
                    },
                    members: [
                      {
                        kind: leaderKind as "human" | "agent",
                        id: leaderId,
                        responsibility: "",
                      },
                    ],
                    coordinationMode: "manager",
                    stages: [],
                  })
                  .then((created) => {
                    setName("");
                    setDescription("");
                    setLeader("");
                    setFormOpen(false);
                    setSelectedGroupId(created.id);
                  })
                  .catch(() => setError(messages.operationFailed))
                  .finally(() => setSaving(false));
              }}
            >
              <div className="collaboration-group-create-heading">
                <div>
                  <h3>{messages.createGroup}</h3>
                  <p>{messages.createHint}</p>
                </div>
              </div>
              <div className="collaboration-group-field-grid">
                <label>
                  <span>{messages.groupName}</span>
                  <input
                    data-testid="collaboration-group-name"
                    value={name}
                    autoFocus
                    onChange={(event) => setName(event.target.value)}
                  />
                </label>
                <label className="collaboration-resource-form-wide">
                  <span>{messages.groupDescription}</span>
                  <textarea
                    data-testid="collaboration-group-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                  />
                </label>
                <label>
                  <span>{messages.leader}</span>
                  <select
                    data-testid="collaboration-group-leader"
                    value={leader}
                    onChange={(event) => setLeader(event.target.value)}
                  >
                    <option value="" />
                    {candidates.map((candidate) => (
                      <option key={candidate.value} value={candidate.value}>
                        {candidate.name} ·{" "}
                        {candidate.kind === "human"
                          ? locale === "zh-CN"
                            ? "成员"
                            : "Person"
                          : locale === "zh-CN"
                            ? "智能体"
                            : "Agent"}
                      </option>
                    ))}
                  </select>
                  {leader ? (
                    <small>
                      {leader.startsWith("human:")
                        ? messages.humanLeaderHint
                        : messages.agentLeaderHint}
                    </small>
                  ) : null}
                </label>
              </div>
              <div className="collaboration-resource-form-actions">
                <button
                  type="button"
                  className="collaboration-link-button"
                  data-testid="collaboration-group-create-cancel"
                  disabled={saving}
                  onClick={() => {
                    setFormOpen(false);
                    setError(null);
                  }}
                >
                  {messages.cancel}
                </button>
                <button
                  type="submit"
                  className="collaboration-primary-button"
                  data-testid="collaboration-group-create"
                  disabled={saving || !name.trim() || !leader}
                >
                  {messages.createGroup}
                </button>
              </div>
              <ErrorMessage message={error} />
            </form>
          ) : null}
          <div
            className={workspace ? undefined : "collaboration-resource-section"}
          >
            {!workspace ? <h3>{messages.projectGroups}</h3> : null}
            {groups.length ? (
              <div className="collaboration-group-card-grid">
                {groups.map((group) => (
                  <article
                    key={group.id}
                    className="collaboration-group-card"
                    data-testid={`collaboration-group-${group.id}`}
                  >
                    <div className="collaboration-group-card-header">
                      <span className="collaboration-resource-avatar">
                        {group.name.slice(0, 1).toUpperCase()}
                      </span>
                      <span>
                        <strong>{group.name}</strong>
                        <small>
                          {group.owner_type === "project"
                            ? messages.projectOwned
                            : messages.workspaceOwned}
                        </small>
                      </span>
                    </div>
                    <p>
                      {group.description ||
                        (locale === "zh-CN"
                          ? "暂未填写协作目标"
                          : "No collaboration goal yet")}
                    </p>
                    <div className="collaboration-group-card-meta">
                      <span>
                        {messages.leader}：
                        {displayName(group.leader.kind, group.leader.id)}
                      </span>
                      <span>
                        {group.members.length} {messages.membersLabel}
                      </span>
                      <span>
                        {group.stages.length
                          ? `${group.stages.length} ${messages.stages}`
                          : messages.dynamicAssignment}
                      </span>
                    </div>
                    <div className="collaboration-resource-actions">
                      <button
                        type="button"
                        className="collaboration-secondary-button"
                        data-testid={`collaboration-group-manage-${group.id}`}
                        onClick={() => setSelectedGroupId(group.id)}
                      >
                        {messages.manageGroup}
                      </button>
                      {canManage ? (
                        <button
                          type="button"
                          className="collaboration-link-button collaboration-resource-remove"
                          data-testid={`collaboration-group-remove-${group.id}`}
                          onClick={() => {
                            setError(null);
                            void commands
                              .removeCollaborationGroup(group.id)
                              .catch(() => setError(messages.operationFailed));
                          }}
                        >
                          {workspace
                            ? messages.remove
                            : group.owner_type === "project"
                              ? messages.deleteProjectGroup
                              : messages.removeFromProject}
                        </button>
                      ) : null}
                    </div>
                  </article>
                ))}
              </div>
            ) : (
              <div className="collaboration-resource-empty">
                {workspace ? messages.noGroups : messages.noProjectGroups}
              </div>
            )}
          </div>
          {availableGroups.length > 0 && commands.addCollaborationGroup ? (
            <div className="collaboration-resource-section">
              <h3>{messages.availableWorkspaceGroups}</h3>
              <div className="collaboration-group-card-grid">
                {availableGroups.map((group) => (
                  <article
                    key={group.id}
                    className="collaboration-group-card compact"
                    data-testid={`collaboration-group-available-${group.id}`}
                  >
                    <div className="collaboration-group-card-header">
                      <span className="collaboration-resource-avatar">
                        {group.name.slice(0, 1).toUpperCase()}
                      </span>
                      <span>
                        <strong>{group.name}</strong>
                        <small>{messages.workspaceOwned}</small>
                      </span>
                    </div>
                    {canManage ? (
                      <button
                        type="button"
                        className="collaboration-secondary-button"
                        data-testid={`collaboration-group-add-${group.id}`}
                        onClick={() => {
                          setError(null);
                          void commands
                            .addCollaborationGroup?.(group.id)
                            .catch(() => setError(messages.operationFailed));
                        }}
                      >
                        {locale === "zh-CN" ? "添加到项目" : "Add to project"}
                      </button>
                    ) : null}
                  </article>
                ))}
              </div>
            </div>
          ) : null}
          <ErrorMessage message={error} />
        </>
      )}
    </section>
  );
}

export function WorkspaceExecutionEnvironmentsConfiguration({
  workspace,
  environments,
  resources,
  locale,
  commands,
}: {
  workspace: CollaborationWorkspace;
  environments: CollaborationExecutionEnvironment[];
  resources: CollaborationPlatformResources;
  locale: "zh-CN" | "en";
  commands: WorkspaceResourceCommands;
}) {
  const messages = copy[locale];
  const [pendingDeviceId, setPendingDeviceId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const assignedDeviceIds = new Set(
    environments.flatMap((environment) =>
      environment.device_id ? [environment.device_id] : [],
    ),
  );
  const candidates = resources.execution_environments.filter(
    (candidate) =>
      candidate.device_id && !assignedDeviceIds.has(candidate.device_id),
  );
  const canAuthorize =
    workspace.access_role === "Owner" ||
    workspace.access_role === "Maintainer" ||
    workspace.access_role === "Developer";
  return (
    <section className="collaboration-platform-panel">
      <div className="collaboration-resource-heading">
        <div>
          <h2>{messages.authorizeEnvironment}</h2>
          <p>{messages.environmentHint}</p>
        </div>
      </div>
      {canAuthorize ? (
        <ResourceAuthorizationForm
          kind="environment"
          candidates={candidates}
          messages={messages}
          getValue={(candidate) => String(candidate.device_id)}
          onAuthorize={(candidate) =>
            commands.addExecutionEnvironment(candidate)
          }
        />
      ) : null}
      <ErrorMessage message={error} />
      {environments.length ? (
        <div className="collaboration-resource-list">
          {environments.map((environment) => (
            <div key={environment.id}>
              <span className="collaboration-resource-avatar">
                {environment.name.slice(0, 1).toUpperCase()}
              </span>
              <span>
                <strong>{environment.name}</strong>
                <small>
                  {environment.owner_name ? `${environment.owner_name} · ` : ""}
                  {environment.kind === "cloud_host" ? "Cloud" : "Local"}
                </small>
              </span>
              <em>{environment.status}</em>
              {canAuthorize ? (
                <button
                  type="button"
                  className="collaboration-link-button collaboration-resource-remove"
                  data-testid={`collaboration-workspace-environment-remove-${environment.device_id}`}
                  disabled={pendingDeviceId === environment.device_id}
                  onClick={() => {
                    setPendingDeviceId(environment.device_id ?? null);
                    setError(null);
                    void commands
                      .removeExecutionEnvironment(environment)
                      .catch(() => setError(messages.operationFailed))
                      .finally(() => setPendingDeviceId(null));
                  }}
                >
                  {messages.remove}
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : (
        <div className="collaboration-resource-empty">
          {messages.noEnvironments}
        </div>
      )}
    </section>
  );
}
