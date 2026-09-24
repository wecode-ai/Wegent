// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { X } from "lucide-react";
import {
  GroupParticipantsEditor,
  type GroupAgentAction,
  type GroupCandidate,
} from "./GroupParticipantsEditor";

import {
  clearMemberResultsForEmptyQuery,
  runActiveMemberSearch,
} from "../project-manage/memberSearch";
import type {
  CollaborationAgent,
  CollaborationGroup,
  CollaborationMember,
  CollaborationRole,
  CollaborationUser,
  CollaborationWorkspace,
} from "../types";

type MemberRole = Exclude<CollaborationRole, "Owner">;

export function isCurrentDeviceCollaborationAgent(
  agent: CollaborationAgent,
): boolean {
  return [
    "current-device-agent",
    "current-device-assistant",
    "当前设备智能体",
    "当前设备助手",
    "Current device Agent",
    "Current device assistant",
  ].includes(agent.agent_id ?? agent.name);
}

export interface WorkspaceResourceCommands {
  searchUsers(query: string): Promise<CollaborationUser[]>;
  addMember(userId: number, role: MemberRole): Promise<CollaborationMember>;
  updateMember(userId: number, role: MemberRole): Promise<CollaborationMember>;
  removeMember(userId: number): Promise<void>;
  createCollaborationGroup(input: {
    name: string;
    description?: string;
    instructions?: string;
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
    executionRequirements?: {
      requiredTags: string[];
    };
  }): Promise<CollaborationGroup>;
  updateCollaborationGroup?(
    groupId: string,
    input: {
      version: number;
      name?: string;
      description?: string;
      instructions?: string;
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
      executionRequirements?: {
        requiredTags: string[];
      };
    },
  ): Promise<CollaborationGroup>;
  removeCollaborationGroup(groupId: string): Promise<void>;
  addCollaborationGroup?(groupId: string): Promise<CollaborationGroup>;
}

export interface CollaborationGroupAgentActions {
  renderCreator?(props: {
    onClose(): void;
    onCreated(agent: CollaborationAgent): Promise<void>;
  }): ReactNode;
  copy?(agent: CollaborationAgent): Promise<CollaborationAgent>;
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
    noMembers: "空间中还没有成员",
    collaborationGroups: "协作小组",
    collaborationGroupHint:
      "把空间中的人与智能体组织成可复用的协作小组。负责人负责分解、委派、收敛和最终汇报。",
    groupName: "协作小组名称",
    groupDescription: "协作目标与边界",
    groupRule: "协作规则",
    groupRuleHint: "写清楚什么工作交给谁。",
    managerMode: "负责人协调",
    leader: "负责人",
    membersLabel: "成员",
    memberResponsibility: "职责",
    stages: "参考阶段",
    stagesHint: "可选",
    addStage: "添加阶段",
    leaderAssignment: "由负责人执行",
    environmentRequirements: "执行环境要求",
    environmentRequirementsHint: "按标签筛选可用环境，留空则不限制。",
    requiredEnvironmentTags: "环境标签",
    environmentTagPlaceholder: "输入标签后按回车",
    manageGroup: "管理",
    saveGroup: "保存",
    backToGroups: "返回协作小组",
    createHint: "已自动加入“我”并设置负责人，创建后可随时调整。",
    createGroup: "创建协作小组",
    noGroups: "空间中还没有协作小组",
    projectGroups: "项目正在使用",
    noProjectGroups: "当前项目还没有使用协作小组",
    availableWorkspaceGroups: "可从协作空间添加",
    workspaceOwned: "空间资源",
    projectOwned: "项目资源",
    removeFromProject: "移出项目",
    deleteProjectGroup: "删除",
    deleteGroup: "删除协作小组",
    deleteGroupConfirm: "删除后无法恢复。确认删除这个协作小组吗？",
    deleting: "删除中…",
    memberHint: "统一管理空间成员，方便空间内项目复用；项目仍可独立管理成员。",
    operationFailed: "操作失败，请稍后重试",
    createAgent: "新建智能体",
    createAgentHint: "配置一个仅属于当前协作小组的智能体",
    copyAgent: "复制其他小组的智能体",
    copyAgentHint: "复制配置并加入当前协作小组",
    copyAgentTitle: "复制智能体配置",
    noCopyableAgents: "没有可复制的智能体",
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
    noMembers: "No members in this workspace",
    collaborationGroups: "Collaboration groups",
    collaborationGroupHint:
      "Organize people and agents into reusable execution units. The leader plans, delegates, consolidates, and reports.",
    groupName: "Group name",
    groupDescription: "Goal and boundaries",
    groupRule: "Collaboration rules",
    groupRuleHint: "Describe which work should go to whom.",
    managerMode: "Leader coordinated",
    leader: "Leader",
    membersLabel: "Members",
    memberResponsibility: "Responsibility",
    stages: "Reference stages",
    stagesHint: "Optional",
    addStage: "Add stage",
    leaderAssignment: "Handled by leader",
    environmentRequirements: "Execution requirements",
    environmentRequirementsHint:
      "Filter available environments by tag. Leave empty for no restriction.",
    requiredEnvironmentTags: "Environment tags",
    environmentTagPlaceholder: "Enter a tag and press Enter",
    manageGroup: "Manage",
    saveGroup: "Save",
    backToGroups: "Back to groups",
    createHint:
      "You are added as leader automatically and can change the team later.",
    createGroup: "Create group",
    noGroups: "No collaboration groups in this workspace",
    projectGroups: "Used by this project",
    noProjectGroups: "This project is not using a collaboration group",
    availableWorkspaceGroups: "Available from workspace",
    workspaceOwned: "Workspace resource",
    projectOwned: "Project resource",
    removeFromProject: "Remove from project",
    deleteProjectGroup: "Delete",
    deleteGroup: "Delete team",
    deleteGroupConfirm:
      "This cannot be undone. Delete this collaboration team?",
    deleting: "Deleting…",
    memberHint:
      "Manage shared space members for reuse. Projects can still manage members independently.",
    operationFailed: "Operation failed. Please try again.",
    createAgent: "Create agent",
    createAgentHint: "Configure an agent owned only by this group",
    copyAgent: "Copy agent from another group",
    copyAgentHint: "Copy its configuration into this collaboration group",
    copyAgentTitle: "Copy agent configuration",
    noCopyableAgents: "No agents are available to copy",
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

export function WorkspaceCollaborationGroupsConfiguration({
  workspace,
  groups,
  availableGroups = [],
  members,
  agents,
  locale,
  currentUserId,
  commands,
  canManage: canManageOverride,
  initialCreateOpen = false,
  onCreateOpenChange,
  initialSelectedGroupId = null,
  onDetailClose,
  detailPresentation = "page",
  agentActions,
  showGroupCollection = true,
}: {
  workspace?: CollaborationWorkspace;
  groups: CollaborationGroup[];
  availableGroups?: CollaborationGroup[];
  members: CollaborationMember[];
  agents: CollaborationAgent[];
  locale: "zh-CN" | "en";
  currentUserId?: number;
  commands: WorkspaceResourceCommands;
  canManage?: boolean;
  initialCreateOpen?: boolean;
  onCreateOpenChange?(open: boolean): void;
  initialSelectedGroupId?: string | null;
  onDetailClose?(): void;
  detailPresentation?: "page" | "dialog";
  agentActions?: CollaborationGroupAgentActions;
  showGroupCollection?: boolean;
}) {
  const messages = copy[locale];
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [leader, setLeader] = useState("");
  const [createMembers, setCreateMembers] = useState<
    CollaborationGroup["members"]
  >([]);
  const [formOpen, setFormOpen] = useState(initialCreateOpen);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(
    initialSelectedGroupId,
  );
  const [deleteConfirmOpen, setDeleteConfirmOpen] = useState(false);
  const [detailTab, setDetailTab] = useState<
    "members" | "rules" | "environment"
  >("members");
  const [mentionOpen, setMentionOpen] = useState(false);
  const [draftName, setDraftName] = useState("");
  const [draftDescription, setDraftDescription] = useState("");
  const [draftInstructions, setDraftInstructions] = useState("");
  const [draftLeader, setDraftLeader] = useState("");
  const [draftMembers, setDraftMembers] = useState<
    CollaborationGroup["members"]
  >([]);
  const [draftStages, setDraftStages] = useState<CollaborationGroup["stages"]>(
    [],
  );
  const [draftRequiredEnvironmentTags, setDraftRequiredEnvironmentTags] =
    useState<string[]>([]);
  const [environmentTagInput, setEnvironmentTagInput] = useState("");
  const [createdAgents, setCreatedAgents] = useState<CollaborationAgent[]>([]);
  const [agentCreatorOpen, setAgentCreatorOpen] = useState(false);
  const [copyAgentOpen, setCopyAgentOpen] = useState(false);
  const [agentActionBusy, setAgentActionBusy] = useState(false);
  const ruleEditorRef = useRef<HTMLTextAreaElement>(null);
  const canManage =
    canManageOverride ??
    (workspace?.access_role === "Owner" ||
      workspace?.access_role === "Maintainer" ||
      workspace?.access_role === "Developer");
  const collaborationGroupAgentId = (agent: CollaborationAgent) =>
    String(agent.team_id ?? agent.id);
  const allAgents = useMemo(() => {
    const byId = new Map<string, CollaborationAgent>();
    [...agents, ...createdAgents].forEach((agent) => {
      byId.set(String(agent.team_id ?? agent.id), agent);
    });
    return [...byId.values()];
  }, [agents, createdAgents]);
  const candidates = [
    ...allAgents.map((agent) => ({
      value: `agent:${collaborationGroupAgentId(agent)}`,
      kind: "agent" as const,
      id: collaborationGroupAgentId(agent),
      name: agent.name,
    })),
    ...members.map((member) => ({
      value: `human:${member.user_id}`,
      kind: "human" as const,
      id: String(member.user_id),
      name:
        member.user_id === currentUserId
          ? locale === "zh-CN"
            ? "我"
            : "Me"
          : member.user_name,
    })),
  ];
  const selectedGroup =
    groups.find((group) => group.id === selectedGroupId) ?? null;
  const agentIdsOwnedByOtherGroups = new Set(
    groups.flatMap((group) => {
      if (group.id === selectedGroupId) return [];
      const ids = group.members
        .filter((member) => member.kind === "agent")
        .map((member) => member.id);
      if (group.leader.kind === "agent") ids.push(group.leader.id);
      return ids;
    }),
  );
  const copyableAgents = allAgents.filter((agent) =>
    agentIdsOwnedByOtherGroups.has(collaborationGroupAgentId(agent)),
  );

  const addCreatedAgent = (agent: CollaborationAgent) => {
    const agentId = collaborationGroupAgentId(agent);
    const candidate: GroupCandidate = {
      value: `agent:${agentId}`,
      kind: "agent",
      id: agentId,
      name: agent.name,
    };
    setCreatedAgents((current) => [
      ...current.filter((item) => collaborationGroupAgentId(item) !== agentId),
      agent,
    ]);
    if (selectedGroup) {
      setDraftMembers((current) =>
        current.some(
          (member) => member.kind === "agent" && member.id === agentId,
        )
          ? current
          : [...current, { kind: "agent", id: agentId, responsibility: "" }],
      );
      if (!draftLeader) setDraftLeader(candidate.value);
      return;
    }
    setCreateMembers((current) =>
      current.some((member) => member.kind === "agent" && member.id === agentId)
        ? current
        : [...current, { kind: "agent", id: agentId, responsibility: "" }],
    );
    if (!leader) setLeader(candidate.value);
  };

  const groupAgentActions: GroupAgentAction[] = [
    ...(agentActions?.renderCreator
      ? [
          {
            id: "create" as const,
            label: messages.createAgent,
            description: messages.createAgentHint,
            onSelect: () => setAgentCreatorOpen(true),
          },
        ]
      : []),
    ...(agentActions?.copy
      ? [
          {
            id: "copy" as const,
            label: messages.copyAgent,
            description: messages.copyAgentHint,
            onSelect: () => setCopyAgentOpen(true),
          },
        ]
      : []),
  ];

  useEffect(() => {
    setDeleteConfirmOpen(false);
  }, [selectedGroupId]);

  useEffect(() => {
    onCreateOpenChange?.(formOpen);
  }, [formOpen, onCreateOpenChange]);

  useEffect(() => {
    if (!formOpen || currentUserId == null) return;
    const currentMember = members.find(
      (member) => member.user_id === currentUserId,
    );
    if (!currentMember) return;
    setCreateMembers((current) =>
      current.some(
        (member) =>
          member.kind === "human" &&
          member.id === String(currentMember.user_id),
      )
        ? current
        : [
            {
              kind: "human",
              id: String(currentMember.user_id),
              responsibility: "",
            },
            ...current,
          ],
    );
    if (!leader) {
      setLeader(`human:${currentMember.user_id}`);
    }
  }, [currentUserId, formOpen, leader, members]);

  useEffect(() => {
    if (!selectedGroup) return;
    setDraftName(selectedGroup.name);
    setDraftDescription(selectedGroup.description);
    setDraftInstructions(selectedGroup.instructions ?? "");
    setDraftLeader(`${selectedGroup.leader.kind}:${selectedGroup.leader.id}`);
    setDraftMembers(selectedGroup.members.map((member) => ({ ...member })));
    setDraftStages(
      selectedGroup.stages.map((stage) => ({
        ...stage,
        assignee: stage.assignee ? { ...stage.assignee } : null,
      })),
    );
    setDraftRequiredEnvironmentTags(
      selectedGroup.execution_requirements?.required_tags ?? [],
    );
    setDetailTab("members");
    setMentionOpen(false);
    setEnvironmentTagInput("");
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
    if (!selected) {
      setDraftStages((current) =>
        current.map((stage) =>
          stage.assignee?.kind === candidate.kind &&
          stage.assignee.id === candidate.id
            ? { ...stage, assignee: null }
            : stage,
        ),
      );
    }
  };

  const updateCreateMemberSelection = (
    candidate: (typeof candidates)[number],
    selected: boolean,
  ) => {
    setCreateMembers((current) => {
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
    if (selected && !leader) {
      setLeader(candidate.value);
    }
  };

  const updateCreateMemberResponsibility = (
    candidate: (typeof candidates)[number],
    responsibility: string,
  ) => {
    setCreateMembers((current) =>
      current.map((member) =>
        member.kind === candidate.kind && member.id === candidate.id
          ? { ...member, responsibility }
          : member,
      ),
    );
  };

  const insertRuleMention = (candidate: (typeof candidates)[number]) => {
    const textarea = ruleEditorRef.current;
    const start = textarea?.selectionStart ?? draftInstructions.length;
    const end = textarea?.selectionEnd ?? start;
    const rawPrefix = draftInstructions.slice(0, start);
    const prefix = rawPrefix.endsWith("@") ? rawPrefix.slice(0, -1) : rawPrefix;
    const suffix = draftInstructions.slice(end);
    const leadingSpace = prefix && !/\s$/.test(prefix) ? " " : "";
    const trailingSpace = suffix && /^\s/.test(suffix) ? "" : " ";
    const mention = `@${candidate.name}`;
    const nextValue = `${prefix}${leadingSpace}${mention}${trailingSpace}${suffix}`;
    const nextCaret =
      prefix.length +
      leadingSpace.length +
      mention.length +
      trailingSpace.length;
    setDraftInstructions(nextValue);
    setMentionOpen(false);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(nextCaret, nextCaret);
    });
  };

  const addRequiredEnvironmentTag = () => {
    const nextTag = environmentTagInput.trim();
    if (!nextTag) return;
    setDraftRequiredEnvironmentTags((current) =>
      current.includes(nextTag) ? current : [...current, nextTag],
    );
    setEnvironmentTagInput("");
  };

  const content = (
    <>
      {selectedGroup ? (
        <div
          className={`collaboration-group-detail${
            detailPresentation === "dialog"
              ? " collaboration-group-detail-dialog"
              : ""
          }`}
          data-testid={`collaboration-group-detail-${selectedGroup.id}`}
        >
          {detailPresentation === "page" ? (
            <div className="collaboration-resource-heading">
              <div>
                <button
                  type="button"
                  className="collaboration-link-button collaboration-group-back"
                  data-testid="collaboration-group-detail-back"
                  onClick={() =>
                    onDetailClose ? onDetailClose() : setSelectedGroupId(null)
                  }
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
          ) : null}
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
                  instructions: draftInstructions.trim(),
                  leader: {
                    kind: leaderKind as "human" | "agent",
                    id: leaderId,
                    responsibility: leaderMember?.responsibility ?? "",
                  },
                  members: draftMembers,
                  coordinationMode: "manager",
                  stages: draftStages,
                  executionRequirements: {
                    requiredTags: draftRequiredEnvironmentTags,
                  },
                })
                .catch(() => setError(messages.operationFailed))
                .finally(() => setSaving(false));
            }}
          >
            <aside className="collaboration-group-detail-section collaboration-group-detail-profile">
              {detailPresentation === "page" ? (
                <>
                  <span className="collaboration-group-detail-avatar">
                    {draftName.slice(0, 1).toUpperCase()}
                  </span>
                  <div className="collaboration-group-section-heading">
                    <div>
                      <h3>{locale === "zh-CN" ? "基本信息" : "Basics"}</h3>
                      <p>
                        {selectedGroup.owner_type === "project"
                          ? messages.projectOwned
                          : messages.workspaceOwned}
                      </p>
                    </div>
                  </div>
                </>
              ) : (
                <div className="collaboration-group-dialog-section-title">
                  <h3>{locale === "zh-CN" ? "基本信息" : "Basics"}</h3>
                  <span>
                    {selectedGroup.owner_type === "project"
                      ? messages.projectOwned
                      : messages.workspaceOwned}
                  </span>
                </div>
              )}
              <div className="collaboration-group-profile-fields">
                <label>
                  <span>{messages.groupName}</span>
                  <input
                    data-testid="collaboration-group-detail-name"
                    value={draftName}
                    disabled={!canManage}
                    onChange={(event) => setDraftName(event.target.value)}
                  />
                </label>
                <label>
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
              </div>
              {detailPresentation === "page" ? (
                <dl className="collaboration-group-detail-meta">
                  <div>
                    <dt>{messages.membersLabel}</dt>
                    <dd>{draftMembers.length}</dd>
                  </div>
                  <div>
                    <dt>{messages.stages}</dt>
                    <dd>{draftStages.length}</dd>
                  </div>
                  <div>
                    <dt>{locale === "zh-CN" ? "版本" : "Version"}</dt>
                    <dd>{selectedGroup.version}</dd>
                  </div>
                </dl>
              ) : null}
            </aside>

            <div className="collaboration-group-detail-main">
              <div
                className="collaboration-group-detail-tabs"
                role="tablist"
                aria-label={
                  locale === "zh-CN"
                    ? "协作小组配置"
                    : "Collaboration group configuration"
                }
              >
                {(
                  [
                    ["members", messages.membersLabel],
                    ["rules", messages.groupRule],
                    ["environment", messages.environmentRequirements],
                  ] as const
                ).map(([tab, label]) => (
                  <button
                    key={tab}
                    type="button"
                    role="tab"
                    aria-selected={detailTab === tab}
                    className={detailTab === tab ? "active" : undefined}
                    data-testid={`collaboration-group-detail-tab-${tab}`}
                    onClick={() => setDetailTab(tab)}
                  >
                    {label}
                  </button>
                ))}
              </div>

              {detailTab === "members" ? (
                <section className="collaboration-group-detail-section collaboration-group-detail-tab-panel">
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
                  <GroupParticipantsEditor
                    candidates={candidates}
                    leader={draftLeader}
                    members={draftMembers}
                    locale={locale}
                    agentActions={
                      canManage && !agentActionBusy ? groupAgentActions : []
                    }
                    onLeaderChange={(candidate) => {
                      updateMemberSelection(candidate, true);
                      setDraftLeader(candidate.value);
                    }}
                    onMemberChange={updateMemberSelection}
                    onResponsibilityChange={(candidate, responsibility) =>
                      setDraftMembers((current) =>
                        current.map((member) =>
                          member.kind === candidate.kind &&
                          member.id === candidate.id
                            ? { ...member, responsibility }
                            : member,
                        ),
                      )
                    }
                  />
                </section>
              ) : null}

              {detailTab === "rules" ? (
                <section className="collaboration-group-detail-section collaboration-group-detail-tab-panel collaboration-group-rules-panel">
                  <div className="collaboration-group-section-heading">
                    <h3>{messages.groupRule}</h3>
                  </div>
                  <div className="collaboration-group-rule-editor">
                    <textarea
                      ref={ruleEditorRef}
                      data-testid="collaboration-group-detail-instructions"
                      value={draftInstructions}
                      disabled={!canManage}
                      placeholder={
                        locale === "zh-CN"
                          ? "说明如何协作，使用 @ 指定负责成员"
                          : "Describe how the group collaborates and use @ to assign members"
                      }
                      onChange={(event) => {
                        const nextValue = event.target.value;
                        setDraftInstructions(nextValue);
                        setMentionOpen(nextValue.endsWith("@"));
                      }}
                    />
                    <div className="collaboration-group-rule-editor-toolbar">
                      <button
                        type="button"
                        className="collaboration-secondary-button"
                        aria-expanded={mentionOpen}
                        data-testid="collaboration-group-rule-mention-trigger"
                        disabled={!canManage}
                        onClick={() => setMentionOpen((current) => !current)}
                      >
                        @ {locale === "zh-CN" ? "提及成员" : "Mention"}
                      </button>
                    </div>
                    {mentionOpen ? (
                      <div
                        className="collaboration-group-rule-mention-menu"
                        data-testid="collaboration-group-rule-mention-menu"
                      >
                        {draftMembers.map((member) => {
                          const candidate = candidates.find(
                            (item) =>
                              item.kind === member.kind &&
                              item.id === member.id,
                          );
                          if (!candidate) return null;
                          return (
                            <button
                              key={candidate.value}
                              type="button"
                              data-testid={`collaboration-group-rule-mention-${candidate.kind}-${candidate.id}`}
                              onClick={() => insertRuleMention(candidate)}
                            >
                              <span>
                                {candidate.name.slice(0, 1).toUpperCase()}
                              </span>
                              <strong>{candidate.name}</strong>
                              <small>{member.responsibility}</small>
                            </button>
                          );
                        })}
                      </div>
                    ) : null}
                  </div>

                  <div className="collaboration-group-reference-flow">
                    <div className="collaboration-group-section-heading">
                      <h3>
                        {messages.stages}
                        <small>{messages.stagesHint}</small>
                      </h3>
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
                      <div className="collaboration-group-stage-flow">
                        {draftStages.map((stage, index) => (
                          <div
                            key={stage.id}
                            className="collaboration-group-stage-card"
                            data-testid={`collaboration-group-stage-${stage.id}`}
                          >
                            <header>
                              <span>{index + 1}</span>
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
                              {canManage ? (
                                <button
                                  type="button"
                                  className="collaboration-link-button collaboration-resource-remove"
                                  aria-label={messages.remove}
                                  onClick={() =>
                                    setDraftStages((current) =>
                                      current.filter(
                                        (candidate) =>
                                          candidate.id !== stage.id,
                                      ),
                                    )
                                  }
                                >
                                  {messages.remove}
                                </button>
                              ) : null}
                            </header>
                            <div>
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
                              <select
                                value={
                                  stage.assignee
                                    ? `${stage.assignee.kind}:${stage.assignee.id}`
                                    : ""
                                }
                                disabled={!canManage}
                                aria-label={`${messages.leader} ${index + 1}`}
                                onChange={(event) => {
                                  const [kind, id] =
                                    event.target.value.split(":");
                                  const member = draftMembers.find(
                                    (candidate) =>
                                      candidate.kind === kind &&
                                      candidate.id === id,
                                  );
                                  setDraftStages((current) =>
                                    current.map((candidate) =>
                                      candidate.id === stage.id
                                        ? {
                                            ...candidate,
                                            assignee: member
                                              ? { ...member }
                                              : null,
                                          }
                                        : candidate,
                                    ),
                                  );
                                }}
                              >
                                <option value="">
                                  {messages.leaderAssignment}
                                </option>
                                {draftMembers.map((member) => (
                                  <option
                                    key={`${member.kind}:${member.id}`}
                                    value={`${member.kind}:${member.id}`}
                                  >
                                    @{displayName(member.kind, member.id)}
                                  </option>
                                ))}
                              </select>
                            </div>
                          </div>
                        ))}
                      </div>
                    ) : null}
                  </div>
                </section>
              ) : null}

              {detailTab === "environment" ? (
                <section className="collaboration-group-detail-section collaboration-group-detail-tab-panel collaboration-group-environment-panel">
                  <div className="collaboration-group-section-heading">
                    <h3>{messages.environmentRequirements}</h3>
                  </div>
                  <label>
                    <span>{messages.requiredEnvironmentTags}</span>
                    <div className="collaboration-group-environment-tag-input">
                      <input
                        data-testid="collaboration-group-environment-tag-input"
                        value={environmentTagInput}
                        disabled={!canManage}
                        placeholder={messages.environmentTagPlaceholder}
                        onChange={(event) =>
                          setEnvironmentTagInput(event.target.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key !== "Enter") return;
                          event.preventDefault();
                          addRequiredEnvironmentTag();
                        }}
                      />
                      <button
                        type="button"
                        className="collaboration-secondary-button"
                        data-testid="collaboration-group-environment-tag-add"
                        disabled={!canManage || !environmentTagInput.trim()}
                        onClick={addRequiredEnvironmentTag}
                      >
                        {locale === "zh-CN" ? "添加" : "Add"}
                      </button>
                    </div>
                  </label>
                  {draftRequiredEnvironmentTags.length ? (
                    <div className="collaboration-group-environment-tags">
                      {draftRequiredEnvironmentTags.map((tag) => (
                        <span key={tag}>
                          {tag}
                          {canManage ? (
                            <button
                              type="button"
                              aria-label={`${messages.remove} ${tag}`}
                              data-testid={`collaboration-group-environment-tag-remove-${tag}`}
                              onClick={() =>
                                setDraftRequiredEnvironmentTags((current) =>
                                  current.filter(
                                    (candidate) => candidate !== tag,
                                  ),
                                )
                              }
                            >
                              {messages.remove}
                            </button>
                          ) : null}
                        </span>
                      ))}
                    </div>
                  ) : (
                    <div className="collaboration-group-inline-empty">
                      {locale === "zh-CN" ? "不限环境" : "Any environment"}
                    </div>
                  )}
                </section>
              ) : null}
              <ErrorMessage message={error} />
              {canManage && commands.updateCollaborationGroup ? (
                <div className="collaboration-resource-form-actions collaboration-group-save-actions">
                  {deleteConfirmOpen ? (
                    <>
                      <span>{messages.deleteGroupConfirm}</span>
                      <button
                        type="button"
                        className="collaboration-secondary-button"
                        disabled={saving}
                        onClick={() => setDeleteConfirmOpen(false)}
                      >
                        {messages.cancel}
                      </button>
                      <button
                        type="button"
                        className="collaboration-link-button collaboration-resource-remove"
                        data-testid="collaboration-group-detail-delete-confirm"
                        disabled={saving}
                        onClick={() => {
                          setSaving(true);
                          setError(null);
                          void commands
                            .removeCollaborationGroup(selectedGroup.id)
                            .then(() => {
                              setSelectedGroupId(null);
                              onDetailClose?.();
                            })
                            .catch(() => setError(messages.operationFailed))
                            .finally(() => setSaving(false));
                        }}
                      >
                        {saving ? messages.deleting : messages.deleteGroup}
                      </button>
                    </>
                  ) : (
                    <button
                      type="button"
                      className="collaboration-link-button collaboration-resource-remove"
                      data-testid="collaboration-group-detail-delete"
                      disabled={saving}
                      onClick={() => setDeleteConfirmOpen(true)}
                    >
                      {messages.deleteGroup}
                    </button>
                  )}
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
            </div>
          </form>
        </div>
      ) : (
        <>
          {showGroupCollection ? (
            <div className="collaboration-resource-heading">
              <div>
                <h2>{messages.collaborationGroups}</h2>
                <p>{messages.collaborationGroupHint}</p>
              </div>
              {canManage && !formOpen ? (
                <button
                  type="button"
                  className={
                    workspace
                      ? "collaboration-primary-button"
                      : "collaboration-secondary-button"
                  }
                  data-testid="collaboration-group-open-create"
                  onClick={() => setFormOpen(true)}
                >
                  {messages.createGroup}
                </button>
              ) : null}
            </div>
          ) : null}
          {canManage && formOpen ? (
            <div
              className="collaboration-dialog-backdrop"
              role="presentation"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget && !saving) {
                  setFormOpen(false);
                }
              }}
            >
              <form
                className="collaboration-dialog collaboration-resource-dialog collaboration-group-create-dialog"
                data-testid="collaboration-group-form"
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!name.trim() || !leader) return;
                  const [leaderKind, leaderId] = leader.split(":");
                  const leaderMember = createMembers.find(
                    (member) => `${member.kind}:${member.id}` === leader,
                  );
                  const leaderResponsibility =
                    leaderMember?.responsibility ?? "";
                  setSaving(true);
                  setError(null);
                  void commands
                    .createCollaborationGroup({
                      name: name.trim(),
                      description: description.trim(),
                      leader: {
                        kind: leaderKind as "human" | "agent",
                        id: leaderId,
                        responsibility: leaderResponsibility,
                      },
                      members: [
                        {
                          kind: leaderKind as "human" | "agent",
                          id: leaderId,
                          responsibility: leaderResponsibility,
                        },
                        ...createMembers.filter(
                          (member) => `${member.kind}:${member.id}` !== leader,
                        ),
                      ],
                      coordinationMode: "manager",
                      instructions: "",
                      stages: [],
                      executionRequirements: { requiredTags: [] },
                    })
                    .then((created) => {
                      setName("");
                      setDescription("");
                      setLeader("");
                      setCreateMembers([]);
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
                    <p>
                      {locale === "zh-CN"
                        ? "已自动设置负责人，可在成员列表中随时调整。"
                        : "A leader is selected automatically and can be changed from the member list."}
                    </p>
                  </div>
                  <button
                    type="button"
                    className="collaboration-group-create-close"
                    data-testid="collaboration-group-create-close"
                    aria-label={locale === "zh-CN" ? "关闭" : "Close"}
                    disabled={saving}
                    onClick={() => {
                      setFormOpen(false);
                      setError(null);
                      setCreateMembers([]);
                      setLeader("");
                    }}
                  >
                    <X size={18} aria-hidden="true" />
                  </button>
                </div>
                <div className="collaboration-group-create-layout">
                  <div className="collaboration-group-create-main">
                    <div className="collaboration-group-create-content">
                      <section className="collaboration-group-create-panel">
                        <div className="collaboration-group-field-grid collaboration-group-create-fields">
                          <label>
                            <span>{messages.groupName}</span>
                            <input
                              data-testid="collaboration-group-name"
                              value={name}
                              autoFocus
                              onChange={(event) => setName(event.target.value)}
                            />
                          </label>
                          <label>
                            <span>{messages.groupDescription}</span>
                            <input
                              data-testid="collaboration-group-description"
                              value={description}
                              placeholder={
                                locale === "zh-CN"
                                  ? "简要说明这个小组负责什么"
                                  : "Briefly describe what this group owns"
                              }
                              onChange={(event) =>
                                setDescription(event.target.value)
                              }
                            />
                          </label>
                        </div>
                        <GroupParticipantsEditor
                          candidates={candidates}
                          leader={leader}
                          members={createMembers}
                          locale={locale}
                          compact
                          agentActions={
                            agentActionBusy ? [] : groupAgentActions
                          }
                          onLeaderChange={(candidate) => {
                            if (candidate.value === leader) return;
                            const previous = candidates.find(
                              (item) => item.value === leader,
                            );
                            setCreateMembers((current) => {
                              const next = [...current];
                              for (const participant of [previous, candidate]) {
                                if (
                                  participant &&
                                  !next.some(
                                    (member) =>
                                      `${member.kind}:${member.id}` ===
                                      participant.value,
                                  )
                                ) {
                                  next.push({
                                    kind: participant.kind,
                                    id: participant.id,
                                    responsibility: "",
                                  });
                                }
                              }
                              return next;
                            });
                            setLeader(candidate.value);
                          }}
                          onMemberChange={updateCreateMemberSelection}
                          onResponsibilityChange={
                            updateCreateMemberResponsibility
                          }
                        />
                      </section>
                    </div>

                    <div className="collaboration-resource-form-actions collaboration-group-create-actions">
                      <button
                        type="button"
                        className="collaboration-link-button"
                        data-testid="collaboration-group-create-cancel"
                        disabled={saving}
                        onClick={() => {
                          setFormOpen(false);
                          setError(null);
                          setCreateMembers([]);
                          setLeader("");
                        }}
                      >
                        {messages.cancel}
                      </button>
                      <span />
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
                  </div>
                </div>
              </form>
            </div>
          ) : null}
          {showGroupCollection ? (
            <>
              <div
                className={
                  workspace ? undefined : "collaboration-resource-section"
                }
              >
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
                        <div className="collaboration-group-card-summary">
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
                                : messages.leaderAssignment}
                            </span>
                          </div>
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
                                  .catch(() =>
                                    setError(messages.operationFailed),
                                  );
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
                                .catch(() =>
                                  setError(messages.operationFailed),
                                );
                            }}
                          >
                            {locale === "zh-CN"
                              ? "添加到项目"
                              : "Add to project"}
                          </button>
                        ) : null}
                      </article>
                    ))}
                  </div>
                </div>
              ) : null}
              <ErrorMessage message={error} />
            </>
          ) : null}
        </>
      )}
      {agentCreatorOpen && agentActions?.renderCreator
        ? agentActions.renderCreator({
            onClose: () => setAgentCreatorOpen(false),
            onCreated: async (agent) => {
              addCreatedAgent(agent);
              setAgentCreatorOpen(false);
            },
          })
        : null}
      {copyAgentOpen ? (
        <div
          className="collaboration-dialog-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !agentActionBusy) {
              setCopyAgentOpen(false);
            }
          }}
        >
          <section
            className="collaboration-dialog collaboration-resource-dialog collaboration-group-copy-agent-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={messages.copyAgentTitle}
            data-testid="collaboration-group-copy-agent-dialog"
          >
            <h2>{messages.copyAgentTitle}</h2>
            {copyableAgents.length ? (
              <div className="collaboration-resource-candidates">
                {copyableAgents.map((agent) => {
                  const agentId = collaborationGroupAgentId(agent);
                  return (
                    <button
                      type="button"
                      key={agentId}
                      disabled={agentActionBusy}
                      data-testid={`collaboration-group-copy-agent-${agentId}`}
                      onClick={() => {
                        setAgentActionBusy(true);
                        setError(null);
                        void agentActions
                          ?.copy?.(agent)
                          .then((created) => {
                            addCreatedAgent(created);
                            setCopyAgentOpen(false);
                          })
                          .catch(() => setError(messages.operationFailed))
                          .finally(() => setAgentActionBusy(false));
                      }}
                    >
                      <span className="collaboration-resource-avatar">
                        {agent.name.slice(0, 1).toUpperCase()}
                      </span>
                      <span>
                        <strong>{agent.name}</strong>
                        <small>{messages.copyAgentHint}</small>
                      </span>
                    </button>
                  );
                })}
              </div>
            ) : (
              <div className="collaboration-resource-empty">
                {messages.noCopyableAgents}
              </div>
            )}
            <footer>
              <button
                type="button"
                className="collaboration-secondary-button"
                disabled={agentActionBusy}
                onClick={() => setCopyAgentOpen(false)}
              >
                {messages.cancel}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );

  if (!showGroupCollection && !selectedGroup) {
    return content;
  }

  return (
    <section
      className={`collaboration-platform-panel${
        detailPresentation === "dialog"
          ? " collaboration-group-dialog-content"
          : ""
      }`}
    >
      {content}
    </section>
  );
}
