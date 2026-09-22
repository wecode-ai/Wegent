// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState } from "react";
import { GroupParticipantsEditor } from "./GroupParticipantsEditor";

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
    createHint: "创建时完整配置成员、协作规则、参考阶段和执行环境要求。",
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
    deleteGroup: "删除协作小组",
    deleteGroupConfirm: "删除后无法恢复。确认删除这个协作小组吗？",
    deleting: "删除中…",
    memberHint: "统一管理空间成员，方便空间内项目复用；项目仍可独立管理成员。",
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
      "Configure members, collaboration rules, reference stages, and execution requirements before creating the group.",
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
    deleteGroup: "Delete team",
    deleteGroupConfirm:
      "This cannot be undone. Delete this collaboration team?",
    deleting: "Deleting…",
    memberHint:
      "Manage shared space members for reuse. Projects can still manage members independently.",
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

export function WorkspaceCollaborationGroupsConfiguration({
  workspace,
  groups,
  availableGroups = [],
  members,
  agents,
  locale,
  commands,
  canManage: canManageOverride,
  initialCreateOpen = false,
  onCreateOpenChange,
  initialSelectedGroupId = null,
  onDetailClose,
  detailPresentation = "page",
}: {
  workspace?: CollaborationWorkspace;
  groups: CollaborationGroup[];
  availableGroups?: CollaborationGroup[];
  members: CollaborationMember[];
  agents: CollaborationAgent[];
  locale: "zh-CN" | "en";
  commands: WorkspaceResourceCommands;
  canManage?: boolean;
  initialCreateOpen?: boolean;
  onCreateOpenChange?(open: boolean): void;
  initialSelectedGroupId?: string | null;
  onDetailClose?(): void;
  detailPresentation?: "page" | "dialog";
}) {
  const messages = copy[locale];
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [leader, setLeader] = useState("");
  const [createMembers, setCreateMembers] = useState<
    CollaborationGroup["members"]
  >([]);
  const [createTab, setCreateTab] = useState<
    "members" | "rules" | "environment"
  >("members");
  const [createInstructions, setCreateInstructions] = useState("");
  const [createStages, setCreateStages] = useState<
    CollaborationGroup["stages"]
  >([]);
  const [createRequiredEnvironmentTags, setCreateRequiredEnvironmentTags] =
    useState<string[]>([]);
  const [createEnvironmentTagInput, setCreateEnvironmentTagInput] =
    useState("");
  const [createMentionOpen, setCreateMentionOpen] = useState(false);
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
  const [memberPickerOpen, setMemberPickerOpen] = useState(false);
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
  const createRuleEditorRef = useRef<HTMLTextAreaElement>(null);
  const ruleEditorRef = useRef<HTMLTextAreaElement>(null);
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
    setDeleteConfirmOpen(false);
  }, [selectedGroupId]);

  useEffect(() => {
    onCreateOpenChange?.(formOpen);
  }, [formOpen, onCreateOpenChange]);

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
    setMemberPickerOpen(false);
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
    if (!selected) {
      setCreateStages((current) =>
        current.map((stage) =>
          stage.assignee?.kind === candidate.kind &&
          stage.assignee.id === candidate.id
            ? { ...stage, assignee: null }
            : stage,
        ),
      );
    }
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

  const insertCreateRuleMention = (candidate: (typeof candidates)[number]) => {
    const textarea = createRuleEditorRef.current;
    const start = textarea?.selectionStart ?? createInstructions.length;
    const end = textarea?.selectionEnd ?? start;
    const rawPrefix = createInstructions.slice(0, start);
    const prefix = rawPrefix.endsWith("@") ? rawPrefix.slice(0, -1) : rawPrefix;
    const suffix = createInstructions.slice(end);
    const leadingSpace = prefix && !/\s$/.test(prefix) ? " " : "";
    const trailingSpace = suffix && /^\s/.test(suffix) ? "" : " ";
    const mention = `@${candidate.name}`;
    const nextValue = `${prefix}${leadingSpace}${mention}${trailingSpace}${suffix}`;
    const nextCaret =
      prefix.length +
      leadingSpace.length +
      mention.length +
      trailingSpace.length;
    setCreateInstructions(nextValue);
    setCreateMentionOpen(false);
    requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(nextCaret, nextCaret);
    });
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

  const addCreateRequiredEnvironmentTag = () => {
    const nextTag = createEnvironmentTagInput.trim();
    if (!nextTag) return;
    setCreateRequiredEnvironmentTags((current) =>
      current.includes(nextTag) ? current : [...current, nextTag],
    );
    setCreateEnvironmentTagInput("");
  };

  return (
    <section
      className={`collaboration-platform-panel${
        detailPresentation === "dialog"
          ? " collaboration-group-dialog-content"
          : ""
      }`}
    >
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
                    {canManage ? (
                      <button
                        type="button"
                        className="collaboration-secondary-button"
                        data-testid="collaboration-group-member-picker-toggle"
                        onClick={() =>
                          setMemberPickerOpen((current) => !current)
                        }
                      >
                        + {locale === "zh-CN" ? "添加成员" : "Add member"}
                      </button>
                    ) : null}
                  </div>
                  <div className="collaboration-group-member-picker">
                    {candidates
                      .filter((candidate) =>
                        memberPickerOpen
                          ? true
                          : draftMembers.some(
                              (member) =>
                                member.kind === candidate.kind &&
                                member.id === candidate.id,
                            ),
                      )
                      .map((candidate) => {
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
                            {selectedMember &&
                            candidate.value !== draftLeader ? (
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
                  if (createTab === "members") {
                    if (name.trim() && leader) setCreateTab("rules");
                    return;
                  }
                  if (createTab === "rules") {
                    setCreateTab("environment");
                    return;
                  }
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
                        ...createMembers,
                      ],
                      coordinationMode: "manager",
                      instructions: createInstructions.trim(),
                      stages: createStages,
                      executionRequirements: {
                        requiredTags: createRequiredEnvironmentTags,
                      },
                    })
                    .then((created) => {
                      setName("");
                      setDescription("");
                      setLeader("");
                      setCreateMembers([]);
                      setCreateTab("members");
                      setCreateInstructions("");
                      setCreateStages([]);
                      setCreateRequiredEnvironmentTags([]);
                      setCreateEnvironmentTagInput("");
                      setCreateMentionOpen(false);
                      setFormOpen(false);
                      setSelectedGroupId(created.id);
                    })
                    .catch(() => setError(messages.operationFailed))
                    .finally(() => setSaving(false));
                }}
              >
                <div className="collaboration-group-create-heading">
                  <h3>{messages.createGroup}</h3>
                </div>
                <div className="collaboration-group-create-layout">
                  <div
                    className="collaboration-group-create-steps"
                    role="tablist"
                    aria-label={
                      locale === "zh-CN"
                        ? "创建协作小组步骤"
                        : "Create collaboration group steps"
                    }
                  >
                    {(
                      [
                        ["members", messages.membersLabel],
                        ["rules", messages.groupRule],
                        [
                          "environment",
                          locale === "zh-CN"
                            ? "环境要求"
                            : "Environment requirements",
                        ],
                      ] as const
                    ).map(([tab, label], index) => (
                      <button
                        key={tab}
                        type="button"
                        role="tab"
                        aria-selected={createTab === tab}
                        className={createTab === tab ? "active" : undefined}
                        data-testid={`collaboration-group-create-tab-${tab}`}
                        onClick={() => setCreateTab(tab)}
                      >
                        <span>{index + 1}</span>
                        {label}
                      </button>
                    ))}
                  </div>

                  <div className="collaboration-group-create-main">
                    <div className="collaboration-group-create-content">
                      {createTab === "members" ? (
                        <section className="collaboration-group-create-panel">
                          <div className="collaboration-group-section-heading">
                            <h3>
                              {locale === "zh-CN"
                                ? "成员与分工"
                                : "Members and roles"}
                            </h3>
                          </div>
                          <div className="collaboration-group-field-grid collaboration-group-create-fields">
                            <label>
                              <span>{messages.groupName}</span>
                              <input
                                data-testid="collaboration-group-name"
                                value={name}
                                autoFocus
                                onChange={(event) =>
                                  setName(event.target.value)
                                }
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
                            onLeaderChange={(candidate) => {
                              if (candidate.value === leader) return;
                              const previous = candidates.find(
                                (item) => item.value === leader,
                              );
                              setCreateMembers((current) => [
                                ...current.filter(
                                  (member) =>
                                    `${member.kind}:${member.id}` !==
                                    candidate.value,
                                ),
                                ...(previous
                                  ? [
                                      {
                                        kind: previous.kind,
                                        id: previous.id,
                                        responsibility: "",
                                      },
                                    ]
                                  : []),
                              ]);
                              setLeader(candidate.value);
                            }}
                            onMemberChange={updateCreateMemberSelection}
                            onResponsibilityChange={
                              updateCreateMemberResponsibility
                            }
                          />
                        </section>
                      ) : null}

                      {createTab === "rules" ? (
                        <section className="collaboration-group-create-panel collaboration-group-rules-panel">
                          <div className="collaboration-group-section-heading">
                            <h3>{messages.groupRule}</h3>
                          </div>
                          <div className="collaboration-group-rule-editor">
                            <textarea
                              ref={createRuleEditorRef}
                              data-testid="collaboration-group-create-instructions"
                              value={createInstructions}
                              placeholder={
                                locale === "zh-CN"
                                  ? "说明如何协作，使用 @ 指定负责成员"
                                  : "Describe how the group collaborates and use @ to assign members"
                              }
                              onChange={(event) => {
                                const nextValue = event.target.value;
                                setCreateInstructions(nextValue);
                                setCreateMentionOpen(nextValue.endsWith("@"));
                              }}
                            />
                            <div className="collaboration-group-rule-editor-toolbar">
                              <button
                                type="button"
                                className="collaboration-secondary-button"
                                aria-expanded={createMentionOpen}
                                data-testid="collaboration-group-create-mention-trigger"
                                onClick={() =>
                                  setCreateMentionOpen((current) => !current)
                                }
                              >
                                @ {locale === "zh-CN" ? "提及成员" : "Mention"}
                              </button>
                            </div>
                            {createMentionOpen ? (
                              <div className="collaboration-group-rule-mention-menu">
                                {candidates
                                  .filter(
                                    (candidate) =>
                                      candidate.value === leader ||
                                      createMembers.some(
                                        (member) =>
                                          member.kind === candidate.kind &&
                                          member.id === candidate.id,
                                      ),
                                  )
                                  .map((candidate) => (
                                    <button
                                      key={candidate.value}
                                      type="button"
                                      data-testid={`collaboration-group-create-mention-${candidate.kind}-${candidate.id}`}
                                      onClick={() =>
                                        insertCreateRuleMention(candidate)
                                      }
                                    >
                                      <span>
                                        {candidate.name
                                          .slice(0, 1)
                                          .toUpperCase()}
                                      </span>
                                      <strong>{candidate.name}</strong>
                                    </button>
                                  ))}
                              </div>
                            ) : null}
                          </div>
                          <div className="collaboration-group-reference-flow">
                            <div className="collaboration-group-section-heading">
                              <h3>
                                {messages.stages}
                                <small>{messages.stagesHint}</small>
                              </h3>
                              <button
                                type="button"
                                className="collaboration-secondary-button"
                                data-testid="collaboration-group-create-stage-add"
                                onClick={() =>
                                  setCreateStages((current) => [
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
                            </div>
                            {createStages.length ? (
                              <div className="collaboration-group-stage-flow">
                                {createStages.map((stage, index) => (
                                  <div
                                    key={stage.id}
                                    className="collaboration-group-stage-card"
                                    data-testid={`collaboration-group-create-stage-${stage.id}`}
                                  >
                                    <header>
                                      <span>{index + 1}</span>
                                      <input
                                        value={stage.name}
                                        aria-label={`${messages.stages} ${index + 1}`}
                                        onChange={(event) =>
                                          setCreateStages((current) =>
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
                                      <button
                                        type="button"
                                        className="collaboration-link-button"
                                        onClick={() =>
                                          setCreateStages((current) =>
                                            current.filter(
                                              (candidate) =>
                                                candidate.id !== stage.id,
                                            ),
                                          )
                                        }
                                      >
                                        {messages.remove}
                                      </button>
                                    </header>
                                    <div>
                                      <textarea
                                        value={stage.description}
                                        placeholder={
                                          locale === "zh-CN"
                                            ? "说明这一阶段要完成什么"
                                            : "Describe what this stage should accomplish"
                                        }
                                        onChange={(event) =>
                                          setCreateStages((current) =>
                                            current.map((candidate) =>
                                              candidate.id === stage.id
                                                ? {
                                                    ...candidate,
                                                    description:
                                                      event.target.value,
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
                                        onChange={(event) => {
                                          const selected = [
                                            {
                                              kind: leader.split(":")[0] as
                                                | "human"
                                                | "agent",
                                              id: leader.split(":")[1],
                                              responsibility: "",
                                            },
                                            ...createMembers,
                                          ].find(
                                            (member) =>
                                              `${member.kind}:${member.id}` ===
                                              event.target.value,
                                          );
                                          setCreateStages((current) =>
                                            current.map((candidate) =>
                                              candidate.id === stage.id
                                                ? {
                                                    ...candidate,
                                                    assignee: selected
                                                      ? { ...selected }
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
                                        {candidates
                                          .filter(
                                            (candidate) =>
                                              candidate.value === leader ||
                                              createMembers.some(
                                                (member) =>
                                                  member.kind ===
                                                    candidate.kind &&
                                                  member.id === candidate.id,
                                              ),
                                          )
                                          .map((candidate) => (
                                            <option
                                              key={candidate.value}
                                              value={candidate.value}
                                            >
                                              @{candidate.name}
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

                      {createTab === "environment" ? (
                        <section className="collaboration-group-create-panel collaboration-group-environment-panel">
                          <div className="collaboration-group-section-heading">
                            <h3>{messages.environmentRequirements}</h3>
                          </div>
                          <label>
                            <span>{messages.requiredEnvironmentTags}</span>
                            <div className="collaboration-group-environment-tag-input">
                              <input
                                data-testid="collaboration-group-create-environment-tag-input"
                                value={createEnvironmentTagInput}
                                placeholder={messages.environmentTagPlaceholder}
                                onChange={(event) =>
                                  setCreateEnvironmentTagInput(
                                    event.target.value,
                                  )
                                }
                                onKeyDown={(event) => {
                                  if (event.key !== "Enter") return;
                                  event.preventDefault();
                                  addCreateRequiredEnvironmentTag();
                                }}
                              />
                              <button
                                type="button"
                                className="collaboration-secondary-button"
                                data-testid="collaboration-group-create-environment-tag-add"
                                disabled={!createEnvironmentTagInput.trim()}
                                onClick={addCreateRequiredEnvironmentTag}
                              >
                                {locale === "zh-CN" ? "添加" : "Add"}
                              </button>
                            </div>
                          </label>
                          {createRequiredEnvironmentTags.length ? (
                            <div className="collaboration-group-environment-tags">
                              {createRequiredEnvironmentTags.map((tag) => (
                                <span key={tag}>
                                  {tag}
                                  <button
                                    type="button"
                                    aria-label={`${messages.remove} ${tag}`}
                                    onClick={() =>
                                      setCreateRequiredEnvironmentTags(
                                        (current) =>
                                          current.filter(
                                            (candidate) => candidate !== tag,
                                          ),
                                      )
                                    }
                                  >
                                    {messages.remove}
                                  </button>
                                </span>
                              ))}
                            </div>
                          ) : (
                            <div className="collaboration-group-inline-empty">
                              {locale === "zh-CN"
                                ? "不限环境"
                                : "Any environment"}
                            </div>
                          )}
                        </section>
                      ) : null}
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
                          setCreateTab("members");
                        }}
                      >
                        {messages.cancel}
                      </button>
                      <span />
                      {createTab !== "members" ? (
                        <button
                          type="button"
                          className="collaboration-secondary-button"
                          data-testid="collaboration-group-create-back"
                          onClick={() =>
                            setCreateTab(
                              createTab === "environment" ? "rules" : "members",
                            )
                          }
                        >
                          {locale === "zh-CN" ? "上一步" : "Back"}
                        </button>
                      ) : null}
                      <button
                        type="submit"
                        className="collaboration-primary-button"
                        data-testid={
                          createTab === "environment"
                            ? "collaboration-group-create"
                            : "collaboration-group-create-next"
                        }
                        disabled={saving || !name.trim() || !leader}
                      >
                        {createTab === "environment"
                          ? messages.createGroup
                          : locale === "zh-CN"
                            ? "下一步"
                            : "Next"}
                      </button>
                    </div>
                    <ErrorMessage message={error} />
                  </div>
                </div>
              </form>
            </div>
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
                          : messages.leaderAssignment}
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
