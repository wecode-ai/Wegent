// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from "react";

import { CollaborationApp } from "../CollaborationApp";
import {
  createCollaborationTranslator,
  type CollaborationLocale,
} from "../i18n";
import type { AutomationUiHost } from "../automation-ui";
import type { SharedWorkspaceApi } from "../ports/SharedWorkspaceApi";
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
    resourcesHint: "管理我拥有的智能体和执行环境，并授权给协作空间使用。",
    workspaceHint: "空间是成员、项目、智能体和执行环境的协作边界。",
    createWorkspace: "创建空间",
    joinWorkspace: "加入空间",
    noSpaces: "还没有协作空间",
    noSpacesHint: "先创建空间，再在空间中组织成员、项目和 AI 资源。",
    workspaceHome: "空间首页",
    allProjects: "全部项目",
    members: "成员",
    agents: "智能体",
    environments: "执行环境",
    settings: "空间设置",
    backToSpaces: "返回所有空间",
    projects: "项目",
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
  },
  en: {
    allSpaces: "All spaces",
    resources: "Resources",
    resourcesHint:
      "Manage agents and execution environments you own and share them with workspaces.",
    workspaceHint:
      "A workspace is the collaboration boundary for members, projects, agents, and execution environments.",
    createWorkspace: "Create space",
    joinWorkspace: "Join space",
    noSpaces: "No collaboration spaces yet",
    noSpacesHint:
      "Create a space, then organize members, projects, and AI resources inside it.",
    workspaceHome: "Space home",
    allProjects: "All projects",
    members: "Members",
    agents: "Agents",
    environments: "Execution environments",
    settings: "Space settings",
    backToSpaces: "Back to all spaces",
    projects: "Projects",
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
  projects,
}: {
  host: CollaborationPlatformHostAdapter;
  messages: PlatformMessages;
  workspace: CollaborationWorkspace | null;
  projects: CollaborationProject[];
}) {
  const workspaceNav: Array<{
    id: CollaborationWorkspaceView;
    label: string;
  }> = [
    { id: "home", label: messages.workspaceHome },
    { id: "projects", label: messages.allProjects },
    { id: "members", label: messages.members },
    { id: "agents", label: messages.agents },
    { id: "execution-environments", label: messages.environments },
    { id: "settings", label: messages.settings },
  ];
  return (
    <aside
      className="collaboration-platform-sidebar"
      data-testid="collaboration-platform-sidebar"
    >
      {!workspace ? (
        <>
          <div className="collaboration-platform-brand">Wegent</div>
          <nav>
            <button
              type="button"
              className={
                host.location.platformView === "spaces" ? "active" : ""
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
              <span>▦</span>
              {messages.allSpaces}
            </button>
            <button
              type="button"
              className={
                host.location.platformView === "resources" ? "active" : ""
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
              <span>◇</span>
              {messages.resources}
            </button>
          </nav>
        </>
      ) : (
        <>
          <button
            type="button"
            className="collaboration-platform-back"
            data-testid="collaboration-workspace-back"
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
            ← {messages.backToSpaces}
          </button>
          <div className="collaboration-workspace-identity">
            <span>{workspace.name.slice(0, 1).toUpperCase()}</span>
            <strong>{workspace.name}</strong>
          </div>
          <nav>
            {workspaceNav.map((item) => (
              <button
                type="button"
                className={
                  !host.location.projectId &&
                  host.location.workspaceView === item.id
                    ? "active"
                    : ""
                }
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
                {item.label}
              </button>
            ))}
          </nav>
          <div className="collaboration-platform-sidebar-label">
            {messages.projects}
          </div>
          <nav>
            {projects.map((project) => (
              <button
                type="button"
                className={
                  host.location.projectId === project.id ? "active" : ""
                }
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
                {project.name}
              </button>
            ))}
          </nav>
        </>
      )}
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
    content = (
      <CollaborationApp
        api={scopedApi}
        locale={locale}
        automationUiHost={automationUiHost}
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
            <button
              type="button"
              className="collaboration-primary-button"
              data-testid="collaboration-workspace-create"
              onClick={() => setWorkspaceDialogOpen(true)}
            >
              ＋ {messages.createWorkspace}
            </button>
          }
        />
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
          <div className="collaboration-workspace-card-grid">
            {workspaces.map((workspace) => (
              <button
                type="button"
                className="collaboration-workspace-card"
                data-testid={`collaboration-workspace-${workspace.id}`}
                key={workspace.id}
                onClick={() =>
                  navigateWithin(host, {
                    workspaceId: workspace.id,
                    workspaceView: "home",
                    projectId: null,
                    issueId: null,
                  })
                }
              >
                <span>{workspace.name.slice(0, 1).toUpperCase()}</span>
                <strong>{workspace.name}</strong>
                <p>{workspace.description}</p>
                <small>
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
        ) : (
          <EmptyState
            title={messages.noSpaces}
            description={messages.noSpacesHint}
            action={
              <button
                type="button"
                className="collaboration-primary-button"
                onClick={() => setWorkspaceDialogOpen(true)}
              >
                {messages.createWorkspace}
              </button>
            }
          />
        )}
      </div>
    );
  } else {
    const workspace = state.workspace;
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
    if (host.location.workspaceView === "settings") {
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
          ) : null}
          <section className="collaboration-platform-panel">
            <h2>{messages.projects}</h2>
            <ProjectCards
              projects={state.projects}
              messages={messages}
              onOpen={openProject}
            />
          </section>
        </div>
      );
    }
  }

  return (
    <section
      className="collaboration-platform-app"
      data-testid="collaboration-platform-root"
    >
      <CollaborationPlatformNavigation
        host={host}
        messages={messages}
        workspace={state.workspace}
        projects={state.projects}
      />
      <main className="collaboration-platform-main">{content}</main>
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
              location: "cloud",
              create: commands.createProject,
            },
          ]}
          defaultLocation="cloud"
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
