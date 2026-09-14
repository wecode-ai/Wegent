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
    leader: { kind: "human" | "agent"; id: string };
    members: Array<{ kind: "human" | "agent"; id: string }>;
    coordinationMode: "manager";
    policy: {
      prompt: string;
      triggerType: "manual" | "schedule" | "event";
      eventType: string | null;
      eventConfig: Record<string, unknown>;
      cronExpression: string | null;
      timezone: string;
      issueSelector: Record<string, unknown>;
      outputPolicy: Record<string, unknown>;
      enabled: boolean;
    };
  }): Promise<CollaborationGroup>;
  removeCollaborationGroup(groupId: string): Promise<void>;
  addCollaborationGroup?(groupId: string): Promise<CollaborationGroup>;
  runCollaborationGroup?(groupId: string): Promise<void>;
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
    collaborationGroups: "协作组",
    collaborationGroupHint:
      "把空间中的人与智能体组织成可复用的执行单元。负责人负责分解、委派、收敛和最终汇报。",
    groupName: "协作组名称",
    groupDescription: "协作目标与边界",
    triggerType: "触发方式",
    manualTrigger: "手动启动",
    scheduleTrigger: "定时运行",
    eventTrigger: "Issue 事件",
    cronExpression: "Cron 表达式",
    eventType: "事件类型",
    issueCreated: "Issue 创建",
    issueStatusChanged: "Issue 状态变化",
    collaborationPrompt: "协作指令",
    outputPolicy: "输出策略",
    outputComment: "发布结论评论",
    outputDelivery: "生成交付物",
    outputStatus: "更新 Issue 状态",
    managerMode: "负责人协调",
    leader: "负责人",
    membersLabel: "成员",
    createGroup: "创建协作组",
    noGroups: "空间中还没有协作组",
    projectGroups: "项目正在使用",
    noProjectGroups: "当前项目还没有使用协作组",
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
    triggerType: "Trigger",
    manualTrigger: "Manual",
    scheduleTrigger: "Schedule",
    eventTrigger: "Issue event",
    cronExpression: "Cron expression",
    eventType: "Event type",
    issueCreated: "Issue created",
    issueStatusChanged: "Issue status changed",
    collaborationPrompt: "Instructions",
    outputPolicy: "Output policy",
    outputComment: "Post conclusion comment",
    outputDelivery: "Create delivery",
    outputStatus: "Update Issue status",
    managerMode: "Leader coordinated",
    leader: "Leader",
    membersLabel: "Members",
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
  const [triggerType, setTriggerType] = useState<
    "manual" | "schedule" | "event"
  >("manual");
  const [cronExpression, setCronExpression] = useState("0 3 * * *");
  const [eventType, setEventType] = useState("task.created");
  const [prompt, setPrompt] = useState("");
  const [outputPolicy, setOutputPolicy] = useState("comment");
  const [selectedMembers, setSelectedMembers] = useState<string[]>([]);
  const [leader, setLeader] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runningGroupId, setRunningGroupId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const leaderIsAgent = leader.startsWith("agent:");
  const canManage =
    canManageOverride ??
    (workspace?.access_role === "Owner" ||
      workspace?.access_role === "Maintainer" ||
      workspace?.access_role === "Developer");
  const collaborationGroupAgentId = (agent: CollaborationAgent) =>
    String(agent.team_id ?? agent.id);
  function toggleMember(value: string) {
    setSelectedMembers((current) =>
      current.includes(value)
        ? current.filter((candidate) => candidate !== value)
        : [...current, value],
    );
    if (value === leader && selectedMembers.includes(value)) {
      setLeader("");
    }
  }

  return (
    <section className="collaboration-platform-panel">
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
          className="collaboration-resource-form"
          data-testid="collaboration-group-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (!name.trim() || !leader) return;
            setSaving(true);
            setError(null);
            void commands
              .createCollaborationGroup({
                name: name.trim(),
                description: description.trim(),
                leader: {
                  kind: leader.startsWith("human:") ? "human" : "agent",
                  id: leader.slice(leader.indexOf(":") + 1),
                },
                members: selectedMembers.map((value) => {
                  const [kind, id] = value.split(":");
                  return {
                    kind: kind as "human" | "agent",
                    id,
                  };
                }),
                coordinationMode: "manager",
                policy: {
                  prompt: prompt.trim(),
                  triggerType,
                  eventType: triggerType === "event" ? eventType : null,
                  eventConfig: {},
                  cronExpression:
                    triggerType === "schedule" ? cronExpression : null,
                  timezone: "Asia/Shanghai",
                  issueSelector: {},
                  outputPolicy: { mode: outputPolicy },
                  enabled: true,
                },
              })
              .then(() => {
                setName("");
                setDescription("");
                setSelectedMembers([]);
                setLeader("");
                setPrompt("");
                setFormOpen(false);
              })
              .catch(() => setError(messages.operationFailed))
              .finally(() => setSaving(false));
          }}
        >
          <label>
            <span>{messages.groupName}</span>
            <input
              data-testid="collaboration-group-name"
              value={name}
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
          <fieldset className="collaboration-resource-form-wide">
            <legend>{messages.membersLabel}</legend>
            {agents.map((agent) => (
              <label key={`agent:${collaborationGroupAgentId(agent)}`}>
                <input
                  type="checkbox"
                  data-testid={`collaboration-group-member-agent-${collaborationGroupAgentId(agent)}`}
                  checked={selectedMembers.includes(
                    `agent:${collaborationGroupAgentId(agent)}`,
                  )}
                  onChange={() =>
                    toggleMember(`agent:${collaborationGroupAgentId(agent)}`)
                  }
                />
                {agent.name}
              </label>
            ))}
            {members.map((member) => (
              <label key={`human:${member.user_id}`}>
                <input
                  type="checkbox"
                  data-testid={`collaboration-group-member-human-${member.user_id}`}
                  checked={selectedMembers.includes(`human:${member.user_id}`)}
                  onChange={() => toggleMember(`human:${member.user_id}`)}
                />
                {member.user_name}
              </label>
            ))}
          </fieldset>
          <label>
            <span>{messages.leader}</span>
            <select
              data-testid="collaboration-group-leader"
              value={leader}
              onChange={(event) => {
                const value = event.target.value;
                setLeader(value);
                if (!value.startsWith("agent:")) {
                  setTriggerType("manual");
                }
              }}
            >
              <option value="" />
              {selectedMembers.map((value) => {
                const [kind, id] = value.split(":");
                const name =
                  kind === "agent"
                    ? agents.find(
                        (agent) => collaborationGroupAgentId(agent) === id,
                      )?.name
                    : members.find((member) => String(member.user_id) === id)
                        ?.user_name;
                return (
                  <option key={value} value={value}>
                    {name}
                  </option>
                );
              })}
            </select>
          </label>
          <label>
            <span>{messages.triggerType}</span>
            <select
              data-testid="collaboration-group-trigger"
              value={triggerType}
              onChange={(event) =>
                setTriggerType(
                  event.target.value as "manual" | "schedule" | "event",
                )
              }
            >
              <option value="manual">{messages.manualTrigger}</option>
              <option value="schedule" disabled={!leaderIsAgent}>
                {messages.scheduleTrigger}
              </option>
              <option value="event" disabled={!leaderIsAgent}>
                {messages.eventTrigger}
              </option>
            </select>
          </label>
          {triggerType === "schedule" ? (
            <label>
              <span>{messages.cronExpression}</span>
              <input
                data-testid="collaboration-group-cron"
                value={cronExpression}
                onChange={(event) => setCronExpression(event.target.value)}
              />
            </label>
          ) : null}
          {triggerType === "event" ? (
            <label>
              <span>{messages.eventType}</span>
              <select
                data-testid="collaboration-group-event"
                value={eventType}
                onChange={(event) => setEventType(event.target.value)}
              >
                <option value="task.created">{messages.issueCreated}</option>
                <option value="task.status_changed">
                  {messages.issueStatusChanged}
                </option>
              </select>
            </label>
          ) : null}
          <label className="collaboration-resource-form-wide">
            <span>{messages.collaborationPrompt}</span>
            <textarea
              data-testid="collaboration-group-prompt"
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </label>
          <label>
            <span>{messages.outputPolicy}</span>
            <select
              data-testid="collaboration-group-output"
              value={outputPolicy}
              onChange={(event) => setOutputPolicy(event.target.value)}
            >
              <option value="comment">{messages.outputComment}</option>
              <option value="delivery">{messages.outputDelivery}</option>
              <option value="status">{messages.outputStatus}</option>
            </select>
          </label>
          <div className="collaboration-resource-form-actions">
            <button
              type="button"
              className="collaboration-link-button"
              data-testid="collaboration-group-create-cancel"
              disabled={saving}
              onClick={() => setFormOpen(false)}
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
      <div className={workspace ? undefined : "collaboration-resource-section"}>
        {!workspace ? <h3>{messages.projectGroups}</h3> : null}
        {groups.length ? (
          <div className="collaboration-resource-list">
            {groups.map((group) => (
              <div
                key={group.id}
                data-testid={`collaboration-group-${group.id}`}
              >
                <span className="collaboration-resource-avatar">
                  {group.name.slice(0, 1).toUpperCase()}
                </span>
                <span>
                  <strong>{group.name}</strong>
                  <small>
                    {messages.managerMode}
                    {" · "}
                    {group.policy.trigger_type === "schedule"
                      ? messages.scheduleTrigger
                      : group.policy.trigger_type === "event"
                        ? messages.eventTrigger
                        : messages.manualTrigger}
                    {" · "}
                    {group.members.length} {messages.membersLabel}
                    {" · "}
                    {group.owner_type === "project"
                      ? messages.projectOwned
                      : messages.workspaceOwned}
                  </small>
                </span>
                {canManage ? (
                  <span className="collaboration-resource-actions">
                    {!workspace &&
                    group.leader.kind === "agent" &&
                    group.policy.trigger_type === "manual" &&
                    commands.runCollaborationGroup ? (
                      <button
                        type="button"
                        className="collaboration-link-button"
                        data-testid={`collaboration-group-run-${group.id}`}
                        disabled={runningGroupId === group.id}
                        onClick={() => {
                          setError(null);
                          setRunningGroupId(group.id);
                          void commands
                            .runCollaborationGroup?.(group.id)
                            .catch(() => setError(messages.operationFailed))
                            .finally(() => setRunningGroupId(null));
                        }}
                      >
                        {runningGroupId === group.id
                          ? locale === "zh-CN"
                            ? "启动中…"
                            : "Starting…"
                          : locale === "zh-CN"
                            ? "运行"
                            : "Run"}
                      </button>
                    ) : null}
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
                  </span>
                ) : null}
              </div>
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
          <div className="collaboration-resource-list">
            {availableGroups.map((group) => (
              <div
                key={group.id}
                data-testid={`collaboration-group-available-${group.id}`}
              >
                <span className="collaboration-resource-avatar">
                  {group.name.slice(0, 1).toUpperCase()}
                </span>
                <span>
                  <strong>{group.name}</strong>
                  <small>{messages.workspaceOwned}</small>
                </span>
                {canManage ? (
                  <button
                    type="button"
                    className="collaboration-link-button"
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
              </div>
            ))}
          </div>
        </div>
      ) : null}
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
