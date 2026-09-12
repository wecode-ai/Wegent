// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState } from "react";

import {
  clearMemberResultsForEmptyQuery,
  runActiveMemberSearch,
} from "../project-manage/memberSearch";
import type {
  CollaborationExecutionEnvironment,
  CollaborationMember,
  CollaborationOwnedAgent,
  CollaborationPlatformResources,
  CollaborationRole,
  CollaborationUser,
  CollaborationWorkspace,
} from "../types";

type MemberRole = Exclude<CollaborationRole, "Owner">;

export interface WorkspaceResourceCommands {
  searchUsers(query: string): Promise<CollaborationUser[]>;
  addMember(userId: number, role: MemberRole): Promise<CollaborationMember>;
  updateMember(userId: number, role: MemberRole): Promise<CollaborationMember>;
  removeMember(userId: number): Promise<void>;
  addAgent(agent: CollaborationOwnedAgent): Promise<CollaborationOwnedAgent>;
  removeAgent(agent: CollaborationOwnedAgent): Promise<void>;
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
    authorizeAgent: "授权智能体",
    authorizeEnvironment: "授权执行环境",
    chooseAgent: "选择我的智能体",
    chooseEnvironment: "选择我的执行环境",
    authorize: "授权到空间",
    noCandidates: "我的资源中没有可授权项",
    noMembers: "空间中还没有成员",
    noAgents: "空间中还没有智能体",
    noEnvironments: "空间中还没有执行环境",
    memberHint: "成员可以进入空间，并按角色参与项目协作。",
    agentHint: "从我的资源中选择智能体，授权给当前空间使用。",
    environmentHint: "从我的资源中选择执行环境，授权给当前空间使用。",
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
    authorizeAgent: "Authorize agent",
    authorizeEnvironment: "Authorize execution environment",
    chooseAgent: "Choose one of my agents",
    chooseEnvironment: "Choose one of my execution environments",
    authorize: "Authorize to workspace",
    noCandidates: "No resources available to authorize",
    noMembers: "No members in this workspace",
    noAgents: "No agents in this workspace",
    noEnvironments: "No execution environments in this workspace",
    memberHint: "Members can enter the workspace and collaborate by role.",
    agentHint: "Authorize one of my agents for this workspace.",
    environmentHint:
      "Authorize one of my execution environments for this workspace.",
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

function ResourceAuthorizationForm<T extends { id: string; name: string }>({
  kind,
  candidates,
  messages,
  getValue,
  onAuthorize,
}: {
  kind: "agent" | "environment";
  candidates: T[];
  messages: ResourceCopy;
  getValue(resource: T): string;
  onAuthorize(resource: T): Promise<unknown>;
}) {
  const [resourceId, setResourceId] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selected = candidates.find(
    (candidate) => getValue(candidate) === resourceId,
  );
  const prefix =
    kind === "agent"
      ? "collaboration-workspace-agent"
      : "collaboration-workspace-environment";

  return (
    <div className="collaboration-resource-authorization">
      <select
        aria-label={
          kind === "agent" ? messages.chooseAgent : messages.chooseEnvironment
        }
        data-testid={`${prefix}-candidate`}
        value={resourceId}
        onChange={(event) => setResourceId(event.target.value)}
      >
        <option value="">
          {candidates.length
            ? kind === "agent"
              ? messages.chooseAgent
              : messages.chooseEnvironment
            : messages.noCandidates}
        </option>
        {candidates.map((candidate) => (
          <option key={candidate.id} value={getValue(candidate)}>
            {candidate.name}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="collaboration-primary-button"
        data-testid={`${prefix}-authorize`}
        disabled={!selected || saving}
        onClick={() => {
          if (!selected) return;
          setSaving(true);
          setError(null);
          void onAuthorize(selected)
            .then(() => setResourceId(""))
            .catch(() => setError(messages.operationFailed))
            .finally(() => setSaving(false));
        }}
      >
        {messages.authorize}
      </button>
      <ErrorMessage message={error} />
    </div>
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
