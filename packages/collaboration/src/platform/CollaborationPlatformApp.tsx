// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from "react";
import {
  Bot,
  Boxes,
  BriefcaseBusiness,
  ChevronRight,
  LayoutGrid,
  MonitorCog,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react";

import { CollaborationApp } from "../CollaborationApp";
import {
  createCollaborationTranslator,
  type CollaborationLocale,
} from "../i18n";
import type { AutomationUiHost } from "../automation-ui";
import type {
  SharedWorkspaceApi,
  WorkspaceMyWorkItem,
} from "../ports/SharedWorkspaceApi";
import { ProjectCreateDialog, projectCreateLabels } from "../project-create";
import type {
  CollaborationExecutionEnvironment,
  CollaborationIssue,
  CollaborationMember,
  CollaborationOwnedAgent,
  CollaborationProject,
  CollaborationWorkspace,
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
  WorkspaceAgentsConfiguration,
  WorkspaceExecutionEnvironmentsConfiguration,
  WorkspaceMembersConfiguration,
} from "./WorkspaceResourceConfiguration";

const platformMessages = {
  "zh-CN": {
    allSpaces: "所有空间",
    resources: "资源",
    myWork: "我的工作",
    myWorkHint: "跨空间查看分配给我和我正在参与的 Issue。",
    noWork: "还没有待处理工作",
    noWorkHint: "当 Issue 分配给你或你主动参与后，会显示在这里。",
    running: "执行中",
    pending: "待处理",
    resourcesHint: "管理我拥有的智能体和执行环境，并授权给协作空间使用。",
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
    projects: "项目",
    workspaceManagement: "空间管理",
    createProject: "创建项目",
    noProjects: "还没有项目",
    noProjectsHint: "创建项目后即可使用看板和表格组织 Issue。",
    enterWorkspace: "进入空间",
    enterProject: "进入项目",
    projectCount: "项目",
    memberCount: "成员",
    agentCount: "智能体",
    environmentCount: "执行环境",
    save: "保存",
    cancel: "取消",
    name: "名称",
    description: "描述",
    workspaceSettingsHint: "管理空间基本信息。成员和资源使用独立页面管理。",
    personalAgents: "我的智能体",
    personalEnvironments: "我的执行环境",
    noResources: "还没有资源",
    available: "可用",
    unavailable: "不可用",
    online: "在线",
    offline: "离线",
    loadFailed: "加载协作空间失败",
    searchSpaces: "搜索空间",
    firstUseProgress: "开始协作",
    firstProjectTitle: "创建第一个项目",
    firstProjectHint:
      "项目负责组织 Issue、成员和分配方式；智能体与执行环境可以稍后配置。",
    configureAgents: "配置智能体",
    inviteMembers: "邀请成员",
    workspaceResources: "空间资源",
    viewAll: "查看全部",
  },
  en: {
    allSpaces: "All spaces",
    resources: "Resources",
    myWork: "My work",
    myWorkHint: "See issues assigned to you or involving you across spaces.",
    noWork: "No work yet",
    noWorkHint:
      "Issues appear here after they are assigned to you or you join them.",
    running: "Running",
    pending: "Pending",
    resourcesHint:
      "Manage agents and execution environments you own and share them with workspaces.",
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
    projects: "Projects",
    workspaceManagement: "Space management",
    createProject: "Create project",
    noProjects: "No projects yet",
    noProjectsHint:
      "Create a project to organize issues in board and table views.",
    enterWorkspace: "Enter space",
    enterProject: "Enter project",
    projectCount: "Projects",
    memberCount: "Members",
    agentCount: "Agents",
    environmentCount: "Execution environments",
    save: "Save",
    cancel: "Cancel",
    name: "Name",
    description: "Description",
    workspaceSettingsHint:
      "Manage basic space information. Members and resources have dedicated pages.",
    personalAgents: "My agents",
    personalEnvironments: "My execution environments",
    noResources: "No resources yet",
    available: "Available",
    unavailable: "Unavailable",
    online: "Online",
    offline: "Offline",
    loadFailed: "Failed to load collaboration spaces",
    searchSpaces: "Search spaces",
    firstUseProgress: "Getting started",
    firstProjectTitle: "Create your first project",
    firstProjectHint:
      "Projects organize issues, members, and assignments. Agents and execution environments can be configured later.",
    configureAgents: "Configure agents",
    inviteMembers: "Invite members",
    workspaceResources: "Workspace resources",
    viewAll: "View all",
  },
} as const;

type PlatformMessages = (typeof platformMessages)[CollaborationLocale];

function navigateWithin(
  host: CollaborationPlatformHostAdapter,
  patch: Partial<CollaborationPlatformLocation>,
) {
  host.navigate({ ...host.location, ...patch });
}

function CollaborationPlatformNavigation({
  host,
  messages,
  workspace,
  workspaces,
  projects,
  footer,
}: {
  host: CollaborationPlatformHostAdapter;
  messages: PlatformMessages;
  workspace: CollaborationWorkspace | null;
  workspaces: CollaborationWorkspace[];
  projects: CollaborationProject[];
  footer?: React.ReactNode;
}) {
  const canManageWorkspace =
    workspace?.access_role === "Owner" ||
    workspace?.access_role === "Maintainer";
  const managementNav: Array<{
    id: CollaborationWorkspaceView;
    label: string;
    icon: LucideIcon;
    count?: number;
  }> = [
    {
      id: "members",
      label: messages.members,
      icon: Users,
      count: workspace?.member_count,
    },
    {
      id: "agents",
      label: messages.agents,
      icon: Bot,
      count: workspace?.agent_count,
    },
    {
      id: "execution-environments",
      label: messages.environments,
      icon: MonitorCog,
      count: workspace?.execution_environment_count,
    },
  ];
  if (canManageWorkspace) {
    managementNav.push({
      id: "settings",
      label: messages.settings,
      icon: Settings,
    });
  }
  const managementActive =
    !host.location.projectId &&
    managementNav.some((item) => item.id === host.location.workspaceView);
  const [managementOpen, setManagementOpen] = useState(managementActive);
  useEffect(() => {
    if (managementActive) setManagementOpen(true);
  }, [managementActive]);
  const openWorkspaceHome = () =>
    navigateWithin(host, {
      workspaceView: "home",
      projectId: null,
      issueId: null,
    });
  const openAllProjects = () =>
    navigateWithin(host, {
      workspaceView: "projects",
      projectId: null,
      issueId: null,
    });
  const renderManagementNav = () => (
    <nav className="collaboration-platform-management-nav">
      {managementNav.map((item) => {
        const Icon = item.icon;
        return (
          <button
            type="button"
            className={
              !host.location.projectId &&
              host.location.workspaceView === item.id
                ? "active"
                : ""
            }
            aria-current={
              !host.location.projectId &&
              host.location.workspaceView === item.id
                ? "page"
                : undefined
            }
            title={item.label}
            data-testid={`collaboration-workspace-nav-${item.id}`}
            key={item.id}
            onClick={() =>
              navigateWithin(host, {
                workspaceView: item.id,
                projectId: null,
                issueId: null,
              })
            }
          >
            <Icon aria-hidden="true" />
            <span className="collaboration-platform-nav-text">
              {item.label}
            </span>
            {item.count !== undefined ? (
              <span className="collaboration-platform-nav-count">
                {item.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </nav>
  );
  return (
    <aside
      className={`collaboration-platform-sidebar collaboration-platform-sidebar-${host.capabilities.sidebarPresentation ?? "full"}`}
      data-testid="collaboration-platform-sidebar"
    >
      {!workspace ? (
        <>
          {host.capabilities.sidebarPresentation !== "context" ? (
            <div className="collaboration-platform-brand">Wegent</div>
          ) : null}
          <nav>
            <button
              type="button"
              className={
                host.location.platformView === "spaces" ? "active" : ""
              }
              aria-current={
                host.location.platformView === "spaces" ? "page" : undefined
              }
              data-testid="collaboration-nav-all-spaces"
              onClick={() =>
                host.navigate({
                  platformView: "spaces",
                  workspaceId: null,
                  workspaceView: "home",
                  projectId: null,
                  projectView: "board",
                  issueId: null,
                })
              }
            >
              <LayoutGrid aria-hidden="true" />
              {messages.allSpaces}
            </button>
            <button
              type="button"
              className={
                host.location.platformView === "my-work" ? "active" : ""
              }
              aria-current={
                host.location.platformView === "my-work" ? "page" : undefined
              }
              data-testid="collaboration-nav-my-work"
              onClick={() =>
                host.navigate({
                  platformView: "my-work",
                  workspaceId: null,
                  workspaceView: "home",
                  projectId: null,
                  projectView: "board",
                  issueId: null,
                })
              }
            >
              <BriefcaseBusiness aria-hidden="true" />
              {messages.myWork}
            </button>
            <button
              type="button"
              className={
                host.location.platformView === "resources" ? "active" : ""
              }
              aria-current={
                host.location.platformView === "resources" ? "page" : undefined
              }
              data-testid="collaboration-nav-resources"
              onClick={() =>
                host.navigate({
                  platformView: "resources",
                  workspaceId: null,
                  workspaceView: "home",
                  projectId: null,
                  projectView: "board",
                  issueId: null,
                })
              }
            >
              <Boxes aria-hidden="true" />
              {messages.resources}
            </button>
          </nav>
        </>
      ) : (
        <>
          <div className="collaboration-workspace-context-header">
            <button
              type="button"
              className="collaboration-workspace-home"
              aria-label={messages.workspaceHome}
              title={messages.workspaceHome}
              data-testid="collaboration-workspace-nav-home"
              onClick={openWorkspaceHome}
            >
              <span>{workspace.name.slice(0, 1).toUpperCase()}</span>
            </button>
            <label className="collaboration-workspace-identity">
              <span>
                <select
                  aria-label={messages.currentWorkspace}
                  data-testid="collaboration-workspace-switcher"
                  value={workspace.id}
                  onChange={(event) =>
                    host.navigate({
                      platformView: "spaces",
                      workspaceId: event.target.value,
                      workspaceView: "home",
                      projectId: null,
                      projectView: "board",
                      issueId: null,
                    })
                  }
                >
                  {workspaces.map((candidate) => (
                    <option key={candidate.id} value={candidate.id}>
                      {candidate.name}
                    </option>
                  ))}
                </select>
                <small>
                  {workspace.location === "local"
                    ? messages.localStorage
                    : messages.cloudStorage}
                </small>
              </span>
            </label>
          </div>
          <div className="collaboration-platform-projects">
            <div className="collaboration-platform-projects-heading">
              <span>{messages.projects}</span>
              <button
                type="button"
                data-testid="collaboration-workspace-nav-projects"
                onClick={openAllProjects}
              >
                {messages.viewAll}
              </button>
            </div>
            <nav>
              {projects.map((project) => (
                <button
                  type="button"
                  className={
                    host.location.projectId === project.id ? "active" : ""
                  }
                  aria-current={
                    host.location.projectId === project.id ? "page" : undefined
                  }
                  title={project.name}
                  data-testid={`collaboration-workspace-project-${project.id}`}
                  key={project.id}
                  onClick={() =>
                    navigateWithin(host, {
                      projectId: project.id,
                      projectView: "board",
                      issueId: null,
                    })
                  }
                >
                  <span className="collaboration-platform-project-mark">
                    {project.project_key.slice(0, 2)}
                  </span>
                  <span className="collaboration-platform-nav-text">
                    {project.name}
                  </span>
                </button>
              ))}
            </nav>
          </div>
          <div className="collaboration-platform-management">
            <button
              type="button"
              className={managementActive ? "active" : ""}
              aria-expanded={managementOpen}
              data-testid="collaboration-workspace-management-toggle"
              onClick={() => setManagementOpen((current) => !current)}
            >
              <ChevronRight aria-hidden="true" />
              <span>{messages.workspaceManagement}</span>
            </button>
            {managementOpen ? renderManagementNav() : null}
          </div>
        </>
      )}
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
      <span className="collaboration-platform-empty-icon">◇</span>
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

function WorkspaceCards({
  workspaces,
  messages,
  separateByLocation,
  onOpen,
}: {
  workspaces: CollaborationWorkspace[];
  messages: PlatformMessages;
  separateByLocation: boolean;
  onOpen(workspace: CollaborationWorkspace): void;
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
            <div className="collaboration-workspace-card-grid">
              {group.items.map((workspace) => (
                <button
                  type="button"
                  className="collaboration-workspace-card"
                  data-location={workspace.location}
                  data-testid={`collaboration-workspace-${workspace.id}`}
                  key={workspace.id}
                  onClick={() => onOpen(workspace)}
                >
                  <div className="collaboration-workspace-card-heading">
                    <span>{workspace.name.slice(0, 1).toUpperCase()}</span>
                    <small className="collaboration-workspace-storage">
                      {workspace.location === "local"
                        ? messages.localStorage
                        : messages.cloudStorage}
                    </small>
                  </div>
                  <strong>{workspace.name}</strong>
                  <p>{workspace.description}</p>
                  <small className="collaboration-workspace-counts">
                    {workspace.member_count} {messages.memberCount} ·{" "}
                    {workspace.agent_count} {messages.agentCount} ·{" "}
                    {workspace.execution_environment_count}{" "}
                    {messages.environmentCount} · {workspace.project_count}{" "}
                    {messages.projectCount}
                  </small>
                  <em>{messages.enterWorkspace} →</em>
                </button>
              ))}
            </div>
          </section>
        ) : null,
      )}
    </div>
  );
}

function WorkspaceResourceList({
  title,
  kind,
  members,
  agents,
  environments,
  messages,
}: {
  title: string;
  kind: "members" | "agents" | "environments";
  members: CollaborationMember[];
  agents: CollaborationOwnedAgent[];
  environments: CollaborationExecutionEnvironment[];
  messages: PlatformMessages;
}) {
  const rows =
    kind === "members"
      ? members.map((member) => ({
          id: String(member.user_id),
          title: member.user_name,
          detail: member.email ?? member.role,
          state: member.role,
        }))
      : kind === "agents"
        ? agents.map((agent) => ({
            id: agent.id,
            title: agent.name,
            detail: agent.owner_name,
            state:
              agent.status === "available"
                ? messages.available
                : messages.unavailable,
          }))
        : environments.map((environment) => ({
            id: environment.id,
            title: environment.name,
            detail: environment.owner_name,
            state:
              environment.status === "online"
                ? messages.online
                : messages.offline,
          }));
  return (
    <section className="collaboration-platform-panel">
      <h2>{title}</h2>
      {rows.length ? (
        <div className="collaboration-resource-list">
          {rows.map((row) => (
            <div key={row.id}>
              <span className="collaboration-resource-avatar">
                {row.title.slice(0, 1).toUpperCase()}
              </span>
              <span>
                <strong>{row.title}</strong>
                <small>{row.detail}</small>
              </span>
              <em>{row.state}</em>
            </div>
          ))}
        </div>
      ) : (
        <EmptyState title={messages.noResources} description="" />
      )}
    </section>
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
  renderProject?(context: {
    project: CollaborationProject;
    workspace: CollaborationWorkspace;
  }): React.ReactNode;
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
    return {
      ...api,
      projects: {
        ...api.projects,
        list: () => api.projects.list(workspaceId),
        create: (input) => api.projects.create({ ...input, workspaceId }),
      },
    };
  }, [api, host.location.workspaceId]);

  const openProject = (project: CollaborationProject) =>
    navigateWithin(host, {
      workspaceView: "projects",
      projectId: project.id,
      projectView: "board",
      issueId: null,
    });
  const openMyWorkIssue = async (issue: WorkspaceMyWorkItem) => {
    try {
      const project = await api.projects.get?.(String(issue.cloud_project_id));
      if (!project?.workspace_id) {
        host.notify?.(messages.loadFailed, "error");
        return;
      }
      navigateWithin(host, {
        workspaceId: project.workspace_id,
        workspaceView: "projects",
        projectId: String(issue.cloud_project_id),
        projectView: "board",
        issueId: issue.id,
      });
    } catch {
      host.notify?.(messages.loadFailed, "error");
    }
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
  } else if (host.location.projectId && state.workspace) {
    const selectedProject =
      state.projects.find(
        (project) => String(project.id) === host.location.projectId,
      ) ?? null;
    content =
      selectedProject && renderProject ? (
        renderProject({ project: selectedProject, workspace: state.workspace })
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
  } else if (!state.workspace && host.location.platformView === "my-work") {
    content = (
      <div className="collaboration-platform-page">
        <PageHeader title={messages.myWork} subtitle={messages.myWorkHint} />
        {state.myWork.length ? (
          <section className="collaboration-platform-panel">
            <div className="collaboration-my-work-list">
              {state.myWork.map((issue) => (
                <button
                  type="button"
                  data-testid={`collaboration-my-work-${issue.id}`}
                  key={issue.id}
                  onClick={() => void openMyWorkIssue(issue)}
                >
                  <span>
                    <strong>{issue.title}</strong>
                    <small>
                      {issue.project_name} · {issue.status}
                    </small>
                  </span>
                  <em>
                    {issue.has_active_task
                      ? messages.running
                      : messages.pending}
                  </em>
                </button>
              ))}
            </div>
          </section>
        ) : (
          <EmptyState
            title={messages.noWork}
            description={messages.noWorkHint}
          />
        )}
      </div>
    );
  } else if (!state.workspace && host.location.platformView === "resources") {
    content = (
      <div className="collaboration-platform-page">
        <PageHeader
          title={messages.resources}
          subtitle={messages.resourcesHint}
        />
        <div className="collaboration-platform-resource-grid">
          <WorkspaceResourceList
            title={messages.personalAgents}
            kind="agents"
            members={[]}
            agents={state.resources.agents}
            environments={[]}
            messages={messages}
          />
          <WorkspaceResourceList
            title={messages.personalEnvironments}
            kind="environments"
            members={[]}
            agents={[]}
            environments={state.resources.execution_environments}
            messages={messages}
          />
        </div>
      </div>
    );
  } else if (!state.workspace) {
    const workspaces = filterCollaborationWorkspaces(
      sortCollaborationWorkspaces(state.workspaces),
      workspaceQuery,
    );
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
          <WorkspaceCards
            workspaces={workspaces}
            messages={messages}
            separateByLocation={showsLocalAndCloud}
            onOpen={(workspace) =>
              navigateWithin(host, {
                workspaceId: workspace.id,
                workspaceView: "home",
                projectId: null,
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
    if (host.location.workspaceView === "settings" && canManageWorkspace) {
      content = (
        <div className="collaboration-platform-page">
          <PageHeader title={messages.settings} subtitle={workspace.name} />
          <WorkspaceSettings
            workspace={workspace}
            messages={messages}
            onSave={async (input) => {
              await commands.updateWorkspace(input);
              host.notify?.(messages.save, "success");
            }}
          />
        </div>
      );
    } else if (host.location.workspaceView === "members") {
      content = (
        <div className="collaboration-platform-page">
          <PageHeader title={messages.members} subtitle={workspace.name} />
          <WorkspaceMembersConfiguration
            workspace={workspace}
            members={state.members}
            locale={locale}
            commands={commands}
          />
        </div>
      );
    } else if (host.location.workspaceView === "agents") {
      content = (
        <div className="collaboration-platform-page">
          <PageHeader title={messages.agents} subtitle={workspace.name} />
          <WorkspaceAgentsConfiguration
            workspace={workspace}
            agents={state.agents}
            resources={state.resources}
            locale={locale}
            commands={commands}
          />
        </div>
      );
    } else if (host.location.workspaceView === "execution-environments") {
      content = (
        <div className="collaboration-platform-page">
          <PageHeader title={messages.environments} subtitle={workspace.name} />
          <WorkspaceExecutionEnvironmentsConfiguration
            workspace={workspace}
            environments={state.executionEnvironments}
            resources={state.resources}
            locale={locale}
            commands={commands}
          />
        </div>
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
                : workspace.description || messages.workspaceHint
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
              <div className="collaboration-workspace-stats">
                <div>
                  <strong>{workspace.project_count}</strong>
                  <span>{messages.projectCount}</span>
                </div>
                <div>
                  <strong>{workspace.member_count}</strong>
                  <span>{messages.memberCount}</span>
                </div>
                <div>
                  <strong>{workspace.agent_count}</strong>
                  <span>{messages.agentCount}</span>
                </div>
                <div>
                  <strong>{workspace.execution_environment_count}</strong>
                  <span>{messages.environmentCount}</span>
                </div>
              </div>
            )
          ) : null}
          <section className="collaboration-platform-panel">
            <h2>{messages.projects}</h2>
            <ProjectCards
              projects={state.projects}
              messages={messages}
              onOpen={openProject}
            />
          </section>
          {host.location.workspaceView === "home" &&
          state.projects.length > 0 ? (
            <section className="collaboration-platform-panel">
              <div className="collaboration-platform-panel-heading">
                <h2>{messages.workspaceResources}</h2>
                <button
                  type="button"
                  onClick={() =>
                    navigateWithin(host, {
                      workspaceView: "agents",
                      projectId: null,
                      issueId: null,
                    })
                  }
                >
                  {messages.viewAll}
                </button>
              </div>
              <div className="collaboration-workspace-resource-summary">
                <button
                  type="button"
                  onClick={() =>
                    navigateWithin(host, {
                      workspaceView: "members",
                      projectId: null,
                      issueId: null,
                    })
                  }
                >
                  <strong>{messages.members}</strong>
                  <span>{workspace.member_count}</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    navigateWithin(host, {
                      workspaceView: "agents",
                      projectId: null,
                      issueId: null,
                    })
                  }
                >
                  <strong>{messages.agents}</strong>
                  <span>{workspace.agent_count}</span>
                </button>
                <button
                  type="button"
                  onClick={() =>
                    navigateWithin(host, {
                      workspaceView: "execution-environments",
                      projectId: null,
                      issueId: null,
                    })
                  }
                >
                  <strong>{messages.environments}</strong>
                  <span>{workspace.execution_environment_count}</span>
                </button>
              </div>
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
      workspace={state.workspace}
      workspaces={state.workspaces}
      projects={state.projects}
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
