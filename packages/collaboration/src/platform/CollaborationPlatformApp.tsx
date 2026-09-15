// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  CircleCheck,
  ChevronRight,
  Clock3,
  Ellipsis,
  FolderPlus,
  FolderOpen,
  Inbox,
  Settings,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";

import { CollaborationApp } from "../CollaborationApp";
import {
  createCollaborationTranslator,
  type CollaborationLocale,
} from "../i18n";
import type {
  SharedWorkspaceApi,
  WorkspaceMyWorkItem,
  WorkspaceProjectAgent,
} from "../ports/SharedWorkspaceApi";
import {
  createWegentProjectAgentInput,
  ProjectAgentConfiguration,
} from "../project-agent-config";
import { ProjectCreateDialog, projectCreateLabels } from "../project-create";
import {
  CollaborationParticipantsTabs,
  ProjectExecutionEnvironments,
  ProjectSettingsShell,
} from "../project-manage";
import type {
  CollaborationExecutionEnvironment,
  CollaborationExecution,
  CollaborationIssue,
  CollaborationOwnedAgent,
  CollaborationProject,
  CollaborationWorkspace,
  CollaborationWorkspaceNavigationContext,
} from "../types";
import type {
  CollaborationPlatformHostAdapter,
  CollaborationPlatformLocation,
  CollaborationWorkspaceView,
} from "./types";
import { useCollaborationPlatformController } from "./useCollaborationPlatformController";
import {
  createWorkspaceOperationsSnapshot,
  workspaceIssueOperationState,
  type WorkspaceOperationState,
  type WorkspaceProjectIssuesSnapshot,
} from "./workspaceOperations";
import {
  WorkspaceCollaborationGroupsConfiguration,
  WorkspaceMembersConfiguration,
} from "./WorkspaceResourceConfiguration";

const platformMessages = {
  "zh-CN": {
    allSpaces: "所有空间",
    collaborationHome: "协作首页",
    collaborationHomeHint: "继续推进你和团队正在进行的工作。",
    myWork: "我的工作",
    inbox: "收件箱",
    runCenter: "运行中心",
    needsYourAction: "需要你处理",
    activeWork: "进行中的工作",
    recentProjects: "最近访问",
    noActiveWork: "当前没有正在推进的工作",
    noActiveWorkHint: "可以进入最近项目创建 Issue，或查看已有工作。",
    noInboxItems: "当前没有需要你处理的事项",
    noRuns: "当前没有执行记录",
    currentOwner: "当前负责人",
    currentStep: "当前步骤",
    runStatus: "运行状态",
    lastUpdated: "最后更新",
    openIssue: "打开 Issue",
    reviewNow: "去确认",
    viewItem: "查看",
    unassigned: "未分配",
    human: "成员",
    agent: "智能体",
    group: "协作小组",
    workspaceHint: "空间是成员、项目、智能体和执行环境的协作边界。",
    createWorkspace: "创建云端空间",
    cloudStorageNotice:
      "空间、项目与 Issue 将保存在 Wegent 云端，可在 Wework 和网页端跨设备协作。",
    localStorage: "本地 · 仅当前设备",
    cloudStorage: "云端 · 可跨设备协作",
    localSpaces: "当前设备",
    cloudSpaces: "云端空间",
    localOnlyHint:
      "当前仅显示本地空间。创建云端空间后即可邀请成员并跨设备协作。",
    joinWorkspace: "加入空间",
    noSpaces: "还没有协作空间",
    noSpacesHint: "先创建空间，再在空间中组织成员、项目和 AI 资源。",
    workspaceHome: "空间首页",
    currentWorkspace: "当前空间",
    allProjects: "全部项目",
    members: "成员",
    agents: "智能体",
    collaborationParticipants: "协作成员",
    collaborationParticipantsHint:
      "统一管理空间中的智能体、成员和协作小组，供空间内项目复用。",
    collaborationGroups: "协作小组",
    environments: "执行环境",
    settings: "空间设置",
    basicInformation: "基本信息",
    projects: "项目",
    workspaceManagement: "空间管理",
    createProject: "创建项目",
    createCollaborationProject: "新建协作项目",
    firstProjectHomeTitle: "创建第一个协作项目",
    firstProjectHomeHint:
      "用项目组织 Issue、成员和智能体。创建后即可开始分配和自动处理工作。",
    chooseProjectWorkspace: "选择项目所属空间",
    chooseProjectWorkspaceHint: "项目创建后不可移动到其他协作空间。",
    noProjects: "还没有项目",
    noProjectsHint: "创建项目后即可使用看板和表格组织 Issue。",
    enterWorkspace: "进入空间",
    enterProject: "进入项目",
    projectCount: "项目",
    save: "保存",
    cancel: "取消",
    name: "名称",
    description: "描述",
    owner: "归属",
    personalOwner: "个人",
    ownerHint: "决定空间内新建智能体和其他资源的默认归属。",
    workspaceSettingsHint: "管理空间基本信息、成员和协作资源。",
    loadFailed: "加载协作空间失败",
    searchSpaces: "搜索空间",
    firstUseProgress: "开始协作",
    firstProjectTitle: "创建第一个项目",
    firstProjectHint:
      "项目负责组织 Issue、成员和分配方式；智能体与执行环境可以稍后配置。",
    configureAgents: "配置智能体",
    inviteMembers: "邀请成员",
    workspaceResources: "空间资源",
    operationsOverview: "运行总览",
    operationsHint: "跨项目查看当前正在推进、等待确认和发生异常的工作。",
    operatingProjects: "项目运行状态",
    operatingProjectsHint: "异常和待确认项目优先显示。",
    needsAttention: "需要关注",
    attentionCount: "项需要处理",
    issues: "项 Issue",
    noAttention: "当前没有异常或待确认事项",
    running: "运行中",
    waitingReview: "待确认",
    failed: "异常",
    unavailable: "状态不可用",
    pending: "待开始",
    stable: "正常",
    idle: "空闲",
    updatedAt: "最近变化",
    viewAll: "查看全部",
    collaborationSpaces: "协作空间",
    collaborationSettings: "协作设置",
    manageAgents: "管理智能体资源",
    manageEnvironments: "管理执行环境",
    expandWorkspace: "展开空间项目",
    collapseWorkspace: "收起空间项目",
  },
  en: {
    allSpaces: "All spaces",
    collaborationHome: "Collaboration home",
    collaborationHomeHint: "Keep your team's active work moving.",
    myWork: "My work",
    inbox: "Inbox",
    runCenter: "Run center",
    needsYourAction: "Needs your action",
    activeWork: "Work in progress",
    recentProjects: "Recently visited",
    noActiveWork: "No work is currently in progress",
    noActiveWorkHint:
      "Open a recent project to create an issue or review existing work.",
    noInboxItems: "Nothing needs your attention right now",
    noRuns: "No execution records yet",
    currentOwner: "Current owner",
    currentStep: "Current step",
    runStatus: "Run status",
    lastUpdated: "Last updated",
    openIssue: "Open issue",
    reviewNow: "Review",
    viewItem: "View",
    unassigned: "Unassigned",
    human: "Member",
    agent: "Agent",
    group: "Collaboration group",
    workspaceHint:
      "A workspace is the collaboration boundary for members, projects, agents, and execution environments.",
    createWorkspace: "Create cloud space",
    cloudStorageNotice:
      "The space, projects, and issues are stored in Wegent Cloud for cross-device collaboration in Wework and on the web.",
    localStorage: "Local · This device only",
    cloudStorage: "Cloud · Cross-device",
    localSpaces: "This device",
    cloudSpaces: "Cloud spaces",
    localOnlyHint:
      "Only the local space is available. Create a cloud space to invite members and collaborate across devices.",
    joinWorkspace: "Join space",
    noSpaces: "No collaboration spaces yet",
    noSpacesHint:
      "Create a space, then organize members, projects, and AI resources inside it.",
    workspaceHome: "Space home",
    currentWorkspace: "Current space",
    allProjects: "All projects",
    members: "Members",
    agents: "Agents",
    collaborationParticipants: "Collaboration members",
    collaborationParticipantsHint:
      "Manage workspace agents, members, and collaboration groups together for reuse across projects.",
    collaborationGroups: "Collaboration groups",
    environments: "Execution environments",
    settings: "Space settings",
    basicInformation: "Basic information",
    projects: "Projects",
    workspaceManagement: "Space management",
    createProject: "Create project",
    createCollaborationProject: "New collaboration project",
    firstProjectHomeTitle: "Create your first collaboration project",
    firstProjectHomeHint:
      "Use projects to organize issues, members, and agents. Once created, you can start assigning and automating work.",
    chooseProjectWorkspace: "Choose a workspace",
    chooseProjectWorkspaceHint:
      "The project cannot be moved to another collaboration workspace after creation.",
    noProjects: "No projects yet",
    noProjectsHint:
      "Create a project to organize issues in board and table views.",
    enterWorkspace: "Enter space",
    enterProject: "Enter project",
    projectCount: "Projects",
    save: "Save",
    cancel: "Cancel",
    name: "Name",
    description: "Description",
    owner: "Owner",
    personalOwner: "Personal",
    ownerHint:
      "Determines the default owner for agents and other resources created in this workspace.",
    workspaceSettingsHint:
      "Manage the workspace profile, members, and collaboration resources.",
    loadFailed: "Failed to load collaboration spaces",
    searchSpaces: "Search spaces",
    firstUseProgress: "Getting started",
    firstProjectTitle: "Create your first project",
    firstProjectHint:
      "Projects organize issues, members, and assignments. Agents and execution environments can be configured later.",
    configureAgents: "Configure agents",
    inviteMembers: "Invite members",
    workspaceResources: "Workspace resources",
    operationsOverview: "Operations overview",
    operationsHint:
      "See what is running, waiting for review, or failing across projects.",
    operatingProjects: "Project operations",
    operatingProjectsHint:
      "Projects with failures or review gates are shown first.",
    needsAttention: "Needs attention",
    attentionCount: "items need action",
    issues: "issues",
    noAttention: "No failures or review gates right now",
    running: "Running",
    waitingReview: "Awaiting review",
    failed: "Failed",
    unavailable: "Status unavailable",
    pending: "Ready",
    stable: "Healthy",
    idle: "Idle",
    updatedAt: "Last change",
    viewAll: "View all",
    collaborationSpaces: "Collaboration spaces",
    collaborationSettings: "Collaboration settings",
    manageAgents: "Manage agent resources",
    manageEnvironments: "Manage execution environments",
    expandWorkspace: "Expand workspace projects",
    collapseWorkspace: "Collapse workspace projects",
  },
} as const;

type PlatformMessages = (typeof platformMessages)[CollaborationLocale];

export type CollaborationProjectRendererWorkspaceContext =
  | CollaborationWorkspace
  | CollaborationWorkspaceNavigationContext;

export interface CollaborationProjectRendererContext {
  project: CollaborationProject;
  workspace: CollaborationProjectRendererWorkspaceContext;
}

function navigateWithin(
  host: CollaborationPlatformHostAdapter,
  patch: Partial<CollaborationPlatformLocation>,
) {
  host.navigate({ ...host.location, ...patch });
}

function workspaceAgentRecord(
  agent: CollaborationOwnedAgent,
): WorkspaceProjectAgent {
  const teamId = agent.team_id;
  if (teamId == null) {
    throw new Error("Workspace Agent is missing team_id");
  }
  return {
    ...agent,
    id: String(teamId),
    runtime: "wegent",
    status: "active",
    version: 1,
    wegentTeamId: teamId,
  };
}

function createWorkspaceAgentConfigurationApi(
  api: SharedWorkspaceApi,
  workspaceId: string,
): SharedWorkspaceApi {
  const workspaces = api.workspaces;
  if (!workspaces) return api;
  return {
    ...api,
    agents: {
      async list() {
        return (await workspaces.listAgents(workspaceId)).map(
          workspaceAgentRecord,
        );
      },
      async create(_scopeId, input) {
        const teamId = Number(input.wegentTeamId);
        if (!Number.isFinite(teamId)) {
          throw new Error("Workspace Agent is missing wegentTeamId");
        }
        return workspaceAgentRecord(
          await workspaces.addAgent(workspaceId, { teamId }),
        );
      },
      async update(_scopeId, agentId) {
        const teamId = Number(agentId);
        if (!Number.isFinite(teamId)) {
          throw new Error("Workspace Agent id must be a team id");
        }
        const current = (await workspaces.listAgents(workspaceId)).find(
          (agent) => agent.team_id === teamId,
        );
        if (!current) throw new Error("Workspace Agent was not found");
        await workspaces.removeAgent(workspaceId, teamId);
        return {
          ...workspaceAgentRecord(current),
          status: "archived",
        };
      },
    },
  };
}

function CollaborationPlatformNavigation({
  host,
  messages,
  workspaces,
  workspaceNavigationContext,
  projects,
  onCreateWorkspace,
  footer,
}: {
  host: CollaborationPlatformHostAdapter;
  messages: PlatformMessages;
  workspaces: CollaborationWorkspace[];
  workspaceNavigationContext: CollaborationWorkspaceNavigationContext | null;
  projects: CollaborationProject[];
  onCreateWorkspace(): void;
  footer?: React.ReactNode;
}) {
  const navigationWorkspaces = useMemo(
    () =>
      workspaceNavigationContext
        ? [
            ...workspaces.map((workspace) => ({ workspace, canOpen: true })),
            ...(workspaces.some(
              (workspace) => workspace.id === workspaceNavigationContext.id,
            )
              ? []
              : [{ workspace: workspaceNavigationContext, canOpen: false }]),
          ]
        : workspaces.map((workspace) => ({ workspace, canOpen: true })),
    [workspaceNavigationContext, workspaces],
  );
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<Set<string>>(
    () =>
      new Set(
        host.location.workspaceId
          ? [host.location.workspaceId]
          : navigationWorkspaces
              .slice(0, 1)
              .map(({ workspace }) => workspace.id),
      ),
  );
  const [workspacesExpanded, setWorkspacesExpanded] = useState(true);
  const [collaborationMenuOpen, setCollaborationMenuOpen] = useState(false);
  const [workspaceMenuId, setWorkspaceMenuId] = useState<string | null>(null);
  const showStorageBoundaries =
    host.capabilities.sidebarPresentation !== "context" &&
    Boolean(host.capabilities.workspaceLocations?.length);
  const collaborationMenuRef = useRef<HTMLDivElement>(null);
  const workspaceMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const workspaceId =
      host.location.workspaceId ?? navigationWorkspaces[0]?.workspace.id;
    if (!workspaceId) return;
    setExpandedWorkspaceIds((current) => {
      if (current.has(workspaceId)) return current;
      return new Set([...current, workspaceId]);
    });
  }, [host.location.workspaceId, navigationWorkspaces]);
  useEffect(() => {
    if (!collaborationMenuOpen) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!collaborationMenuRef.current?.contains(event.target as Node)) {
        setCollaborationMenuOpen(false);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setCollaborationMenuOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [collaborationMenuOpen]);
  useEffect(() => {
    if (!workspaceMenuId) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!workspaceMenuRef.current?.contains(event.target as Node)) {
        setWorkspaceMenuId(null);
      }
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setWorkspaceMenuId(null);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [workspaceMenuId]);
  const openWorkspaceHome = (workspaceId: string) =>
    host.navigate({
      platformView: "spaces",
      workspaceId,
      workspaceView: "home",
      projectId: null,
      projectView: "board",
      issueId: null,
    });
  const toggleWorkspace = (workspaceId: string) => {
    setExpandedWorkspaceIds((current) => {
      const next = new Set(current);
      if (next.has(workspaceId)) next.delete(workspaceId);
      else next.add(workspaceId);
      return next;
    });
  };
  return (
    <aside
      className={`collaboration-platform-sidebar collaboration-platform-sidebar-${host.capabilities.sidebarPresentation ?? "full"}`}
      data-testid="collaboration-platform-sidebar"
    >
      {host.capabilities.sidebarPresentation !== "context" ? (
        <div className="collaboration-platform-brand">Wegent</div>
      ) : null}
      <div className="collaboration-workspace-section-heading">
        <button
          type="button"
          className="collaboration-workspace-section-toggle"
          aria-expanded={workspacesExpanded}
          data-testid="collaboration-workspaces-section-toggle"
          onClick={() => setWorkspacesExpanded((expanded) => !expanded)}
        >
          <span>{messages.collaborationSpaces}</span>
          <ChevronRight aria-hidden="true" />
        </button>
        <div
          className="collaboration-workspace-section-actions"
          ref={collaborationMenuRef}
        >
          <button
            type="button"
            aria-label={messages.collaborationSettings}
            title={messages.collaborationSettings}
            aria-expanded={collaborationMenuOpen}
            aria-haspopup="menu"
            data-testid="collaboration-workspace-section-actions"
            onClick={() => setCollaborationMenuOpen((open) => !open)}
          >
            <Ellipsis aria-hidden="true" />
          </button>
          <button
            type="button"
            aria-label={messages.createWorkspace}
            title={messages.createWorkspace}
            data-testid="collaboration-workspace-sidebar-create"
            onClick={onCreateWorkspace}
          >
            <span data-testid="collaboration-workspace-create">
              <FolderPlus aria-hidden="true" />
            </span>
          </button>
          {collaborationMenuOpen ? (
            <div role="menu">
              {host.manageResource ? (
                <>
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="collaboration-manage-agents"
                    onClick={() => {
                      setCollaborationMenuOpen(false);
                      host.manageResource?.("agents");
                    }}
                  >
                    {messages.manageAgents}
                  </button>
                  <button
                    type="button"
                    role="menuitem"
                    data-testid="collaboration-manage-environments"
                    onClick={() => {
                      setCollaborationMenuOpen(false);
                      host.manageResource?.("environments");
                    }}
                  >
                    {messages.manageEnvironments}
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
      {workspacesExpanded ? (
        <div className="collaboration-workspace-tree">
          {navigationWorkspaces.map(
            ({ workspace: candidate, canOpen }, index) => {
              const expanded = expandedWorkspaceIds.has(candidate.id);
              const candidateProjects = projects.filter(
                (project) => project.workspace_id === candidate.id,
              );
              const workspaceActive =
                host.location.workspaceId === candidate.id &&
                !host.location.projectId;
              const canManageWorkspace =
                canOpen &&
                "access_role" in candidate &&
                (candidate.access_role === "Owner" ||
                  candidate.access_role === "Maintainer");
              const menuOpen = workspaceMenuId === candidate.id;
              const previousLocation =
                navigationWorkspaces[index - 1]?.workspace.location;
              const showStorageHeading =
                showStorageBoundaries &&
                previousLocation !== candidate.location;
              return (
                <section
                  className="collaboration-workspace-group"
                  data-testid={`collaboration-workspace-tree-${candidate.id}`}
                  key={candidate.id}
                >
                  <div
                    className={`collaboration-workspace-row${
                      workspaceActive ? " active" : ""
                    }${canManageWorkspace ? " has-actions" : ""}`}
                  >
                    {canOpen ? (
                      <button
                        type="button"
                        className="collaboration-workspace-identity"
                        data-testid={
                          host.location.workspaceId === candidate.id
                            ? "collaboration-workspace-nav-projects"
                            : `collaboration-workspace-home-${candidate.id}`
                        }
                        aria-current={workspaceActive ? "page" : undefined}
                        onClick={() => openWorkspaceHome(candidate.id)}
                      >
                        <span
                          className="collaboration-workspace-folder"
                          aria-hidden="true"
                        >
                          <FolderOpen />
                        </span>
                        <span
                          className="collaboration-workspace-title-block"
                          data-location={candidate.location}
                          data-testid={`collaboration-workspace-${candidate.id}`}
                        >
                          <span className="collaboration-workspace-title">
                            {candidate.name}
                          </span>
                          {showStorageBoundaries ? (
                            <small>
                              {candidate.location === "local"
                                ? messages.localStorage
                                : messages.cloudStorage}
                            </small>
                          ) : null}
                        </span>
                      </button>
                    ) : (
                      <div
                        className="collaboration-workspace-identity"
                        data-testid="collaboration-project-parent-workspace-context"
                      >
                        <span
                          className="collaboration-workspace-folder"
                          aria-hidden="true"
                        >
                          <FolderOpen />
                        </span>
                        <span
                          className="collaboration-workspace-title-block"
                          data-location={candidate.location}
                          data-testid={`collaboration-workspace-${candidate.id}`}
                        >
                          <span className="collaboration-workspace-title">
                            {candidate.name}
                          </span>
                          {showStorageBoundaries ? (
                            <small>
                              {candidate.location === "local"
                                ? messages.localStorage
                                : messages.cloudStorage}
                            </small>
                          ) : null}
                        </span>
                      </div>
                    )}
                    {canManageWorkspace ? (
                      <div
                        className="collaboration-workspace-actions"
                        ref={menuOpen ? workspaceMenuRef : undefined}
                      >
                        <button
                          type="button"
                          aria-label={messages.settings}
                          aria-expanded={menuOpen}
                          aria-haspopup="menu"
                          data-testid={
                            host.location.workspaceId === candidate.id
                              ? "collaboration-workspace-actions"
                              : `collaboration-workspace-actions-${candidate.id}`
                          }
                          onClick={() =>
                            setWorkspaceMenuId((current) =>
                              current === candidate.id ? null : candidate.id,
                            )
                          }
                        >
                          <Ellipsis aria-hidden="true" />
                        </button>
                        {menuOpen ? (
                          <div role="menu">
                            <button
                              type="button"
                              role="menuitem"
                              data-testid="collaboration-workspace-nav-settings"
                              onClick={() => {
                                setWorkspaceMenuId(null);
                                host.navigate({
                                  platformView: "spaces",
                                  workspaceId: candidate.id,
                                  workspaceView: "settings",
                                  projectId: null,
                                  projectView: "board",
                                  issueId: null,
                                });
                              }}
                            >
                              <Settings aria-hidden="true" />
                              {messages.settings}
                            </button>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    <button
                      type="button"
                      className="collaboration-workspace-toggle"
                      aria-expanded={expanded}
                      aria-label={
                        expanded
                          ? messages.collapseWorkspace
                          : messages.expandWorkspace
                      }
                      data-testid={`collaboration-workspace-toggle-${candidate.id}`}
                      onClick={() => toggleWorkspace(candidate.id)}
                    >
                      <ChevronRight aria-hidden="true" />
                    </button>
                    {showStorageHeading ? (
                      <span
                        className="collaboration-workspace-location-heading"
                        role="heading"
                        aria-level={2}
                      >
                        {candidate.location === "local"
                          ? messages.localSpaces
                          : messages.cloudSpaces}
                      </span>
                    ) : null}
                  </div>
                  {expanded ? (
                    <nav
                      className="collaboration-workspace-project-list"
                      aria-label={`${candidate.name} · ${messages.projects}`}
                    >
                      {candidateProjects.map((project) => (
                        <button
                          type="button"
                          className={`collaboration-workspace-project${
                            host.location.projectId === project.id
                              ? " active"
                              : ""
                          }`}
                          aria-current={
                            host.location.projectId === project.id
                              ? "page"
                              : undefined
                          }
                          title={project.name}
                          data-testid={`collaboration-workspace-project-${project.id}`}
                          key={project.id}
                          onClick={() =>
                            host.navigate({
                              platformView: "spaces",
                              workspaceId: candidate.id,
                              workspaceView: "projects",
                              projectId: project.id,
                              projectView: "board",
                              issueId: null,
                            })
                          }
                        >
                          <span>{project.name}</span>
                        </button>
                      ))}
                    </nav>
                  ) : null}
                </section>
              );
            },
          )}
        </div>
      ) : null}
      {footer ? (
        <div className="collaboration-platform-sidebar-footer">{footer}</div>
      ) : null}
    </aside>
  );
}

function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: string;
  subtitle: string;
  action?: React.ReactNode;
}) {
  return (
    <header className="collaboration-platform-page-header">
      <div>
        <h1>{title}</h1>
        <p>{subtitle}</p>
      </div>
      {action}
    </header>
  );
}

function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="collaboration-platform-empty">
      <strong>{title}</strong>
      <p>{description}</p>
      {action}
    </div>
  );
}

function ProjectCards({
  projects,
  messages,
  onOpen,
}: {
  projects: CollaborationProject[];
  messages: PlatformMessages;
  onOpen(project: CollaborationProject): void;
}) {
  if (!projects.length) {
    return (
      <EmptyState
        title={messages.noProjects}
        description={messages.noProjectsHint}
      />
    );
  }
  return (
    <div className="collaboration-project-card-grid">
      {projects.map((project) => (
        <button
          type="button"
          className="collaboration-project-card"
          data-testid={`collaboration-project-card-${project.id}`}
          key={project.id}
          onClick={() => onOpen(project)}
        >
          <span className="collaboration-project-card-mark">
            {project.project_key.slice(0, 2)}
          </span>
          <span>
            <strong>{project.name}</strong>
            <small>{project.description || project.project_key}</small>
          </span>
          <em>{messages.enterProject} →</em>
        </button>
      ))}
    </div>
  );
}

function WorkspaceHome({
  projects,
  projectIssues,
  locale,
  messages,
  onOpenProject,
  onOpenProjects,
  onOpenIssue,
}: {
  projects: CollaborationProject[];
  projectIssues: Record<string, WorkspaceProjectIssuesSnapshot>;
  locale: CollaborationLocale;
  messages: PlatformMessages;
  onOpenProject(project: CollaborationProject): void;
  onOpenProjects(): void;
  onOpenIssue(project: CollaborationProject, issue: CollaborationIssue): void;
}) {
  const snapshot = createWorkspaceOperationsSnapshot({
    projects,
    projectIssues,
  });
  const metrics = [
    {
      id: "running",
      label: messages.running,
      value: snapshot.totals.running,
      icon: Activity,
      tone: "running",
    },
    {
      id: "review",
      label: messages.waitingReview,
      value: snapshot.totals.review,
      icon: Clock3,
      tone: "review",
    },
    {
      id: "failed",
      label: messages.failed,
      value: snapshot.totals.failed,
      icon: AlertTriangle,
      tone: "failed",
    },
    {
      id: "pending",
      label: messages.pending,
      value: snapshot.totals.pending,
      icon: CircleCheck,
      tone: "pending",
    },
  ];

  return (
    <div data-testid="collaboration-workspace-home">
      <section
        className="collaboration-workspace-operation-metrics"
        aria-label={messages.operationsOverview}
      >
        {metrics.map((metric) => {
          const Icon = metric.icon;
          return (
            <div data-tone={metric.tone} key={metric.id}>
              <span>
                <Icon aria-hidden="true" />
              </span>
              <strong>{metric.value}</strong>
              <small>{metric.label}</small>
            </div>
          );
        })}
      </section>

      <div className="collaboration-workspace-operations-layout">
        <section className="collaboration-workspace-operations-projects">
          <div className="collaboration-workspace-operations-heading">
            <div>
              <h2>{messages.operatingProjects}</h2>
              <p>{messages.operatingProjectsHint}</p>
            </div>
            <button type="button" onClick={onOpenProjects}>
              {messages.viewAll}
              <ChevronRight aria-hidden="true" />
            </button>
          </div>
          <div className="collaboration-workspace-operation-table">
            {snapshot.operations.map((operation) => {
              const projectState: WorkspaceOperationState | "idle" =
                operation.unavailable
                  ? "unavailable"
                  : operation.failedCount > 0
                    ? "failed"
                    : operation.reviewCount > 0
                      ? "review"
                      : operation.runningCount > 0
                        ? "running"
                        : "idle";
              return (
                <button
                  type="button"
                  data-testid={`collaboration-workspace-operation-project-${operation.project.id}`}
                  key={operation.project.id}
                  onClick={() => onOpenProject(operation.project)}
                >
                  <span className="collaboration-project-card-mark">
                    {operation.project.project_key.slice(0, 2)}
                  </span>
                  <span className="collaboration-workspace-operation-project-copy">
                    <strong>{operation.project.name}</strong>
                    <small>
                      {operation.unavailable
                        ? messages.unavailable
                        : `${operation.issues.length} ${messages.issues}`}
                    </small>
                  </span>
                  <OperationStateBadge
                    messages={messages}
                    state={projectState}
                  />
                  {operation.unavailable ? (
                    <span className="collaboration-workspace-operation-counts">
                      <span data-tone="failed">{messages.unavailable}</span>
                    </span>
                  ) : (
                    <span className="collaboration-workspace-operation-counts">
                      <span data-tone="running">
                        {operation.runningCount} {messages.running}
                      </span>
                      <span data-tone="review">
                        {operation.reviewCount} {messages.waitingReview}
                      </span>
                      {operation.failedCount > 0 ? (
                        <span data-tone="failed">
                          {operation.failedCount} {messages.failed}
                        </span>
                      ) : null}
                    </span>
                  )}
                  <time dateTime={operation.updatedAt}>
                    {formatOperationTime(locale, operation.updatedAt)}
                  </time>
                  <ChevronRight aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </section>

        <section className="collaboration-workspace-attention">
          <div className="collaboration-workspace-operations-heading">
            <div>
              <h2>{messages.needsAttention}</h2>
              <p>
                {snapshot.totals.failed +
                  snapshot.totals.review +
                  snapshot.totals.unavailable}{" "}
                {messages.attentionCount}
              </p>
            </div>
          </div>
          {snapshot.unavailableProjects.length > 0 ||
          snapshot.attentionItems.length > 0 ? (
            <div className="collaboration-workspace-attention-list">
              {snapshot.unavailableProjects.map((operation) => (
                <button
                  type="button"
                  data-testid={`collaboration-workspace-unavailable-${operation.project.id}`}
                  key={`unavailable:${operation.project.id}`}
                  onClick={() => onOpenProject(operation.project)}
                >
                  <OperationStateBadge
                    messages={messages}
                    state="unavailable"
                  />
                  <strong>{operation.project.name}</strong>
                  <span>{messages.unavailable}</span>
                  <time dateTime={operation.updatedAt}>
                    {formatOperationTime(locale, operation.updatedAt)}
                  </time>
                </button>
              ))}
              {snapshot.attentionItems.map(({ issue, project }) => {
                const state = workspaceIssueOperationState(issue);
                return (
                  <button
                    type="button"
                    data-testid={`collaboration-workspace-attention-${issue.id}`}
                    key={issue.id}
                    onClick={() => onOpenIssue(project, issue)}
                  >
                    <OperationStateBadge messages={messages} state={state} />
                    <strong>{issue.title}</strong>
                    <span>{project.name}</span>
                    <time dateTime={issue.updated_at}>
                      {formatOperationTime(locale, issue.updated_at)}
                    </time>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="collaboration-workspace-attention-empty">
              <CircleCheck aria-hidden="true" />
              <strong>{messages.stable}</strong>
              <span>{messages.noAttention}</span>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function OperationStateBadge({
  state,
  messages,
}: {
  state: WorkspaceOperationState | "idle";
  messages: PlatformMessages;
}) {
  const label =
    state === "failed"
      ? messages.failed
      : state === "unavailable"
        ? messages.unavailable
        : state === "review"
          ? messages.waitingReview
          : state === "running"
            ? messages.running
            : state === "pending"
              ? messages.pending
              : state === "completed"
                ? messages.stable
                : messages.idle;
  return (
    <span className="collaboration-workspace-operation-state" data-tone={state}>
      <i aria-hidden="true" />
      {label}
    </span>
  );
}

function formatOperationTime(
  locale: CollaborationLocale,
  value: string,
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function workItemOwner(item: WorkspaceMyWorkItem, messages: PlatformMessages) {
  if (item.assignee_team_id != null) {
    return {
      name: item.assignee_team_name || messages.group,
      kind: messages.group,
      icon: UsersRound,
    };
  }
  if (item.assignee_agent_id) {
    return {
      name: item.assignee_agent_name || messages.agent,
      kind: messages.agent,
      icon: Bot,
    };
  }
  if (item.assignee_user_id != null) {
    return {
      name: item.assignee_name || messages.human,
      kind: messages.human,
      icon: UserRound,
    };
  }
  return {
    name: messages.unassigned,
    kind: "",
    icon: UserRound,
  };
}

function workItemStep(
  item: WorkspaceMyWorkItem,
  messages: PlatformMessages,
): string {
  const nodes = item.workflow?.nodes ?? [];
  const activeIndex = nodes.findIndex((node) =>
    [
      "assigned",
      "awaiting_approval",
      "failed",
      "in_progress",
      "running",
    ].includes(node.status),
  );
  if (activeIndex >= 0) {
    return `${activeIndex + 1}/${nodes.length} ${nodes[activeIndex].name}`;
  }
  if (item.status === "in_review") return messages.waitingReview;
  if (item.execution_state) return item.execution_state.replace(/_/g, " ");
  return item.status.replace(/_/g, " ");
}

function workItemStatus(item: WorkspaceMyWorkItem, messages: PlatformMessages) {
  const state = workspaceIssueOperationState(item);
  return {
    state,
    label:
      state === "failed"
        ? messages.failed
        : state === "review"
          ? messages.waitingReview
          : state === "running"
            ? messages.running
            : state === "completed"
              ? messages.stable
              : messages.pending,
  };
}

function WorkItemRow({
  item,
  locale,
  messages,
  onOpen,
}: {
  item: WorkspaceMyWorkItem;
  locale: CollaborationLocale;
  messages: PlatformMessages;
  onOpen(item: WorkspaceMyWorkItem): void;
}) {
  const owner = workItemOwner(item, messages);
  const status = workItemStatus(item, messages);
  const OwnerIcon = owner.icon;
  return (
    <button
      type="button"
      className="collaboration-home-work-row"
      data-testid={`collaboration-home-work-${item.id}`}
      onClick={() => onOpen(item)}
    >
      <span className="collaboration-home-work-issue">
        <strong>
          #{item.sequence_number} {item.title}
        </strong>
        <small>
          {item.project_key} · {item.project_name}
        </small>
      </span>
      <span className="collaboration-home-work-owner">
        <i>
          <OwnerIcon aria-hidden="true" />
        </i>
        <span>
          <strong>{owner.name}</strong>
          <small>{owner.kind}</small>
        </span>
      </span>
      <span className="collaboration-home-work-step">
        <strong>{workItemStep(item, messages)}</strong>
        <small>{item.workflow?.orchestration_status ?? item.status}</small>
      </span>
      <OperationStateBadge messages={messages} state={status.state} />
      <time dateTime={item.updated_at}>
        {formatOperationTime(locale, item.updated_at)}
      </time>
      <ChevronRight aria-hidden="true" />
    </button>
  );
}

function CollaborationHome({
  items,
  projects,
  locale,
  messages,
  onOpenItem,
  onOpenProject,
}: {
  items: WorkspaceMyWorkItem[];
  projects: CollaborationProject[];
  locale: CollaborationLocale;
  messages: PlatformMessages;
  onOpenItem(item: WorkspaceMyWorkItem): void;
  onOpenProject(project: CollaborationProject): void;
}) {
  const attention = items
    .filter((item) => {
      const state = workspaceIssueOperationState(item);
      return item.is_unread || state === "failed" || state === "review";
    })
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
    .slice(0, 4);
  const active = items
    .filter((item) => {
      const state = workspaceIssueOperationState(item);
      return state !== "completed" && state !== "pending";
    })
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
    .slice(0, 8);
  const recentProjects = [...projects]
    .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
    .slice(0, 3);

  return (
    <div className="collaboration-home">
      {attention.length ? (
        <section className="collaboration-home-section">
          <div className="collaboration-home-section-heading">
            <h2>{messages.needsYourAction}</h2>
            <span>{attention.length}</span>
          </div>
          <div className="collaboration-home-attention-list">
            {attention.map((item) => {
              const status = workItemStatus(item, messages);
              const Icon =
                status.state === "failed"
                  ? AlertTriangle
                  : status.state === "review"
                    ? Clock3
                    : Inbox;
              return (
                <button
                  type="button"
                  data-tone={status.state}
                  data-testid={`collaboration-home-attention-${item.id}`}
                  key={item.id}
                  onClick={() => onOpenItem(item)}
                >
                  <i>
                    <Icon aria-hidden="true" />
                  </i>
                  <span>
                    <strong>{item.title}</strong>
                    <small>
                      {item.project_name} · {status.label}
                    </small>
                  </span>
                  <p>{item.execution_error || workItemStep(item, messages)}</p>
                  <time dateTime={item.updated_at}>
                    {formatOperationTime(locale, item.updated_at)}
                  </time>
                  <em>
                    {status.state === "review"
                      ? messages.reviewNow
                      : messages.viewItem}
                  </em>
                  <ChevronRight aria-hidden="true" />
                </button>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="collaboration-home-section">
        <div className="collaboration-home-section-heading">
          <h2>{messages.activeWork}</h2>
          {active.length ? <span>{active.length}</span> : null}
        </div>
        {active.length ? (
          <div className="collaboration-home-work-list">
            <div className="collaboration-home-work-header">
              <span>Issue / {messages.projects}</span>
              <span>{messages.currentOwner}</span>
              <span>{messages.currentStep}</span>
              <span>{messages.runStatus}</span>
              <span>{messages.lastUpdated}</span>
            </div>
            {active.map((item) => (
              <WorkItemRow
                item={item}
                locale={locale}
                messages={messages}
                key={item.id}
                onOpen={onOpenItem}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            title={messages.noActiveWork}
            description={messages.noActiveWorkHint}
          />
        )}
      </section>

      {recentProjects.length ? (
        <section className="collaboration-home-section">
          <div className="collaboration-home-section-heading">
            <h2>{messages.recentProjects}</h2>
          </div>
          <div className="collaboration-home-recent-projects">
            {recentProjects.map((project) => (
              <button
                type="button"
                data-testid={`collaboration-project-card-${project.id}`}
                key={project.id}
                onClick={() => onOpenProject(project)}
              >
                <span className="collaboration-project-card-mark">
                  {project.project_key.slice(0, 2)}
                </span>
                <span>
                  <strong>{project.name}</strong>
                  <small>{project.project_key}</small>
                </span>
                <ChevronRight aria-hidden="true" />
              </button>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}

function FirstProjectStarter({
  messages,
  onCreate,
}: {
  messages: PlatformMessages;
  onCreate(): void;
}) {
  return (
    <section
      className="collaboration-first-project-starter"
      data-testid="collaboration-first-project-starter"
    >
      <span className="collaboration-project-card-mark">01</span>
      <div>
        <h2>{messages.firstProjectHomeTitle}</h2>
        <p>{messages.firstProjectHomeHint}</p>
      </div>
      <button
        type="button"
        className="collaboration-primary-button"
        data-testid="collaboration-first-project-create"
        onClick={onCreate}
      >
        {messages.createCollaborationProject}
      </button>
    </section>
  );
}

function WorkItemsPage({
  title,
  subtitle,
  empty,
  items,
  locale,
  messages,
  onOpenItem,
}: {
  title: string;
  subtitle: string;
  empty: string;
  items: WorkspaceMyWorkItem[];
  locale: CollaborationLocale;
  messages: PlatformMessages;
  onOpenItem(item: WorkspaceMyWorkItem): void;
}) {
  return (
    <div className="collaboration-platform-page">
      <PageHeader title={title} subtitle={subtitle} />
      {items.length ? (
        <div className="collaboration-home-work-list">
          {items.map((item) => (
            <WorkItemRow
              item={item}
              locale={locale}
              messages={messages}
              key={item.id}
              onOpen={onOpenItem}
            />
          ))}
        </div>
      ) : (
        <EmptyState title={empty} description={messages.workspaceHint} />
      )}
    </div>
  );
}

function RunCenter({
  entries,
  locale,
  messages,
}: {
  entries: Array<{
    project: CollaborationProject;
    execution: CollaborationExecution;
  }>;
  locale: CollaborationLocale;
  messages: PlatformMessages;
}) {
  return (
    <div className="collaboration-platform-page">
      <PageHeader
        title={messages.runCenter}
        subtitle={messages.operationsHint}
      />
      {entries.length ? (
        <div className="collaboration-run-center-list">
          {entries.map(({ project, execution }) => (
            <article key={`${project.id}-${execution.id}`}>
              <span>
                <strong>{execution.task_title}</strong>
                <small>
                  {project.name} · #{execution.id}
                </small>
              </span>
              <span>{execution.executor_type}</span>
              <OperationStateBadge
                messages={messages}
                state={
                  execution.status === "failed"
                    ? "failed"
                    : execution.completed_at
                      ? "completed"
                      : "running"
                }
              />
              <time dateTime={execution.updated_at}>
                {formatOperationTime(locale, execution.updated_at)}
              </time>
            </article>
          ))}
        </div>
      ) : (
        <EmptyState
          title={messages.noRuns}
          description={messages.operationsHint}
        />
      )}
    </div>
  );
}

function WorkspaceSettings({
  workspace,
  messages,
  onSave,
}: {
  workspace: CollaborationWorkspace;
  messages: PlatformMessages;
  onSave(input: {
    version: number;
    name: string;
    description: string;
  }): Promise<void>;
}) {
  const [name, setName] = useState(workspace.name);
  const [description, setDescription] = useState(workspace.description);
  const [saving, setSaving] = useState(false);
  return (
    <section className="collaboration-platform-panel collaboration-workspace-settings">
      <h2>{messages.settings}</h2>
      <p>{messages.workspaceSettingsHint}</p>
      <label>
        {messages.name}
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label>
        {messages.description}
        <textarea
          value={description}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <button
        type="button"
        className="collaboration-primary-button"
        data-testid="collaboration-workspace-settings-save"
        disabled={saving || !name.trim()}
        onClick={() => {
          setSaving(true);
          void onSave({
            version: workspace.version,
            name: name.trim(),
            description: description.trim(),
          }).finally(() => setSaving(false));
        }}
      >
        {messages.save}
      </button>
    </section>
  );
}

export function CollaborationPlatformApp({
  api,
  host,
  locale = "zh-CN",
  onCreateTask,
  onReady,
  renderProject,
  renderShell,
  sidebarFooter,
}: {
  api: SharedWorkspaceApi;
  host: CollaborationPlatformHostAdapter;
  locale?: CollaborationLocale;
  onCreateTask?(
    project: CollaborationProject,
    issue: CollaborationIssue,
    workflowStep?: string,
  ): void;
  onReady?(): void;
  renderProject?(context: CollaborationProjectRendererContext): React.ReactNode;
  renderShell?(shell: {
    main: React.ReactNode;
    sidebar: React.ReactNode;
  }): React.ReactNode;
  sidebarFooter?: React.ReactNode;
}) {
  const messages = platformMessages[locale];
  const translate = createCollaborationTranslator(locale);
  const { state, commands } = useCollaborationPlatformController({
    api,
    location: host.location,
    loadFailedMessage: messages.loadFailed,
  });
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectWorkspaceId, setProjectWorkspaceId] = useState<string | null>(
    null,
  );
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const projectWorkspace =
    projectWorkspaceId == null
      ? null
      : (state.workspaces.find(
          (workspace) => workspace.id === projectWorkspaceId,
        ) ??
        (state.workspace?.id === projectWorkspaceId ? state.workspace : null));
  const projectWorkspaceOwnerLabel =
    projectWorkspace == null
      ? null
      : (host.workspaceOwnerOptions?.find(
          (option) => option.namespace === projectWorkspace.namespace,
        )?.label ??
        (projectWorkspace.namespace === "default"
          ? messages.personalOwner
          : projectWorkspace.namespace));
  const workspaceLocations = host.capabilities.workspaceLocations ?? ["cloud"];
  const canCreateCloudWorkspace = workspaceLocations.includes("cloud");
  useEffect(() => {
    if (!state.loading && !state.error) onReady?.();
  }, [onReady, state.error, state.loading]);
  const scopedApi = useMemo<SharedWorkspaceApi>(() => {
    if (!host.location.workspaceId) return api;
    const workspaceId = host.location.workspaceId;
    const projectId = host.location.projectId;
    const hasFullWorkspaceAccess = state.workspace?.id === workspaceId;
    return {
      ...api,
      projects: {
        ...api.projects,
        list: async () => {
          const projects = await (hasFullWorkspaceAccess
            ? api.projects.list(workspaceId)
            : api.projects.list());
          if (hasFullWorkspaceAccess || !projectId) return projects;
          return projects.filter((project) => project.id === projectId);
        },
        create: (input) => api.projects.create({ ...input, workspaceId }),
      },
    };
  }, [
    api,
    host.location.projectId,
    host.location.workspaceId,
    state.workspace,
  ]);
  const workspaceAgentConfigurationApi = useMemo(
    () =>
      host.location.workspaceId
        ? createWorkspaceAgentConfigurationApi(api, host.location.workspaceId)
        : api,
    [api, host.location.workspaceId],
  );
  const projectResourceAgents = useMemo(() => {
    const agents = new Map<number, CollaborationOwnedAgent>();
    for (const agent of [...state.resources.agents, ...state.agents]) {
      if (agent.team_id != null) agents.set(agent.team_id, agent);
    }
    return [...agents.values()];
  }, [state.agents, state.resources.agents]);
  const projectResourceEnvironments = useMemo(() => {
    const environments = new Map<number, CollaborationExecutionEnvironment>();
    for (const environment of [
      ...state.resources.execution_environments,
      ...state.executionEnvironments,
    ]) {
      if (environment.device_id != null) {
        environments.set(environment.device_id, environment);
      }
    }
    return [...environments.values()];
  }, [state.executionEnvironments, state.resources.execution_environments]);

  const openProject = (project: CollaborationProject) =>
    navigateWithin(host, {
      workspaceId: project.workspace_id,
      workspaceView: "projects",
      projectId: project.id,
      projectView: "board",
      issueId: null,
    });
  const startProjectCreation = () => {
    if (state.workspace) {
      setProjectWorkspaceId(state.workspace.id);
      setProjectDialogOpen(true);
      return;
    }
    if (state.workspaces.length === 1) {
      setProjectWorkspaceId(state.workspaces[0].id);
      setProjectDialogOpen(true);
      return;
    }
    setWorkspacePickerOpen(true);
  };
  const openMyWorkItem = (item: WorkspaceMyWorkItem) => {
    const project = state.projects.find(
      (candidate) => candidate.id === item.cloud_project_id,
    );
    if (!project?.workspace_id) return;
    navigateWithin(host, {
      workspaceId: project.workspace_id,
      workspaceView: "projects",
      projectId: project.id,
      projectView: "board",
      issueId: item.id,
    });
  };
  let content: React.ReactNode;
  if (state.loading) {
    content = (
      <div className="collaboration-loading">
        {translate("common.loading", "正在加载…")}
      </div>
    );
  } else if (state.error) {
    content = (
      <div className="collaboration-alert" role="alert">
        {state.error}
      </div>
    );
  } else if (
    host.location.projectId &&
    (state.workspace || state.workspaceNavigationContext)
  ) {
    const workspaceContext =
      state.workspace ?? state.workspaceNavigationContext;
    const selectedProject =
      state.projects.find(
        (project) => String(project.id) === host.location.projectId,
      ) ?? null;
    content =
      selectedProject && renderProject && workspaceContext ? (
        renderProject({ project: selectedProject, workspace: workspaceContext })
      ) : (
        <CollaborationApp
          api={scopedApi}
          locale={locale}
          showProjectBack={false}
          host={{
            capabilities: {
              automation: host.capabilities.automation,
              dingtalkAitable: host.capabilities.dingtalkAitable,
              projectLocation: host.capabilities.projectLocation,
            },
            location: {
              projectId: host.location.projectId,
              issueId: host.location.issueId,
              view: host.location.projectView,
            },
            navigate: (location) =>
              navigateWithin(host, {
                projectId: location.projectId,
                issueId: location.issueId,
                projectView: location.view,
                workspaceView: "projects",
              }),
            notify: host.notify,
            openExternal: host.openExternal,
            manageResource: host.manageResource,
            projectAgentConfiguration: host.projectAgentConfiguration,
            projectAgentResourceContext: {
              name: workspaceContext!.name,
              namespace:
                "namespace" in workspaceContext!
                  ? workspaceContext!.namespace
                  : "default",
            },
          }}
          onCreateTask={onCreateTask}
        />
      );
  } else if (!state.workspace) {
    const rootView = host.location.rootView ?? "home";
    const inboxItems = state.myWork.filter((item) => {
      const operation = workspaceIssueOperationState(item);
      return item.is_unread || operation === "failed" || operation === "review";
    });
    content =
      rootView === "runs" ? (
        <RunCenter
          entries={state.executions}
          locale={locale}
          messages={messages}
        />
      ) : rootView === "my-work" ? (
        <WorkItemsPage
          title={messages.myWork}
          subtitle={messages.workspaceHint}
          empty={messages.noActiveWork}
          items={state.myWork}
          locale={locale}
          messages={messages}
          onOpenItem={openMyWorkItem}
        />
      ) : rootView === "inbox" ? (
        <WorkItemsPage
          title={messages.inbox}
          subtitle={messages.needsYourAction}
          empty={messages.noInboxItems}
          items={inboxItems}
          locale={locale}
          messages={messages}
          onOpenItem={openMyWorkItem}
        />
      ) : (
        <div className="collaboration-platform-page collaboration-home-page">
          <PageHeader
            title={messages.collaborationHome}
            subtitle={messages.collaborationHomeHint}
            action={
              state.workspaces.length > 0 && state.projects.length > 0 ? (
                <button
                  type="button"
                  className="collaboration-secondary-button"
                  data-testid="collaboration-home-create-project"
                  onClick={startProjectCreation}
                >
                  ＋ {messages.createCollaborationProject}
                </button>
              ) : undefined
            }
          />
          {!state.workspaces.length ? (
            <EmptyState
              title={messages.noSpaces}
              description={messages.noSpacesHint}
              action={
                canCreateCloudWorkspace ? (
                  <button
                    type="button"
                    className="collaboration-primary-button"
                    onClick={() => setWorkspaceDialogOpen(true)}
                  >
                    {messages.createWorkspace}
                  </button>
                ) : null
              }
            />
          ) : !state.projects.length ? (
            <FirstProjectStarter
              messages={messages}
              onCreate={startProjectCreation}
            />
          ) : (
            <CollaborationHome
              items={state.myWork}
              projects={state.projects}
              locale={locale}
              messages={messages}
              onOpenItem={openMyWorkItem}
              onOpenProject={openProject}
            />
          )}
        </div>
      );
  } else {
    const workspace = state.workspace;
    const canManageWorkspace =
      workspace.access_role === "Owner" ||
      workspace.access_role === "Maintainer";
    const requestedWorkspaceSettingsView =
      host.location.workspaceView === "settings" ||
      host.location.workspaceView === "members" ||
      host.location.workspaceView === "agents" ||
      host.location.workspaceView === "collaboration-participants" ||
      host.location.workspaceView === "collaboration-groups" ||
      host.location.workspaceView === "execution-environments"
        ? host.location.workspaceView
        : null;
    const workspaceSettingsView =
      requestedWorkspaceSettingsView === "members" ||
      requestedWorkspaceSettingsView === "agents" ||
      requestedWorkspaceSettingsView === "collaboration-groups"
        ? "collaboration-participants"
        : requestedWorkspaceSettingsView;
    const initialWorkspaceParticipantTab =
      requestedWorkspaceSettingsView === "members"
        ? "members"
        : requestedWorkspaceSettingsView === "collaboration-groups"
          ? "groups"
          : "agents";
    const createProjectAction = (
      <button
        type="button"
        className="collaboration-primary-button"
        data-testid="collaboration-workspace-project-create"
        onClick={startProjectCreation}
      >
        ＋ {messages.createProject}
      </button>
    );
    if (workspaceSettingsView) {
      const workspaceSettingsSections = [
        ...(canManageWorkspace
          ? [
              {
                id: "settings",
                label: messages.basicInformation,
                testId: "collaboration-workspace-nav-settings",
                content: (
                  <div className="collaboration-platform-page collaboration-workspace-settings-page">
                    <PageHeader
                      title={messages.basicInformation}
                      subtitle={`${messages.settings} · ${workspace.name}`}
                    />
                    <WorkspaceSettings
                      workspace={workspace}
                      messages={messages}
                      onSave={async (input) => {
                        await commands.updateWorkspace(input);
                        host.notify?.(messages.save, "success");
                      }}
                    />
                  </div>
                ),
              },
            ]
          : []),
        {
          id: "collaboration-participants",
          label: messages.collaborationParticipants,
          testId: "collaboration-workspace-nav-participants",
          content: (
            <div className="collaboration-platform-page collaboration-workspace-settings-page">
              <PageHeader
                title={messages.collaborationParticipants}
                subtitle={messages.collaborationParticipantsHint}
              />
              <CollaborationParticipantsTabs
                agentsContent={
                  <ProjectAgentConfiguration
                    api={workspaceAgentConfigurationApi}
                    canManage={
                      workspace.access_role === "Owner" ||
                      workspace.access_role === "Maintainer" ||
                      workspace.access_role === "Developer"
                    }
                    host={host.projectAgentConfiguration}
                    project={{
                      id: workspace.id,
                      name: workspace.name,
                      namespace: workspace.namespace,
                      workspace_id: null,
                      project_store:
                        workspace.location === "local" ? "local" : "backend",
                    }}
                    onError={() => host.notify?.(messages.loadFailed, "error")}
                    scope="workspace"
                    translate={translate}
                  />
                }
                agentsLabel={messages.agents}
                ariaLabel={messages.collaborationParticipants}
                groupsContent={
                  <WorkspaceCollaborationGroupsConfiguration
                    workspace={workspace}
                    groups={state.collaborationGroups}
                    members={state.members}
                    agents={state.agents}
                    locale={locale}
                    commands={commands}
                  />
                }
                groupsLabel={messages.collaborationGroups}
                initialTab={initialWorkspaceParticipantTab}
                membersContent={
                  <WorkspaceMembersConfiguration
                    workspace={workspace}
                    members={state.members}
                    locale={locale}
                    commands={commands}
                  />
                }
                membersLabel={messages.members}
                testIdPrefix="collaboration-workspace-participants"
              />
            </div>
          ),
        },
        {
          id: "execution-environments",
          label: messages.environments,
          testId: "collaboration-workspace-nav-execution-environments",
          content: (
            <ProjectExecutionEnvironments
              api={api}
              workspace={workspace}
              translate={translate}
            />
          ),
        },
      ];
      content = (
        <ProjectSettingsShell
          ariaLabel={`${messages.settings} · ${workspace.name}`}
          testId="workspace-settings-shell"
          selectedSectionId={workspaceSettingsView}
          onSectionChange={(sectionId) =>
            navigateWithin(host, {
              workspaceView: sectionId as CollaborationWorkspaceView,
              projectId: null,
              issueId: null,
            })
          }
          sections={workspaceSettingsSections}
        />
      );
    } else {
      content = (
        <div className="collaboration-platform-page">
          <PageHeader
            title={
              host.location.workspaceView === "projects"
                ? messages.allProjects
                : workspace.name
            }
            subtitle={
              host.location.workspaceView === "projects"
                ? messages.noProjectsHint
                : messages.operationsHint
            }
            action={
              <div className="collaboration-platform-page-actions">
                {host.location.workspaceView === "home" &&
                canManageWorkspace ? (
                  <button
                    type="button"
                    className="collaboration-platform-secondary-button"
                    data-testid="collaboration-workspace-home-settings"
                    onClick={() =>
                      navigateWithin(host, {
                        workspaceView: "settings",
                        projectId: null,
                        issueId: null,
                      })
                    }
                  >
                    <Settings aria-hidden="true" />
                    {messages.settings}
                  </button>
                ) : null}
                {createProjectAction}
              </div>
            }
          />
          {host.location.workspaceView === "home" ? (
            state.projects.length === 0 ? (
              <section
                className="collaboration-workspace-starter"
                data-testid="collaboration-workspace-starter"
              >
                <small>{messages.firstUseProgress}</small>
                <h2>{messages.firstProjectTitle}</h2>
                <p>{messages.firstProjectHint}</p>
                <div>
                  <button
                    type="button"
                    className="collaboration-primary-button"
                    data-testid="collaboration-workspace-starter-create-project"
                    onClick={startProjectCreation}
                  >
                    {messages.createProject}
                  </button>
                  <button
                    type="button"
                    data-testid="collaboration-workspace-starter-configure-agents"
                    onClick={() =>
                      navigateWithin(host, {
                        workspaceView: "collaboration-participants",
                        projectId: null,
                        issueId: null,
                      })
                    }
                  >
                    {messages.configureAgents}
                  </button>
                  <button
                    type="button"
                    data-testid="collaboration-workspace-starter-invite-members"
                    onClick={() =>
                      navigateWithin(host, {
                        workspaceView: "members",
                        projectId: null,
                        issueId: null,
                      })
                    }
                  >
                    {messages.inviteMembers}
                  </button>
                </div>
              </section>
            ) : (
              <WorkspaceHome
                projects={state.projects}
                projectIssues={state.projectIssues}
                locale={locale}
                messages={messages}
                onOpenProject={openProject}
                onOpenProjects={() =>
                  navigateWithin(host, {
                    workspaceView: "projects",
                    projectId: null,
                    issueId: null,
                  })
                }
                onOpenIssue={(project, issue) =>
                  navigateWithin(host, {
                    workspaceView: "projects",
                    projectId: project.id,
                    projectView: "board",
                    issueId: issue.id,
                  })
                }
              />
            )
          ) : null}
          {host.location.workspaceView === "projects" ? (
            <section className="collaboration-platform-panel">
              <h2>{messages.projects}</h2>
              <ProjectCards
                projects={state.projects}
                messages={messages}
                onOpen={openProject}
              />
            </section>
          ) : null}
        </div>
      );
    }
  }

  const sidebar = (
    <CollaborationPlatformNavigation
      host={host}
      messages={messages}
      workspaces={state.workspaces}
      workspaceNavigationContext={state.workspaceNavigationContext}
      projects={state.navigationProjects}
      onCreateWorkspace={() => setWorkspaceDialogOpen(true)}
      footer={sidebarFooter}
    />
  );
  const main = <main className="collaboration-platform-main">{content}</main>;

  return (
    <section
      className={renderShell ? undefined : "collaboration-platform-app"}
      data-testid="collaboration-platform-root"
      style={renderShell ? { height: "100%", minHeight: 0 } : undefined}
    >
      {renderShell ? (
        renderShell({ main, sidebar })
      ) : (
        <>
          {sidebar}
          {main}
        </>
      )}
      {workspaceDialogOpen ? (
        <WorkspaceCreateDialog
          messages={messages}
          ownerOptions={host.workspaceOwnerOptions}
          onClose={() => setWorkspaceDialogOpen(false)}
          onCreate={async (input) => {
            const workspace = await commands.createWorkspace(input);
            setWorkspaceDialogOpen(false);
            navigateWithin(host, {
              workspaceId: workspace.id,
              workspaceView: "home",
              projectId: null,
              issueId: null,
            });
          }}
        />
      ) : null}
      {workspacePickerOpen ? (
        <WorkspaceProjectPicker
          messages={messages}
          workspaces={state.workspaces}
          onClose={() => setWorkspacePickerOpen(false)}
          onSelect={(workspaceId) => {
            setWorkspacePickerOpen(false);
            setProjectWorkspaceId(workspaceId);
            setProjectDialogOpen(true);
          }}
        />
      ) : null}
      {projectDialogOpen && projectWorkspaceId ? (
        <ProjectCreateDialog
          targets={[
            {
              location: host.capabilities.projectLocation ?? "cloud",
              create: (input) =>
                state.workspace?.id === projectWorkspaceId
                  ? commands.createProject(input)
                  : api.projects.create({
                      ...input,
                      workspaceId: projectWorkspaceId,
                    }),
            },
          ]}
          defaultLocation={host.capabilities.projectLocation ?? "cloud"}
          allowDingTalkAITable={host.capabilities.dingtalkAitable}
          labels={projectCreateLabels[locale]}
          workspaceContext={
            projectWorkspace && projectWorkspaceOwnerLabel
              ? {
                  name: projectWorkspace.name,
                  owner: `${messages.owner}${
                    locale === "zh-CN" ? "：" : ": "
                  }${projectWorkspaceOwnerLabel}`,
                }
              : undefined
          }
          resourceSetup={
            state.workspace?.id === projectWorkspaceId
              ? {
                  workspaceName: state.workspace.name,
                  members: state.members,
                  agents: projectResourceAgents,
                  executionEnvironments: projectResourceEnvironments,
                  configure: async (project, selection) => {
                    const existingMembers = await api.members.list(project.id);
                    const existingMemberIds = new Set(
                      existingMembers.map((member) => member.user_id),
                    );
                    const selectedAgents = projectResourceAgents.filter(
                      (agent) =>
                        agent.team_id != null &&
                        selection.agentTeamIds.includes(agent.team_id),
                    );
                    await Promise.all([
                      ...selection.memberUserIds
                        .filter((userId) => !existingMemberIds.has(userId))
                        .map((userId) =>
                          api.members.add(project.id, userId, "Developer"),
                        ),
                      ...selection.executionEnvironmentDeviceIds.map(
                        (deviceId) =>
                          api.projects.addExecutionEnvironment(
                            project.id,
                            deviceId,
                          ),
                      ),
                    ]);
                    await Promise.all(
                      selectedAgents.map((agent) =>
                        api.agents.create(
                          project.id,
                          createWegentProjectAgentInput(agent),
                        ),
                      ),
                    );
                  },
                }
              : undefined
          }
          testIds={{
            name: "collaboration-project-name-input",
            description: "collaboration-project-description-input",
            confirm: "collaboration-project-create-confirm",
          }}
          onClose={() => {
            setProjectDialogOpen(false);
            setProjectWorkspaceId(null);
          }}
          onCreated={(project) => {
            setProjectDialogOpen(false);
            setProjectWorkspaceId(null);
            openProject(project);
          }}
        />
      ) : null}
    </section>
  );
}

function WorkspaceProjectPicker({
  messages,
  workspaces,
  onClose,
  onSelect,
}: {
  messages: PlatformMessages;
  workspaces: CollaborationWorkspace[];
  onClose(): void;
  onSelect(workspaceId: string): void;
}) {
  return (
    <div className="collaboration-dialog-backdrop">
      <section
        className="collaboration-dialog collaboration-workspace-picker"
        role="dialog"
        aria-modal="true"
        aria-label={messages.chooseProjectWorkspace}
      >
        <header>
          <div>
            <h2>{messages.chooseProjectWorkspace}</h2>
            <p>{messages.chooseProjectWorkspaceHint}</p>
          </div>
          <button type="button" onClick={onClose} aria-label={messages.cancel}>
            <X aria-hidden="true" />
          </button>
        </header>
        <div>
          {workspaces.map((workspace) => (
            <button
              type="button"
              data-testid={`collaboration-project-workspace-${workspace.id}`}
              key={workspace.id}
              onClick={() => onSelect(workspace.id)}
            >
              <span className="collaboration-project-card-mark">
                {workspace.name.slice(0, 2)}
              </span>
              <span>
                <strong>{workspace.name}</strong>
                <small>
                  {workspace.project_count} {messages.projectCount}
                </small>
              </span>
              <ChevronRight aria-hidden="true" />
            </button>
          ))}
        </div>
      </section>
    </div>
  );
}

function WorkspaceCreateDialog({
  messages,
  ownerOptions,
  onClose,
  onCreate,
}: {
  messages: PlatformMessages;
  ownerOptions?: Array<{ label: string; namespace: string }>;
  onClose(): void;
  onCreate(input: {
    name: string;
    description?: string;
    namespace?: string;
  }): Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [namespace, setNamespace] = useState("default");
  const [saving, setSaving] = useState(false);
  const effectiveOwnerOptions = ownerOptions ?? [
    { label: messages.personalOwner, namespace: "default" },
  ];
  return (
    <div className="collaboration-dialog-backdrop">
      <section
        className="collaboration-dialog collaboration-workspace-create-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={messages.createWorkspace}
      >
        <h2>{messages.createWorkspace}</h2>
        <p className="collaboration-workspace-storage-notice">
          {messages.cloudStorageNotice}
        </p>
        <label>
          {messages.name}
          <input
            autoFocus
            data-testid="collaboration-workspace-name-input"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
        </label>
        <label>
          {messages.description}
          <textarea
            data-testid="collaboration-workspace-description-input"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label>
          {messages.owner}
          <select
            data-testid="collaboration-workspace-owner-select"
            onChange={(event) => setNamespace(event.target.value)}
            value={namespace}
          >
            {effectiveOwnerOptions.map((option) => (
              <option key={option.namespace} value={option.namespace}>
                {option.label}
              </option>
            ))}
          </select>
          <small>{messages.ownerHint}</small>
        </label>
        <footer>
          <button type="button" onClick={onClose}>
            {messages.cancel}
          </button>
          <button
            type="button"
            className="collaboration-primary-button"
            data-testid="collaboration-workspace-create-confirm"
            disabled={saving || !name.trim()}
            onClick={() => {
              setSaving(true);
              void onCreate({
                name: name.trim(),
                description: description.trim() || undefined,
                namespace,
              }).finally(() => setSaving(false));
            }}
          >
            {messages.createWorkspace}
          </button>
        </footer>
      </section>
    </div>
  );
}
