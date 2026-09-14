// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  CircleCheck,
  ChevronRight,
  Clock3,
  Ellipsis,
  FolderPlus,
  FolderOpen,
  Settings,
} from "lucide-react";

import { CollaborationApp } from "../CollaborationApp";
import {
  createCollaborationTranslator,
  type CollaborationLocale,
} from "../i18n";
import type { AutomationUiHost } from "../automation-ui";
import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
import { createWegentProjectAgentInput } from "../project-agent-config";
import { ProjectCreateDialog, projectCreateLabels } from "../project-create";
import { ProjectSettingsShell } from "../project-manage";
import type {
  CollaborationExecutionEnvironment,
  CollaborationIssue,
  CollaborationOwnedAgent,
  CollaborationProject,
  CollaborationWorkspace,
  CollaborationWorkspaceNavigationContext,
} from "../types";
import {
  filterCollaborationWorkspaces,
  sortCollaborationWorkspaces,
} from "./model";
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
} from "./workspaceOperations";
import {
  WorkspaceAgentsConfiguration,
  WorkspaceExecutionEnvironmentsConfiguration,
  WorkspaceMembersConfiguration,
} from "./WorkspaceResourceConfiguration";

const platformMessages = {
  "zh-CN": {
    allSpaces: "所有空间",
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
    environments: "执行环境",
    settings: "空间设置",
    basicInformation: "基本信息",
    projects: "项目",
    workspaceManagement: "空间管理",
    createProject: "创建项目",
    noProjects: "还没有项目",
    noProjectsHint: "创建项目后即可使用看板和表格组织 Issue。",
    enterWorkspace: "进入空间",
    enterProject: "进入项目",
    projectCount: "项目",
    save: "保存",
    cancel: "取消",
    name: "名称",
    description: "描述",
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
    environments: "Execution environments",
    settings: "Space settings",
    basicInformation: "Basic information",
    projects: "Projects",
    workspaceManagement: "Space management",
    createProject: "Create project",
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
            <FolderPlus aria-hidden="true" />
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
          {navigationWorkspaces.map(({ workspace: candidate, canOpen }) => {
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
                      <span className="collaboration-workspace-title">
                        {candidate.name}
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
                      <span className="collaboration-workspace-title">
                        {candidate.name}
                      </span>
                    </div>
                  )}
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
          })}
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
  messages,
  onOpenProject,
  onOpenProjects,
  onOpenIssue,
}: {
  projects: CollaborationProject[];
  projectIssues: Record<string, CollaborationIssue[]>;
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
                operation.failedCount > 0
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
                      {operation.issues.length} {messages.issues}
                    </small>
                  </span>
                  <OperationStateBadge
                    messages={messages}
                    state={projectState}
                  />
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
                  <time dateTime={operation.updatedAt}>
                    {formatOperationTime(operation.updatedAt)}
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
                {snapshot.totals.failed + snapshot.totals.review}{" "}
                {messages.attentionCount}
              </p>
            </div>
          </div>
          {snapshot.attentionItems.length > 0 ? (
            <div className="collaboration-workspace-attention-list">
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
                      {formatOperationTime(issue.updated_at)}
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

function formatOperationTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function WorkspaceProjectList({
  workspaces,
  projects,
  messages,
  separateByLocation,
  onOpenWorkspace,
  onOpenProject,
}: {
  workspaces: CollaborationWorkspace[];
  projects: CollaborationProject[];
  messages: PlatformMessages;
  separateByLocation: boolean;
  onOpenWorkspace(workspace: CollaborationWorkspace): void;
  onOpenProject(
    workspace: CollaborationWorkspace,
    project: CollaborationProject,
  ): void;
}) {
  const groups = separateByLocation
    ? ([
        {
          location: "local" as const,
          title: messages.localSpaces,
          items: workspaces.filter(
            (workspace) => workspace.location === "local",
          ),
        },
        {
          location: "cloud" as const,
          title: messages.cloudSpaces,
          items: workspaces.filter(
            (workspace) => workspace.location === "cloud",
          ),
        },
      ] as const)
    : ([
        {
          location: "cloud" as const,
          title: "",
          items: workspaces,
        },
      ] as const);

  return (
    <div className="collaboration-workspace-groups">
      {groups.map((group) =>
        group.items.length ? (
          <section
            className="collaboration-workspace-group"
            data-location={group.location}
            key={group.location}
          >
            {group.title ? <h2>{group.title}</h2> : null}
            <div className="collaboration-space-project-list">
              {group.items.map((workspace) => {
                const workspaceProjects = projects.filter(
                  (project) => project.workspace_id === workspace.id,
                );
                return (
                  <section
                    className="collaboration-space-project-group"
                    data-location={workspace.location}
                    key={workspace.id}
                  >
                    <button
                      type="button"
                      className="collaboration-space-project-heading"
                      data-location={workspace.location}
                      data-testid={`collaboration-workspace-${workspace.id}`}
                      onClick={() => onOpenWorkspace(workspace)}
                    >
                      <span className="collaboration-space-project-mark">
                        {workspace.name.slice(0, 1).toUpperCase()}
                      </span>
                      <span className="collaboration-space-project-copy">
                        <strong>{workspace.name}</strong>
                        <small>
                          {workspace.location === "local"
                            ? messages.localStorage
                            : messages.cloudStorage}
                        </small>
                      </span>
                      <span className="collaboration-space-project-count">
                        {workspaceProjects.length} {messages.projectCount}
                      </span>
                      <span aria-hidden="true">›</span>
                    </button>
                    {workspaceProjects.length ? (
                      <div className="collaboration-space-project-rows">
                        {workspaceProjects.map((project) => (
                          <button
                            type="button"
                            className="collaboration-space-project-row"
                            data-testid={`collaboration-project-card-${project.id}`}
                            key={project.id}
                            onClick={() => onOpenProject(workspace, project)}
                          >
                            <span className="collaboration-platform-project-mark">
                              {project.project_key.slice(0, 2)}
                            </span>
                            <span>
                              <strong>{project.name}</strong>
                              <small>
                                {project.description || project.project_key}
                              </small>
                            </span>
                            <span aria-hidden="true">›</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <p className="collaboration-space-project-empty">
                        {messages.noProjects}
                      </p>
                    )}
                  </section>
                );
              })}
            </div>
          </section>
        ) : null,
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
  automationUiHost,
  onCreateTask,
  onReady,
  renderProject,
  renderShell,
  sidebarFooter,
}: {
  api: SharedWorkspaceApi;
  host: CollaborationPlatformHostAdapter;
  locale?: CollaborationLocale;
  automationUiHost?: AutomationUiHost;
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
  const [workspaceQuery, setWorkspaceQuery] = useState("");
  const workspaceLocations = host.capabilities.workspaceLocations ?? ["cloud"];
  const showsLocalAndCloud =
    workspaceLocations.includes("local") &&
    workspaceLocations.includes("cloud");
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
      workspaceView: "projects",
      projectId: project.id,
      projectView: "board",
      issueId: null,
    });
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
          automationUiHost={automationUiHost}
          showProjectBack={false}
          host={{
            capabilities: {
              automation: host.capabilities.automation,
              dingtalkAitable: host.capabilities.dingtalkAitable,
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
          }}
          onCreateTask={onCreateTask}
        />
      );
  } else if (!state.workspace) {
    const sortedWorkspaces = sortCollaborationWorkspaces(state.workspaces);
    const directlyMatchedWorkspaceIds = new Set(
      filterCollaborationWorkspaces(sortedWorkspaces, workspaceQuery).map(
        (workspace) => workspace.id,
      ),
    );
    const normalizedWorkspaceQuery = workspaceQuery.trim().toLowerCase();
    const workspaces = normalizedWorkspaceQuery
      ? sortedWorkspaces.filter(
          (workspace) =>
            directlyMatchedWorkspaceIds.has(workspace.id) ||
            state.projects.some(
              (project) =>
                project.workspace_id === workspace.id &&
                (project.name
                  .toLowerCase()
                  .includes(normalizedWorkspaceQuery) ||
                  project.description
                    .toLowerCase()
                    .includes(normalizedWorkspaceQuery) ||
                  project.project_key
                    .toLowerCase()
                    .includes(normalizedWorkspaceQuery)),
            ),
        )
      : sortedWorkspaces;
    content = (
      <div className="collaboration-platform-page">
        <PageHeader
          title={messages.allSpaces}
          subtitle={messages.workspaceHint}
          action={
            canCreateCloudWorkspace ? (
              <button
                type="button"
                className="collaboration-primary-button"
                data-testid="collaboration-workspace-create"
                onClick={() => setWorkspaceDialogOpen(true)}
              >
                ＋ {messages.createWorkspace}
              </button>
            ) : null
          }
        />
        {!canCreateCloudWorkspace ? (
          <div
            className="collaboration-platform-notice"
            data-testid="collaboration-local-only-notice"
          >
            {messages.localOnlyHint}
          </div>
        ) : null}
        <label className="collaboration-platform-search">
          <span>⌕</span>
          <input
            aria-label={messages.searchSpaces}
            placeholder={messages.searchSpaces}
            value={workspaceQuery}
            onChange={(event) => setWorkspaceQuery(event.target.value)}
          />
        </label>
        {workspaces.length ? (
          <WorkspaceProjectList
            workspaces={workspaces}
            projects={state.projects}
            messages={messages}
            separateByLocation={showsLocalAndCloud}
            onOpenWorkspace={(workspace) =>
              navigateWithin(host, {
                workspaceId: workspace.id,
                workspaceView: "home",
                projectId: null,
                issueId: null,
              })
            }
            onOpenProject={(workspace, project) =>
              navigateWithin(host, {
                workspaceId: workspace.id,
                workspaceView: "projects",
                projectId: String(project.id),
                projectView: "board",
                issueId: null,
              })
            }
          />
        ) : (
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
              ) : undefined
            }
          />
        )}
      </div>
    );
  } else {
    const workspace = state.workspace;
    const canManageWorkspace =
      workspace.access_role === "Owner" ||
      workspace.access_role === "Maintainer";
    const workspaceSettingsView =
      host.location.workspaceView === "settings" ||
      host.location.workspaceView === "members" ||
      host.location.workspaceView === "agents" ||
      host.location.workspaceView === "execution-environments"
        ? host.location.workspaceView
        : null;
    const createProjectAction = (
      <button
        type="button"
        className="collaboration-primary-button"
        data-testid="collaboration-workspace-project-create"
        onClick={() => setProjectDialogOpen(true)}
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
                  <div className="collaboration-platform-page">
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
          id: "members",
          label: messages.members,
          testId: "collaboration-workspace-nav-members",
          content: (
            <div className="collaboration-platform-page">
              <PageHeader
                title={messages.members}
                subtitle={`${messages.settings} · ${workspace.name}`}
              />
              <WorkspaceMembersConfiguration
                workspace={workspace}
                members={state.members}
                locale={locale}
                commands={commands}
              />
            </div>
          ),
        },
        {
          id: "agents",
          label: messages.agents,
          testId: "collaboration-workspace-nav-agents",
          content: (
            <div className="collaboration-platform-page">
              <PageHeader
                title={messages.agents}
                subtitle={`${messages.settings} · ${workspace.name}`}
              />
              <WorkspaceAgentsConfiguration
                workspace={workspace}
                agents={state.agents}
                resources={state.resources}
                locale={locale}
                commands={commands}
              />
            </div>
          ),
        },
        {
          id: "execution-environments",
          label: messages.environments,
          testId: "collaboration-workspace-nav-execution-environments",
          content: (
            <div className="collaboration-platform-page">
              <PageHeader
                title={messages.environments}
                subtitle={`${messages.settings} · ${workspace.name}`}
              />
              <WorkspaceExecutionEnvironmentsConfiguration
                workspace={workspace}
                environments={state.executionEnvironments}
                resources={state.resources}
                locale={locale}
                commands={commands}
              />
            </div>
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
            action={createProjectAction}
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
                    onClick={() => setProjectDialogOpen(true)}
                  >
                    {messages.createProject}
                  </button>
                  <button
                    type="button"
                    data-testid="collaboration-workspace-starter-configure-agents"
                    onClick={() =>
                      navigateWithin(host, {
                        workspaceView: "agents",
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
      {projectDialogOpen && state.workspace ? (
        <ProjectCreateDialog
          targets={[
            {
              location: host.capabilities.projectLocation ?? "cloud",
              create: commands.createProject,
            },
          ]}
          defaultLocation={host.capabilities.projectLocation ?? "cloud"}
          allowDingTalkAITable={host.capabilities.dingtalkAitable}
          labels={projectCreateLabels[locale]}
          resourceSetup={{
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
                ...selection.executionEnvironmentDeviceIds.map((deviceId) =>
                  api.projects.addExecutionEnvironment(project.id, deviceId),
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
          }}
          testIds={{
            name: "collaboration-project-name-input",
            description: "collaboration-project-description-input",
            confirm: "collaboration-project-create-confirm",
          }}
          onClose={() => setProjectDialogOpen(false)}
          onCreated={(project) => {
            setProjectDialogOpen(false);
            openProject(project);
          }}
        />
      ) : null}
    </section>
  );
}

function WorkspaceCreateDialog({
  messages,
  onClose,
  onCreate,
}: {
  messages: PlatformMessages;
  onClose(): void;
  onCreate(input: { name: string; description?: string }): Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [saving, setSaving] = useState(false);
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
