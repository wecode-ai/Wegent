// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  AlertTriangle,
  Bot,
  CircleCheck,
  Cloud,
  ChevronRight,
  Clock3,
  Ellipsis,
  FolderPlus,
  FolderOpen,
  Monitor,
  SquarePen,
  Plus,
  Search,
  Settings,
  UserRound,
  UsersRound,
  X,
} from "lucide-react";

import { CollaborationTemplateContext } from "../templates/context";
import { CollaborationTemplatePage } from "../templates/CollaborationTemplatePage";
import type { CollaborationTemplate } from "../templates/types";
import { useDeviceCatalog } from "./useDeviceCatalog";
import { ensureWorkspaceEnvironmentSharing } from "../execution-environment/ensureWorkspaceEnvironmentSharing";

import { platformMessages, type PlatformMessages } from "./platformMessages";
import { ResourceCatalogPage } from "./ResourceCatalogPage";
import type {
  ResourceCatalogKind,
  ResourceSource,
} from "./resourceCatalogModel";

import { CollaborationApp } from "../CollaborationApp";
import { StandInIcon } from "../StandInIcon";
import { ProjectLoadingSkeleton } from "../project-shell";
import { ActionMenu } from "../controls/ActionMenu";
import { ProjectCreationAction } from "./ProjectCreationAction";
import { IssueExecutionEnvironmentNotice } from "../execution-environment/IssueExecutionEnvironmentNotice";
import { useProjectExecutionEnvironmentReadiness } from "../execution-environment/issueEnvironmentReadiness";
import { canAccessCollaborationProjectView } from "../permissions";
import { ProjectArchiveDialog } from "./ProjectArchiveDialog";
import { WorkspaceCreateDialog } from "./WorkspaceCreateDialog";
import { Tooltip } from "../issue-detail/Tooltip";
import { truncateRuntimeTaskTitle } from "@wegent/chat-core/runtime-task-title";
import { IssueHomeComposer } from "./IssueHomeComposer";
import type { IssueHomeOwner } from "./issueHomeOwners";
import type { ComposerInputHandle } from "../composer";
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
  createResourceAgentBindingInput,
  ProjectAgentConfiguration,
} from "../project-agent-config";
import {
  normalizeCollaborationGroupDraftForPersistence,
  ProjectCreateDialog,
  projectCreateLabels,
} from "../project-create";
import {
  CollaborationParticipantsTabs,
  ProjectExecutionEnvironments,
  ProjectSettingsShell,
} from "../project-manage";
import type {
  CollaborationGroup,
  CollaborationIssue,
  CollaborationMember,
  CollaborationWorkspaceMember,
  CollaborationOwnedAgent,
  CollaborationProject,
  CollaborationWorkspace,
  CollaborationWorkspaceNavigationContext,
} from "../types";
import type {
  CollaborationDomain,
  CollaborationPlatformHostAdapter,
  CollaborationPlatformLocation,
  CollaborationWorkspaceView,
} from "./types";
import { buildWorkspaceNavigation } from "./workspaceNavigation";
import { useCollaborationPlatformController } from "./useCollaborationPlatformController";
import {
  createWorkspaceOperationsSnapshot,
  workspaceIssueOperationState,
  type WorkspaceOperationState,
  type WorkspaceProjectIssuesSnapshot,
} from "./workspaceOperations";
import {
  isCurrentDeviceCollaborationAgent,
  WorkspaceCollaborationGroupsConfiguration,
  type WorkspaceResourceCommands,
} from "./WorkspaceResourceConfiguration";
import {
  WorkspaceGroupsPanel,
  WorkspaceMembersPanel,
} from "./WorkspaceParticipantPanels";

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
  const location = { ...host.location, ...patch };
  if (patch.projectView && patch.projectView !== "manage") {
    location.projectSettingsSection = null;
  }
  host.navigate(location);
}

function workspaceAgentRecord(
  agent: CollaborationOwnedAgent,
): WorkspaceProjectAgent {
  const teamId = agent.team_id;
  if (teamId == null) {
    return {
      ...agent,
      id: agent.id,
      runtime: agent.runtime ?? "codex",
      status: agent.status === "unavailable" ? "archived" : "active",
      version: agent.version ?? 1,
    };
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
        const current = (await workspaces.listAgents(workspaceId)).find(
          (agent) =>
            (Number.isFinite(teamId) && agent.team_id === teamId) ||
            agent.id === agentId,
        );
        if (!current) throw new Error("Workspace Agent was not found");
        if (current.team_id != null) {
          await workspaces.removeAgent(workspaceId, current.team_id);
        } else if (api.resources?.removeAgent) {
          await api.resources.removeAgent(current);
        } else {
          throw new Error("Workspace Agent cannot be removed");
        }
        return {
          ...workspaceAgentRecord(current),
          status: "archived",
        };
      },
    },
  };
}

function CollaborationPlatformNavigation({
  domain,
  host,
  messages,
  workspaces,
  workspaceNavigationContext,
  projects,
  navigationIncomplete,
  onRetryNavigation,
  canCreateWorkspace,
  onCreateWorkspace,
  onCreateProject,
  onNewConversation,
  onArchiveProject,
  footer,
}: {
  domain: CollaborationDomain;
  host: CollaborationPlatformHostAdapter;
  messages: PlatformMessages;
  workspaces: CollaborationWorkspace[];
  workspaceNavigationContext: CollaborationWorkspaceNavigationContext | null;
  projects: CollaborationProject[];
  navigationIncomplete: boolean;
  onRetryNavigation(): Promise<void>;
  canCreateWorkspace: boolean;
  onCreateWorkspace(): void;
  onCreateProject(
    workspaceId: string,
    mode: "blank" | "folder" | "existing",
  ): void;
  onNewConversation(projectId: string): void;
  onArchiveProject(project: CollaborationProject): void;
  footer?: React.ReactNode;
}) {
  const { workspaces: navigationWorkspaces, projectsByWorkspace } = useMemo(
    () =>
      buildWorkspaceNavigation(
        workspaces,
        projects,
        workspaceNavigationContext,
      ),
    [projects, workspaces, workspaceNavigationContext],
  );
  const selectedProjectWorkspaceId = projects.find(
    (project) => project.id === host.location.projectId,
  )?.workspace_id;
  const selectedWorkspaceId =
    host.location.workspaceId ?? selectedProjectWorkspaceId ?? null;
  const firstWorkspaceId = navigationWorkspaces[0]?.workspace.id ?? null;
  const autoExpandedWorkspaceId = selectedWorkspaceId ?? firstWorkspaceId;
  const [expandedWorkspaceIds, setExpandedWorkspaceIds] = useState<Set<string>>(
    () =>
      new Set(
        autoExpandedWorkspaceId
          ? [autoExpandedWorkspaceId]
          : navigationWorkspaces
              .slice(0, 1)
              .map(({ workspace }) => workspace.id),
      ),
  );
  const [autoExpandedWorkspaceSelection, setAutoExpandedWorkspaceSelection] =
    useState<string | null>(autoExpandedWorkspaceId);
  const [workspacesExpanded, setWorkspacesExpanded] = useState(true);
  const [retryingNavigation, setRetryingNavigation] = useState(false);
  const fullSidebar = host.capabilities.sidebarPresentation !== "context";
  // Expansion follows the selected workspace during render so it cannot land
  // after the user has already clicked the toggle that was just rendered.
  if (autoExpandedWorkspaceSelection !== autoExpandedWorkspaceId) {
    setAutoExpandedWorkspaceSelection(autoExpandedWorkspaceId);
    if (autoExpandedWorkspaceId) {
      setExpandedWorkspaceIds((current) => {
        if (current.has(autoExpandedWorkspaceId)) return current;
        return new Set([...current, autoExpandedWorkspaceId]);
      });
    }
  }
  const openWorkspaceHome = (
    workspaceId: string,
    collaborationDomain: CollaborationDomain,
  ) =>
    host.navigate({
      platformView: "spaces",
      collaborationDomain,
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
      {fullSidebar ? (
        <>
          <div className="collaboration-platform-brand">
            {messages.collaborationHome}
          </div>
          <nav
            className="collaboration-primary-navigation"
            aria-label={messages.collaborationSpaces}
          >
            <button
              type="button"
              className={
                !host.location.workspaceId &&
                (host.location.rootView ?? "home") === "home"
                  ? "active"
                  : undefined
              }
              aria-current={
                !host.location.workspaceId &&
                (host.location.rootView ?? "home") === "home"
                  ? "page"
                  : undefined
              }
              data-testid="collaboration-primary-home"
              onClick={() =>
                host.navigate({
                  platformView: "spaces",
                  collaborationDomain: domain,
                  rootView: "home",
                  workspaceId: null,
                  workspaceView: "home",
                  projectId: null,
                  projectView: "board",
                  issueId: null,
                })
              }
            >
              <Plus aria-hidden="true" />
              <span>{messages.home}</span>
            </button>
            {host.renderStandInPage && (
              <button
                type="button"
                data-testid="collaboration-primary-stand-in"
                className={
                  !host.location.workspaceId &&
                  host.location.rootView === "stand-in"
                    ? "active"
                    : undefined
                }
                aria-current={
                  !host.location.workspaceId &&
                  host.location.rootView === "stand-in"
                    ? "page"
                    : undefined
                }
                onClick={() =>
                  host.navigate({
                    platformView: "spaces",
                    collaborationDomain: domain,
                    rootView: "stand-in",
                    workspaceId: null,
                    workspaceView: "home",
                    projectId: null,
                    projectView: "board",
                    issueId: null,
                  })
                }
              >
                <StandInIcon />
                <span>{messages.standIn}</span>
              </button>
            )}
            {host.templateStore && host.templateNavigation && (
              <button
                type="button"
                className={
                  !host.location.workspaceId &&
                  host.location.rootView === "templates"
                    ? "active"
                    : undefined
                }
                aria-current={
                  host.location.rootView === "templates" ? "page" : undefined
                }
                data-testid="collaboration-primary-templates"
                onClick={() =>
                  host.navigate({
                    ...host.location,
                    platformView: "spaces",
                    rootView: "templates",
                    workspaceId: null,
                    workspaceView: "home",
                    projectId: null,
                    projectView: "board",
                    issueId: null,
                  })
                }
              >
                <UsersRound aria-hidden="true" />
                <span>{messages.templates}</span>
              </button>
            )}
            <button
              type="button"
              className={
                !host.location.workspaceId &&
                host.location.rootView === "agents"
                  ? "active"
                  : undefined
              }
              aria-current={
                !host.location.workspaceId &&
                host.location.rootView === "agents"
                  ? "page"
                  : undefined
              }
              data-testid="collaboration-primary-agents"
              onClick={() =>
                host.navigate({
                  platformView: "spaces",
                  collaborationDomain: domain,
                  rootView: "agents",
                  workspaceId: null,
                  workspaceView: "home",
                  projectId: null,
                  projectView: "board",
                  issueId: null,
                })
              }
            >
              <Bot aria-hidden="true" />
              <span>{messages.agents}</span>
            </button>
            <button
              type="button"
              className={
                !host.location.workspaceId && host.location.rootView === "teams"
                  ? "active"
                  : undefined
              }
              aria-current={
                !host.location.workspaceId && host.location.rootView === "teams"
                  ? "page"
                  : undefined
              }
              data-testid="collaboration-primary-teams"
              onClick={() =>
                host.navigate({
                  platformView: "spaces",
                  collaborationDomain: domain,
                  rootView: "teams",
                  workspaceId: null,
                  workspaceView: "home",
                  projectId: null,
                  projectView: "board",
                  issueId: null,
                })
              }
            >
              <UsersRound aria-hidden="true" />
              <span>{messages.teams}</span>
            </button>
            <button
              type="button"
              className={
                !host.location.workspaceId &&
                host.location.rootView === "devices"
                  ? "active"
                  : undefined
              }
              aria-current={
                !host.location.workspaceId &&
                host.location.rootView === "devices"
                  ? "page"
                  : undefined
              }
              data-testid="collaboration-primary-devices"
              onClick={() =>
                host.navigate({
                  platformView: "spaces",
                  collaborationDomain: domain,
                  rootView: "devices",
                  workspaceId: null,
                  workspaceView: "home",
                  projectId: null,
                  projectView: "board",
                  issueId: null,
                })
              }
            >
              <Monitor aria-hidden="true" />
              <span>{messages.devices}</span>
            </button>
          </nav>
        </>
      ) : null}
      <div className="collaboration-workspace-section-heading">
        {fullSidebar ? (
          <span
            className="collaboration-workspace-section-title"
            data-testid="collaboration-workspaces-section-title"
          >
            {messages.collaborationSpaces}
          </span>
        ) : (
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
        )}
        {canCreateWorkspace ? (
          <div className="collaboration-workspace-section-actions">
            <button
              type="button"
              className="collaboration-workspace-section-create"
              aria-label={messages.createWorkspace}
              title={messages.createWorkspace}
              data-testid="collaboration-workspace-create"
              onClick={onCreateWorkspace}
            >
              <span data-testid="collaboration-workspace-sidebar-create">
                <FolderPlus aria-hidden="true" />
              </span>
            </button>
          </div>
        ) : null}
      </div>
      {navigationIncomplete ? (
        <div
          className="collaboration-navigation-error"
          role="alert"
          data-testid="collaboration-navigation-error"
        >
          <span>{messages.navigationLoadFailed}</span>
          <button
            type="button"
            className="collaboration-link-button"
            data-testid="collaboration-navigation-retry"
            disabled={retryingNavigation}
            onClick={async () => {
              setRetryingNavigation(true);
              try {
                await onRetryNavigation();
              } finally {
                setRetryingNavigation(false);
              }
            }}
          >
            {messages.retryNavigation}
          </button>
        </div>
      ) : null}
      {fullSidebar || workspacesExpanded ? (
        <div className="collaboration-workspace-tree">
          {navigationWorkspaces.map(({ workspace: candidate, canOpen }) => {
            const expanded = expandedWorkspaceIds.has(candidate.id);
            const candidateProjects =
              projectsByWorkspace.get(candidate.id) ?? [];
            const workspaceActive =
              host.location.workspaceId === candidate.id &&
              !host.location.projectId;
            const canManageWorkspace =
              canOpen &&
              "access_role" in candidate &&
              (candidate.access_role === "Owner" ||
                candidate.access_role === "Maintainer");
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
                      onClick={() =>
                        openWorkspaceHome(candidate.id, candidate.location)
                      }
                    >
                      <span
                        className="collaboration-workspace-folder"
                        aria-hidden="true"
                      >
                        <FolderOpen />
                      </span>
                      <span
                        className="collaboration-workspace-title-block"
                        data-testid={`collaboration-workspace-${candidate.id}`}
                      >
                        <span className="collaboration-workspace-title">
                          {candidate.name}
                        </span>
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
                        data-testid={`collaboration-workspace-${candidate.id}`}
                      >
                        <span className="collaboration-workspace-title">
                          {candidate.name}
                        </span>
                      </span>
                    </div>
                  )}
                  {canManageWorkspace ? (
                    <div className="collaboration-workspace-actions">
                      <ActionMenu
                        ariaLabel={messages.settings}
                        icon={Ellipsis}
                        items={[
                          {
                            label: messages.addProject,
                            icon: Plus,
                            testId:
                              "collaboration-workspace-nav-create-project",
                            children: [
                              {
                                label: messages.blankProject,
                                icon: SquarePen,
                                testId:
                                  "collaboration-workspace-nav-create-blank-project",
                                onSelect: () =>
                                  onCreateProject(candidate.id, "blank"),
                              },
                              ...(candidate.location === "local" &&
                              host.renderProjectImporter
                                ? [
                                    {
                                      label: messages.addFolder,
                                      icon: FolderPlus,
                                      testId:
                                        "collaboration-workspace-nav-add-folder",
                                      onSelect: () =>
                                        onCreateProject(candidate.id, "folder"),
                                    },
                                    {
                                      label: messages.importExistingProject,
                                      icon: FolderOpen,
                                      testId:
                                        "collaboration-workspace-nav-import-existing-project",
                                      onSelect: () =>
                                        onCreateProject(
                                          candidate.id,
                                          "existing",
                                        ),
                                    },
                                  ]
                                : []),
                            ],
                          },
                          {
                            separator: true,
                            label: "",
                            testId:
                              "collaboration-workspace-nav-project-separator",
                          },
                          {
                            label: messages.settings,
                            icon: Settings,
                            testId: "collaboration-workspace-nav-settings",
                            onSelect: () => {
                              host.navigate({
                                platformView: "spaces",
                                workspaceId: candidate.id,
                                workspaceView: "settings",
                                projectId: null,
                                projectView: "board",
                                issueId: null,
                              });
                            },
                          },
                        ]}
                        placement="bottom-end"
                        showTriggerTooltip={false}
                        testId={
                          host.location.workspaceId === candidate.id
                            ? "collaboration-workspace-actions"
                            : `collaboration-workspace-actions-${candidate.id}`
                        }
                        triggerClassName="collaboration-workspace-action-trigger"
                      />
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
                </div>
                {expanded ? (
                  <nav
                    className="collaboration-workspace-project-list"
                    aria-label={`${candidate.name} · ${messages.projects}`}
                  >
                    {candidateProjects.map((project) => (
                      <div
                        className="collaboration-workspace-project-row"
                        key={project.id}
                      >
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
                          {host.renderProjectSidebarBadge?.(project)}
                          <span>{project.name}</span>
                        </button>
                        <div className="collaboration-project-row-actions">
                          <Tooltip
                            label={messages.newConversation}
                            className="collaboration-project-action-anchor"
                          >
                            <button
                              type="button"
                              className="collaboration-project-new-conversation"
                              aria-label={`${messages.newConversation} · ${project.name}`}
                              data-testid={`collaboration-project-new-conversation-${project.id}`}
                              onClick={() => onNewConversation(project.id)}
                            >
                              <SquarePen aria-hidden="true" />
                            </button>
                          </Tooltip>
                          {canAccessCollaborationProjectView(
                            project,
                            "manage",
                          ) && (
                            <ActionMenu
                              ariaLabel={`${messages.projectActions} · ${project.name}`}
                              testId={`collaboration-project-menu-${project.id}`}
                              triggerClassName="collaboration-project-new-conversation"
                              items={[
                                {
                                  label: messages.archiveProject,
                                  testId: `collaboration-project-archive-${project.id}`,
                                  onSelect: () => onArchiveProject(project),
                                },
                              ]}
                            />
                          )}
                        </div>
                      </div>
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
            <div
              data-testid={`collaboration-workspace-metric-${metric.id}`}
              data-tone={metric.tone}
              key={metric.id}
            >
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
  if (item.assignee_group_id) {
    return {
      name: item.assignee_group_name || messages.group,
      kind: messages.group,
      icon: UsersRound,
    };
  }
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
        <small>{item.status}</small>
      </span>
      <OperationStateBadge messages={messages} state={status.state} />
      <time dateTime={item.updated_at}>
        {formatOperationTime(locale, item.updated_at)}
      </time>
      <ChevronRight aria-hidden="true" />
    </button>
  );
}

function FirstProjectStarter({
  messages,
  supportsLocalImport,
  onCreate,
}: {
  messages: PlatformMessages;
  supportsLocalImport: boolean;
  onCreate(mode: "blank" | "folder" | "existing"): void;
}) {
  return (
    <section
      className="collaboration-first-project-starter"
      data-testid="collaboration-first-project-starter"
    >
      <span className="collaboration-first-project-icon">
        <FolderPlus aria-hidden="true" />
      </span>
      <div className="collaboration-first-project-copy">
        <h2>{messages.firstProjectHomeTitle}</h2>
        <p>{messages.firstProjectHomeHint}</p>
      </div>
      <div
        className="collaboration-first-project-guide"
        aria-label={messages.firstProjectHomeTitle}
      >
        <span>
          <SquarePen aria-hidden="true" />
          {messages.firstProjectGuideCapture}
        </span>
        <ChevronRight aria-hidden="true" />
        <span>
          <UsersRound aria-hidden="true" />
          {messages.firstProjectGuideAssign}
        </span>
        <ChevronRight aria-hidden="true" />
        <span>
          <CircleCheck aria-hidden="true" />
          {messages.firstProjectGuideTrack}
        </span>
      </div>
      <ProjectCreationAction
        className="collaboration-primary-button collaboration-first-project-create"
        messages={messages}
        onSelect={onCreate}
        supportsLocalImport={supportsLocalImport}
        testId="collaboration-first-project-create"
      />
    </section>
  );
}

function IssueHomeLauncher({
  messages,
  projects,
  workspaces,
  selectedProjectId,
  onSelectProject,
  onCreateIssue,
  onOpenExecutionEnvironments,
  pending,
  api,
  locale,
  renderTaskComposer,
}: {
  messages: PlatformMessages;
  projects: CollaborationProject[];
  workspaces: CollaborationWorkspace[];
  selectedProjectId: string;
  onSelectProject(projectId: string): void;
  onCreateIssue(
    content: string,
    owner: IssueHomeOwner | null,
    files: File[],
    standInDeviceId?: string,
    standInId?: string,
  ): Promise<boolean>;
  onOpenExecutionEnvironments(project: CollaborationProject): void;
  pending: boolean;
  api: SharedWorkspaceApi;
  locale: CollaborationLocale;
  renderTaskComposer?: CollaborationPlatformHostAdapter["renderIssueComposer"];
}) {
  const [content, setContent] = useState("");
  const [members, setMembers] = useState<CollaborationMember[]>([]);
  const [agents, setAgents] = useState<WorkspaceProjectAgent[]>([]);
  const [mentionIssues, setMentionIssues] = useState<CollaborationIssue[]>([]);
  const [mentionGroups, setMentionGroups] = useState<
    import("../types").CollaborationGroup[]
  >([]);
  const [memberError, setMemberError] = useState<string | null>(null);
  const composerRef = useRef<ComposerInputHandle>(null);
  const selectedProject = projects.find(
    (project) => project.id === selectedProjectId,
  );
  const translate = useMemo(
    () => createCollaborationTranslator(locale),
    [locale],
  );
  const environmentReadiness = useProjectExecutionEnvironmentReadiness({
    api,
    project: selectedProject,
  });
  useEffect(() => {
    let active = true;
    setMembers([]);
    setAgents([]);
    setMentionIssues([]);
    setMentionGroups([]);
    setMemberError(null);
    void Promise.all([
      api.members.list(selectedProjectId),
      api.agents.list(selectedProjectId),
      api.issues.list(selectedProjectId),
      api.projects.listCollaborationGroups?.(selectedProjectId) ?? [],
    ])
      .then(([items, projectAgents, issues, groups]) => {
        if (active) {
          setMembers(items);
          setAgents(projectAgents);
          setMentionIssues(issues);
          setMentionGroups(groups);
        }
      })
      .catch(() => {
        if (active) setMemberError(messages.issueHomeMembersFailed);
      });
    return () => {
      active = false;
    };
  }, [api, selectedProjectId, messages.issueHomeMembersFailed]);
  const guides = [
    {
      Icon: SquarePen,
      title: messages.issueGuideRequirement,
      hint: messages.issueGuideRequirementHint,
    },
    {
      Icon: AlertTriangle,
      title: messages.issueGuideBug,
      hint: messages.issueGuideBugHint,
    },
    {
      Icon: CircleCheck,
      title: messages.issueGuideReview,
      hint: messages.issueGuideReviewHint,
    },
    {
      Icon: Search,
      title: messages.issueGuideResearch,
      hint: messages.issueGuideResearchHint,
    },
  ];

  const composer = (
    <IssueHomeComposer
      renderTaskComposer={renderTaskComposer}
      ref={composerRef}
      value={content}
      onChange={setContent}
      onSubmit={onCreateIssue}
      pending={pending}
      members={members}
      agents={agents}
      issues={mentionIssues}
      groups={mentionGroups}
      projects={projects}
      workspaces={workspaces}
      projectId={selectedProjectId}
      onSelectProject={(id) => {
        setMembers([]);
        setAgents([]);
        setMentionIssues([]);
        onSelectProject(id);
      }}
      translate={translate}
      placeholder={messages.issueHomePlaceholder}
      projectLabel={messages.issueHomeProject}
      memberLabel={messages.members}
      error={memberError}
      environmentNotice={
        selectedProject ? (
          <IssueExecutionEnvironmentNotice
            canManage={
              selectedProject.access_role === "Owner" ||
              selectedProject.access_role === "Maintainer"
            }
            onOpenEnvironmentSettings={() =>
              onOpenExecutionEnvironments(selectedProject)
            }
            readiness={environmentReadiness}
            translate={translate}
          />
        ) : null
      }
    />
  );
  if (renderTaskComposer)
    return (
      <div
        className="flex min-h-0 flex-1"
        data-testid="collaboration-issue-home"
        data-execution-environment-readiness={environmentReadiness.kind}
      >
        {composer}
      </div>
    );

  return (
    <section
      className="collaboration-issue-home"
      data-testid="collaboration-issue-home"
      data-execution-environment-readiness={environmentReadiness.kind}
    >
      <div className="collaboration-issue-home-heading">
        <h1 data-testid="collaboration-issue-home-title">
          {messages.issueHomeTitle}
        </h1>
        <p data-testid="collaboration-issue-home-hint">
          {messages.issueHomeHint}
        </p>
      </div>
      <div className="collaboration-issue-home-guides">
        {guides.map((guide, index) => (
          <button
            type="button"
            data-testid={`collaboration-issue-guide-${index + 1}`}
            key={guide.title}
            title={guide.hint}
            disabled={pending}
            onClick={() => {
              const current = composerRef.current?.getValue() ?? content;
              const next = `${current ? `${current}\n` : ""}${guide.title}：${guide.hint}`;
              composerRef.current?.setValue(next);
              composerRef.current?.focus();
            }}
          >
            <guide.Icon aria-hidden="true" />
            <strong>{guide.title}</strong>
            <ChevronRight aria-hidden="true" />
          </button>
        ))}
      </div>
      <div className="collaboration-issue-home-composer">{composer}</div>
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
        <div className="collaboration-home-work-groups">
          <section data-testid="collaboration-work-group-assigned">
            <h2 className="collaboration-home-work-group-title">
              {locale === "zh-CN" ? "待我处理" : "Assigned to me"}
            </h2>
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
          </section>
        </div>
      ) : (
        <EmptyState title={empty} description={messages.workspaceHint} />
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

function RootTeamEditor({
  api,
  host,
  workspace,
  groups,
  locale,
  onClose,
  onCreated,
  groupId,
}: {
  api: SharedWorkspaceApi;
  host: CollaborationPlatformHostAdapter;
  workspace: CollaborationWorkspace;
  groups: CollaborationGroup[];
  locale: CollaborationLocale;
  onClose(): void;
  onCreated(): Promise<void>;
  groupId?: string;
}) {
  const [members, setMembers] = useState<CollaborationWorkspaceMember[]>([]);
  const [agents, setAgents] = useState<CollaborationOwnedAgent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (!groupId || loading || error) return;
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [groupId, loading, error]);

  useEffect(() => {
    let active = true;
    if (!api.workspaces) {
      setError("Workspace API is unavailable");
      setLoading(false);
      return;
    }
    void Promise.all([
      api.workspaces.listMembers(workspace.id),
      api.workspaces.listAgents(workspace.id),
    ])
      .then(([nextMembers, nextAgents]) => {
        if (!active) return;
        setMembers(nextMembers);
        setAgents(nextAgents);
      })
      .catch((cause) => {
        if (!active) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [api.workspaces, workspace.id]);

  const commands = useMemo<WorkspaceResourceCommands>(() => {
    if (!api.workspaces) {
      throw new Error("Workspace API is unavailable");
    }
    return {
      transferOwnership: api.workspaces.transferOwnership
        ? async (userId, version) => {
            await api.workspaces!.transferOwnership!(workspace.id, {
              userId,
              version,
            });
            await onCreated();
          }
        : undefined,
      searchUsers: (query) => api.members.searchUsers(query),
      addMember: (userId, role) =>
        api.workspaces!.addMember(workspace.id, { userId, role }),
      updateMember: (userId, inputRole) =>
        api.workspaces!.updateMember(workspace.id, userId, {
          role: inputRole,
        }),
      removeMember: (userId) =>
        api.workspaces!.removeMember(workspace.id, userId),
      async createCollaborationGroup(input) {
        const created = await api.workspaces!.createCollaborationGroup(
          workspace.id,
          input,
        );
        await onCreated();
        return created;
      },
      async updateCollaborationGroup(groupId, input) {
        const updated = await api.workspaces!.updateCollaborationGroup(
          workspace.id,
          groupId,
          input,
        );
        await onCreated();
        return updated;
      },
      async removeCollaborationGroup(groupId) {
        await api.workspaces!.removeCollaborationGroup(workspace.id, groupId);
        await onCreated();
      },
    };
  }, [api.members, api.workspaces, onCreated, workspace.id]);

  if (loading || error) {
    return (
      <div className="collaboration-dialog-backdrop" role="presentation">
        <section className="collaboration-resource-dialog" role="dialog">
          <header>
            <div>
              <h2>
                {groupId
                  ? locale === "zh-CN"
                    ? "协作小组设置"
                    : "Team settings"
                  : locale === "zh-CN"
                    ? "新建协作小组"
                    : "New team"}
              </h2>
              <p>
                {error ??
                  (locale === "zh-CN"
                    ? "正在加载空间成员与智能体…"
                    : "Loading workspace members and agents…")}
              </p>
            </div>
            <button type="button" onClick={onClose}>
              <X aria-hidden="true" />
            </button>
          </header>
        </section>
      </div>
    );
  }

  const form = (
    <WorkspaceCollaborationGroupsConfiguration
      workspace={workspace}
      groups={groups}
      members={members}
      agents={agents}
      locale={locale}
      currentUserId={host.currentUser?.id}
      commands={commands}
      agentActions={{
        ...(workspace.location === "cloud" &&
        host.projectAgentConfiguration?.renderAgentCreator
          ? {
              renderCreator: ({ onClose, onCreated }) =>
                host.projectAgentConfiguration!.renderAgentCreator!({
                  namespace: workspace.namespace,
                  workspaceName: workspace.name,
                  onClose,
                  onCreated: async (resource) => {
                    const created = await api.workspaces!.addAgent(
                      workspace.id,
                      {
                        teamId: resource.teamId,
                      },
                    );
                    const nextAgents = await api.workspaces!.listAgents(
                      workspace.id,
                    );
                    setAgents(nextAgents);
                    await onCreated(created);
                  },
                }),
            }
          : {}),
      }}
      initialCreateOpen={!groupId}
      initialSelectedGroupId={groupId}
      onDetailClose={onClose}
      detailPresentation={groupId ? "dialog" : "page"}
      showGroupCollection={Boolean(groupId)}
      onCreateOpenChange={(open) => {
        if (!groupId && !open) onClose();
      }}
    />
  );
  return groupId ? (
    <div
      className="collaboration-resource-dialog-backdrop"
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          onClose();
        }
        if (event.key === "Tab") {
          const controls = Array.from(
            dialogRef.current?.querySelectorAll<HTMLElement>(
              'button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), [tabindex="0"]',
            ) ?? [],
          );
          const first = controls[0];
          const last = controls[controls.length - 1];
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault();
            last?.focus();
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault();
            first?.focus();
          }
        }
      }}
    >
      <section
        ref={dialogRef}
        className="collaboration-resource-dialog collaboration-team-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={locale === "zh-CN" ? "协作小组设置" : "Team settings"}
        data-testid="collaboration-team-settings-dialog"
      >
        <header className="collaboration-team-settings-header">
          <div>
            <h2>{locale === "zh-CN" ? "设置协作小组" : "Team settings"}</h2>
            <p>
              {locale === "zh-CN"
                ? "编辑基本信息、成员分工和协作方式"
                : "Edit team details, participants, and collaboration rules"}
            </p>
          </div>
          <button
            type="button"
            aria-label={locale === "zh-CN" ? "关闭" : "Close"}
            data-testid="collaboration-team-settings-close"
            onClick={onClose}
          >
            ×
          </button>
        </header>
        {form}
      </section>
    </div>
  ) : (
    form
  );
}

export function CollaborationPlatformApp(
  props: React.ComponentProps<typeof CollaborationPlatformAppContent>,
) {
  return (
    <CollaborationTemplateContext.Provider
      key={props.host.templateStore?.library.scope ?? "default"}
      value={props.host.templateStore ?? null}
    >
      <CollaborationPlatformAppContent {...props} />
    </CollaborationTemplateContext.Provider>
  );
}

function CollaborationPlatformAppContent({
  api,
  refreshKey,
  navigationApis,
  host,
  locale = "zh-CN",
  onCreateTask,
  onReady,
  renderProject,
  renderShell,
  sidebarFooter,
}: {
  api: SharedWorkspaceApi;
  refreshKey?: string;
  navigationApis?: SharedWorkspaceApi[];
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
  const isDevicePage =
    !host.location.projectId &&
    !host.location.workspaceId &&
    host.location.rootView === "devices";
  const isStandInPage =
    !host.location.projectId &&
    !host.location.workspaceId &&
    host.location.rootView === "stand-in" &&
    Boolean(host.renderStandInPage);
  const deviceCatalog = useDeviceCatalog(
    api,
    isDevicePage,
    refreshKey,
    host.currentUser,
  );
  const { state, commands } = useCollaborationPlatformController({
    api,
    navigationApis,
    location: host.location,
    loadFailedMessage: messages.loadFailed,
    refreshKey,
  });
  const [workspaceDialogOpen, setWorkspaceDialogOpen] = useState(false);
  const [archiveProject, setArchiveProject] =
    useState<CollaborationProject | null>(null);
  const [projectDialogOpen, setProjectDialogOpen] = useState(false);
  const [projectTemplate, setProjectTemplate] =
    useState<CollaborationTemplate | null>(null);
  const [projectImporter, setProjectImporter] = useState<{
    workspaceId: string;
    mode: "folder" | "existing";
  } | null>(null);
  const [projectWorkspaceId, setProjectWorkspaceId] = useState<string | null>(
    null,
  );
  const [projectWorkspaceMembers, setProjectWorkspaceMembers] = useState<
    CollaborationWorkspaceMember[]
  >([]);
  const [projectWorkspaceAgents, setProjectWorkspaceAgents] = useState<
    CollaborationOwnedAgent[]
  >([]);
  const [projectWorkspaceGroups, setProjectWorkspaceGroups] = useState<
    CollaborationGroup[]
  >([]);
  const [projectResourceRefreshKey, setProjectResourceRefreshKey] = useState(0);
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [pendingProjectMode, setPendingProjectMode] = useState<
    "blank" | "folder" | "existing"
  >("blank");
  const [createProjectAfterWorkspace, setCreateProjectAfterWorkspace] =
    useState(false);
  const [workspaceGroupCreationRequested, setWorkspaceGroupCreationRequested] =
    useState(false);
  const [rootAgentForm, setRootAgentForm] = useState<{
    mode: "create" | "edit";
    source: ResourceSource;
    namespace: string;
    ownerLabel: string;
    ownerOptions?: Array<{ namespace: string; label: string }>;
    resourceId?: string;
    teamId?: number;
  } | null>(null);
  const [rootDeviceCreator, setRootDeviceCreator] = useState<{
    source: ResourceSource;
    workspaceId?: string;
  } | null>(null);
  const [rootTeamCreationWorkspaceId, setRootTeamCreationWorkspaceId] =
    useState<string | null>(null);
  const [rootTeamEditingId, setRootTeamEditingId] = useState<string>();
  const [rootIssueProjectId, setRootIssueProjectId] = useState<string | null>(
    null,
  );
  const [rootIssueLoading, setRootIssueLoading] = useState(false);
  const rootIssueSubmitting = useRef(false);
  const [standInRetry, setStandInRetry] = useState<{
    projectId: string;
    issueId: string;
    deviceId: string;
    standInId?: string;
    files: File[];
    error: string;
  } | null>(null);
  const [standInRetrying, setStandInRetrying] = useState(false);
  const projectWorkspace =
    projectWorkspaceId == null
      ? null
      : (state.workspaces.find(
          (workspace) => workspace.id === projectWorkspaceId,
        ) ??
        (state.workspace?.id === projectWorkspaceId ? state.workspace : null));
  const projectImporterWorkspace =
    projectImporter == null
      ? null
      : (state.workspaces.find(
          (workspace) => workspace.id === projectImporter.workspaceId,
        ) ??
        (state.workspace?.id === projectImporter.workspaceId
          ? state.workspace
          : null));
  const projectWorkspaceOwnerLabel =
    projectWorkspace == null
      ? null
      : (host.workspaceOwnerOptions?.find(
          (option) => option.namespace === projectWorkspace.namespace,
        )?.label ??
        (projectWorkspace.namespace === "default"
          ? messages.personalOwner
          : projectWorkspace.namespace));
  useEffect(() => {
    if (!projectDialogOpen || !projectWorkspaceId || !api.workspaces) {
      setProjectWorkspaceMembers([]);
      setProjectWorkspaceAgents([]);
      setProjectWorkspaceGroups([]);
      return;
    }
    let active = true;
    void Promise.all([
      api.workspaces.listMembers(projectWorkspaceId),
      api.workspaces.listAgents(projectWorkspaceId),
      api.workspaces.listCollaborationGroups(projectWorkspaceId),
      api.resources?.list() ?? {
        agents: [],
        execution_environments: [],
      },
    ])
      .then(([members, agents, groups, resources]) => {
        if (!active) return;
        setProjectWorkspaceMembers(members);
        setProjectWorkspaceAgents([...resources.agents, ...agents]);
        setProjectWorkspaceGroups(groups);
      })
      .catch(() => {
        if (!active) return;
        setProjectWorkspaceMembers([]);
        setProjectWorkspaceAgents([]);
        setProjectWorkspaceGroups([]);
      });
    return () => {
      active = false;
    };
  }, [
    api.resources,
    api.workspaces,
    projectDialogOpen,
    projectResourceRefreshKey,
    projectWorkspaceId,
  ]);
  const projectCreateLocation =
    projectWorkspace?.location ?? host.capabilities.projectLocation ?? "cloud";
  const workspaceLocations = host.capabilities.workspaceLocations ?? ["cloud"];
  const canCreateCloudWorkspace = workspaceLocations.includes("cloud");
  const collaborationDomain: CollaborationDomain =
    host.location.collaborationDomain ??
    state.workspace?.location ??
    (host.capabilities.projectLocation === "local" ? "local" : "cloud");
  const domainWorkspaces = state.workspaces;
  const domainWorkspaceIds = useMemo(
    () => new Set(domainWorkspaces.map((workspace) => workspace.id)),
    [domainWorkspaces],
  );
  const domainProjects = useMemo(
    () =>
      state.projects.filter(
        (project) =>
          Boolean(project.workspace_id) &&
          domainWorkspaceIds.has(project.workspace_id!),
      ),
    [domainWorkspaceIds, state.projects],
  );
  const rootIssueProject =
    domainProjects.find((project) => project.id === rootIssueProjectId) ??
    domainProjects[0] ??
    null;
  useEffect(() => {
    if (!state.loading && !state.error) onReady?.();
  }, [onReady, state.error, state.loading]);
  const navigationProjectsRef = useRef(state.navigationProjects);
  useLayoutEffect(() => {
    navigationProjectsRef.current = state.navigationProjects;
  }, [state.navigationProjects]);
  const hasFullWorkspaceAccess =
    state.workspace?.id === host.location.workspaceId;
  const workspaceAccessRef = useRef(hasFullWorkspaceAccess);
  useLayoutEffect(() => {
    workspaceAccessRef.current = hasFullWorkspaceAccess;
  }, [hasFullWorkspaceAccess]);
  const scopedApi = useMemo<SharedWorkspaceApi>(() => {
    if (!host.location.workspaceId) return api;
    const workspaceId = host.location.workspaceId;
    const projectId = host.location.projectId;
    return {
      ...api,
      projects: {
        ...api.projects,
        list: async () => {
          if (projectId) {
            const selectedProject = navigationProjectsRef.current.find(
              (project) => project.id === projectId,
            );
            if (selectedProject) return [selectedProject];
          }
          const hasWorkspaceAccess = workspaceAccessRef.current;
          const projects = await (hasWorkspaceAccess
            ? api.projects.list(workspaceId)
            : api.projects.list());
          if (hasWorkspaceAccess || !projectId) return projects;
          return projects.filter((project) => project.id === projectId);
        },
        create: (input) => api.projects.create({ ...input, workspaceId }),
      },
    };
  }, [api, host.location.projectId, host.location.workspaceId]);
  const workspaceAgentConfigurationApi = useMemo(
    () =>
      host.location.workspaceId
        ? createWorkspaceAgentConfigurationApi(api, host.location.workspaceId)
        : api,
    [api, host.location.workspaceId],
  );
  const projectResourceAgents = useMemo(() => {
    const agents = new Map<string, CollaborationOwnedAgent>();
    for (const agent of [
      ...state.resources.agents,
      ...state.agents,
      ...projectWorkspaceAgents,
    ]) {
      agents.set(agent.id, agent);
    }
    return [...agents.values()];
  }, [projectWorkspaceAgents, state.agents, state.resources.agents]);
  const selectedProjectResourceAgents = projectResourceAgents;
  const defaultProjectAgentResourceIds = useMemo(
    () =>
      selectedProjectResourceAgents
        .filter(isCurrentDeviceCollaborationAgent)
        .map((agent) => agent.id),
    [selectedProjectResourceAgents],
  );
  const openProject = (project: CollaborationProject) => {
    const workspace =
      state.workspaces.find(
        (candidate) => candidate.id === project.workspace_id,
      ) ?? null;
    navigateWithin(host, {
      collaborationDomain:
        workspace?.location ??
        (project.project_store === "local" ? "local" : "cloud"),
      workspaceId: project.workspace_id,
      workspaceView: "projects",
      projectId: project.id,
      projectView: "board",
      issueId: null,
    });
  };
  const openWorkspaceProjectCreator = (
    workspaceId: string,
    mode: "blank" | "folder" | "existing" = "blank",
  ) => {
    const targetWorkspace =
      state.workspaces.find((workspace) => workspace.id === workspaceId) ??
      (state.workspace?.id === workspaceId ? state.workspace : null);
    if (
      mode !== "blank" &&
      targetWorkspace?.location === "local" &&
      host.renderProjectImporter
    ) {
      setProjectImporter({ workspaceId, mode });
      return;
    }
    setProjectWorkspaceId(workspaceId);
    setProjectDialogOpen(true);
  };
  const startProjectCreation = (
    mode: "blank" | "folder" | "existing" = "blank",
  ) => {
    if (
      host.location.workspaceId &&
      state.workspace &&
      (mode === "blank" || state.workspace.location === "local")
    ) {
      openWorkspaceProjectCreator(state.workspace.id, mode);
      return;
    }
    const candidateWorkspaces =
      mode === "blank"
        ? domainWorkspaces
        : domainWorkspaces.filter(
            (workspace) => workspace.location === "local",
          );
    if (candidateWorkspaces.length === 1) {
      openWorkspaceProjectCreator(candidateWorkspaces[0].id, mode);
      return;
    }
    setPendingProjectMode(mode);
    setWorkspacePickerOpen(true);
  };
  const startRootIssueCreation = async (
    content: string,
    owner: IssueHomeOwner | null,
    files: File[],
    standInDeviceId?: string,
    standInId?: string,
  ) => {
    if (!rootIssueProject || rootIssueSubmitting.current || !content.trim())
      return false;
    if (standInDeviceId && (!host.currentUser || !api.standIn?.run))
      return false;
    rootIssueSubmitting.current = true;
    setRootIssueLoading(true);
    try {
      const created = await api.issues.create(rootIssueProject.id, {
        title: truncateRuntimeTaskTitle(content.replace(/\s+/g, " "))!,
        description: content,
        ...(standInDeviceId
          ? {}
          : owner?.kind === "user"
            ? {
                assigneeUserId: Number(owner.id),
                notifyAssignee: true,
              }
            : owner?.kind === "agent"
              ? { assigneeAgentId: owner.id }
              : owner?.kind === "group"
                ? { assigneeGroupId: owner.id }
                : {}),
      });
      const pendingFiles: File[] = [];
      let attachmentError = "";
      for (const file of files) {
        try {
          await api.attachments.upload(created.id, file);
        } catch (error) {
          pendingFiles.push(file);
          attachmentError =
            error instanceof Error ? error.message : String(error);
          host.notify?.(
            error instanceof Error ? error.message : messages.loadFailed,
            "error",
          );
        }
      }
      if (standInDeviceId && api.standIn?.run) {
        try {
          if (pendingFiles.length) throw new Error(attachmentError);
          await api.standIn.run(
            rootIssueProject.id,
            created.id,
            standInDeviceId,
            standInId,
          );
        } catch (error) {
          setStandInRetry({
            projectId: rootIssueProject.id,
            issueId: created.id,
            deviceId: standInDeviceId,
            standInId,
            files: pendingFiles,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
      navigateWithin(host, {
        workspaceId: rootIssueProject.workspace_id,
        workspaceView: "projects",
        projectId: rootIssueProject.id,
        projectView: "board",
        issueId: created.id,
      });
      return true;
    } catch (error) {
      host.notify?.(
        error instanceof Error ? error.message : messages.loadFailed,
        "error",
      );
      return false;
    } finally {
      rootIssueSubmitting.current = false;
      setRootIssueLoading(false);
    }
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
  const openResourceWorkspace = (
    workspaceId: string,
    kind: ResourceCatalogKind,
  ) => {
    const workspaceViews: Record<
      ResourceCatalogKind,
      CollaborationWorkspaceView
    > = {
      agents: "agents",
      teams: "collaboration-groups",
      devices: "execution-environments",
    };
    navigateWithin(host, {
      workspaceId,
      workspaceView: workspaceViews[kind],
      projectId: null,
      projectView: "board",
      issueId: null,
    });
  };
  const bindRootResource = async (
    workspaceId: string,
    kind: ResourceCatalogKind,
    resourceId: string,
  ) => {
    if (!api.workspaces) throw new Error("Workspace API is unavailable");
    try {
      if (kind === "agents") {
        const agent = state.resources.agents.find(
          (candidate) => candidate.id === resourceId,
        );
        if (agent?.location === "local") {
          const workspace = state.workspaces.find(
            (candidate) => candidate.id === workspaceId,
          );
          if (workspace?.location !== "local") {
            throw new Error(
              locale === "zh-CN"
                ? "本地智能体只能在本地空间中使用"
                : "Local Agents can only be used in the local space",
            );
          }
          host.notify?.(messages.bindingsSaved, "success");
          return;
        }
        if (!agent?.team_id) throw new Error("Agent cannot be authorized");
        await api.workspaces.addAgent(workspaceId, { teamId: agent.team_id });
      } else if (kind === "devices") {
        const environment = (
          isDevicePage
            ? deviceCatalog.items
            : state.resources.execution_environments
        ).find((candidate) => candidate.id === resourceId);
        if (!environment?.device_id) {
          throw new Error("Execution environment cannot be authorized");
        }
        await api.workspaces.addExecutionEnvironment(workspaceId, {
          deviceId: environment.device_id,
        });
      } else {
        openResourceWorkspace(workspaceId, kind);
        return;
      }
      await commands.reload();
      host.notify?.(messages.bindingsSaved, "success");
    } catch (error) {
      host.notify?.(
        error instanceof Error ? error.message : messages.loadFailed,
        "error",
      );
      throw error;
    }
  };
  const manageRootResource = (
    kind: ResourceCatalogKind,
    resourceId?: string,
    source?: ResourceSource,
  ) => {
    if (kind === "devices") {
      host.manageResource?.("environments", resourceId, source);
      return;
    }
    if (kind === "teams") {
      const group = state.collaborationGroups.find(
        (candidate) => candidate.id === resourceId,
      );
      if (group) {
        if (group.owner_type === "project") {
          const project = state.navigationProjects.find(
            (candidate) => candidate.id === group.owner_id,
          );
          if (project) {
            host.navigate({
              platformView: "spaces",
              rootView: "home",
              workspaceId: project.workspace_id ?? group.workspace_id,
              workspaceView: "projects",
              projectId: project.id,
              projectView: "manage",
              issueId: null,
            });
          }
          return;
        }
        setRootTeamEditingId(group.id);
        setRootTeamCreationWorkspaceId(group.workspace_id);
      }
      return;
    }
    const agent = state.resources.agents.find(
      (candidate) => candidate.id === resourceId,
    );
    if (agent?.location === "local") {
      if (host.projectAgentConfiguration?.renderLocalAgentEditor) {
        setRootAgentForm({
          mode: "edit",
          source: "local",
          namespace: "default",
          ownerLabel: agent.owner_name,
          resourceId: agent.id,
        });
      }
      return;
    }
    if (!agent?.team_id || !host.projectAgentConfiguration?.renderAgentEditor) {
      host.manageResource?.("agents", resourceId);
      return;
    }
    const ownerLabel =
      host.workspaceOwnerOptions?.find(
        (option) => option.namespace === agent.owner_id,
      )?.label ?? agent.owner_name;
    setRootAgentForm({
      mode: "edit",
      source: agent.location ?? "cloud",
      namespace: agent.owner_type === "user" ? "default" : agent.owner_id,
      ownerLabel,
      teamId: agent.team_id,
    });
  };
  let content: React.ReactNode;
  if (state.loading && !isDevicePage && !isStandInPage) {
    content = (
      <ProjectLoadingSkeleton
        label={translate("common.loading", "正在加载…")}
        layout={
          host.location.projectId && host.location.projectView === "board"
            ? "board"
            : "list"
        }
      />
    );
  } else if (state.error && !isDevicePage && !isStandInPage) {
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
          initialProject={selectedProject ?? undefined}
          issueArchiveEnabled
          locale={locale}
          onProjectChange={commands.registerProject}
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
              projectSettingsSection: host.location.projectSettingsSection,
            },
            navigate: (location) =>
              navigateWithin(host, {
                projectId: location.projectId,
                issueId: location.issueId,
                projectView: location.view,
                projectSettingsSection: location.projectSettingsSection,
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
            defaultAssistant: host.defaultAssistant,
          }}
          onCreateTask={onCreateTask}
        />
      );
  } else if (host.location.projectId) {
    // Opening one project holds the frame instead of painting the workspace
    // home while the project's workspace is still on its way.
    content = (
      <div
        className="collaboration-platform-panel flex min-h-32 items-center justify-center p-6 text-sm text-text-secondary"
        data-testid="collaboration-platform-opening-project"
        role="status"
      >
        {messages.loading}
      </div>
    );
  } else if (
    !state.workspace ||
    isDevicePage ||
    host.location.rootView === "stand-in"
  ) {
    const rootView = host.location.rootView ?? "home";
    const inboxItems = state.myWork.filter((item) => {
      const operation = workspaceIssueOperationState(item);
      return item.is_unread || operation === "failed" || operation === "review";
    });
    content =
      rootView === "templates" && host.templateStore ? (
        <CollaborationTemplatePage
          key={host.templateStore.library.scope}
          store={host.templateStore}
          locale={locale}
          onUse={(record) => {
            setProjectTemplate(record.document);
            startProjectCreation("blank");
          }}
        />
      ) : rootView === "stand-in" && host.renderStandInPage ? (
        host.renderStandInPage({
          projects: state.navigationProjects,
          onClose: () =>
            host.navigate({
              ...host.location,
              rootView: "home",
              workspaceId: null,
              projectId: null,
              issueId: null,
            }),
        })
      ) : rootView === "agents" ||
        rootView === "teams" ||
        rootView === "devices" ? (
        <ResourceCatalogPage
          api={api}
          domain={collaborationDomain}
          cloudAccess={host.cloudAccess}
          kind={rootView}
          agents={state.resources.agents}
          groups={state.collaborationGroups}
          environments={
            rootView === "devices"
              ? deviceCatalog.items
              : state.resources.execution_environments
          }
          deviceCatalog={rootView === "devices" ? deviceCatalog : undefined}
          translate={translate}
          canCreateDevice={Boolean(host.renderDeviceCreator)}
          workspaces={state.workspaces}
          projects={state.navigationProjects}
          ownerOptions={host.workspaceOwnerOptions}
          messages={messages}
          onAddToWorkspace={bindRootResource}
          onCreateAgent={(ownerOptions) =>
            setRootAgentForm({
              mode: "create",
              source: "cloud",
              namespace: "default",
              ownerLabel:
                ownerOptions.find((owner) => owner.namespace === "default")
                  ?.label ?? messages.personalOwner,
              ownerOptions,
            })
          }
          onCreateDevice={(source, workspaceId) =>
            setRootDeviceCreator({ source, workspaceId })
          }
          onCreateLocalAgent={() =>
            setRootAgentForm({
              mode: "create",
              source: "local",
              namespace: "default",
              ownerLabel: messages.localWorkspaceResource,
            })
          }
          onCreateTeam={(workspaceId) => {
            setRootTeamEditingId(undefined);
            setRootTeamCreationWorkspaceId(workspaceId);
          }}
          onDeleteAgent={async (agent) => {
            if (!api.resources?.removeAgent) {
              throw new Error(messages.deleteFailed);
            }
            await api.resources.removeAgent(agent);
            await commands.reload();
          }}
          onDeleteTeam={async (group) => {
            if (group.owner_type === "project") {
              if (!api.projects.removeCollaborationGroup) {
                throw new Error(messages.deleteFailed);
              }
              await api.projects.removeCollaborationGroup(
                group.owner_id,
                group.id,
              );
            } else {
              if (!api.workspaces) {
                throw new Error(messages.deleteFailed);
              }
              await api.workspaces.removeCollaborationGroup(
                group.workspace_id,
                group.id,
              );
            }
            await commands.reload();
          }}
          onManageResource={manageRootResource}
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
        <div
          className={
            host.renderIssueComposer && domainProjects.length
              ? "collaboration-task-home-page"
              : "collaboration-platform-page collaboration-home-page"
          }
        >
          {!domainWorkspaces.length ? (
            <>
              <PageHeader
                title={messages.issueHomeTitle}
                subtitle={messages.issueHomeHint}
              />
              <EmptyState
                title={messages.noSpaces}
                description={messages.noSpacesHint}
                action={
                  canCreateCloudWorkspace ? (
                    <button
                      type="button"
                      className="collaboration-primary-button"
                      onClick={() => {
                        setCreateProjectAfterWorkspace(false);
                        setWorkspaceDialogOpen(true);
                      }}
                    >
                      {messages.createWorkspace}
                    </button>
                  ) : null
                }
              />
            </>
          ) : !domainProjects.length ? (
            <FirstProjectStarter
              messages={messages}
              supportsLocalImport={Boolean(
                host.renderProjectImporter &&
                domainWorkspaces.some(
                  (workspace) => workspace.location === "local",
                ),
              )}
              onCreate={startProjectCreation}
            />
          ) : (
            <IssueHomeLauncher
              renderTaskComposer={host.renderIssueComposer}
              api={api}
              locale={locale}
              messages={messages}
              projects={domainProjects}
              selectedProjectId={rootIssueProject?.id ?? ""}
              workspaces={domainWorkspaces}
              onSelectProject={setRootIssueProjectId}
              pending={rootIssueLoading}
              onCreateIssue={(
                content,
                memberIds,
                files,
                standInDeviceId,
                standInId,
              ) =>
                startRootIssueCreation(
                  content,
                  memberIds,
                  files,
                  standInDeviceId,
                  standInId,
                )
              }
              onOpenExecutionEnvironments={(project) =>
                navigateWithin(host, {
                  workspaceId: project.workspace_id ?? null,
                  workspaceView: "projects",
                  projectId: project.id,
                  projectView: "manage",
                  projectSettingsSection: "environments",
                  issueId: null,
                })
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
      requestedWorkspaceSettingsView === "members" &&
      workspace.location !== "local"
        ? "members"
        : requestedWorkspaceSettingsView === "collaboration-groups"
          ? "groups"
          : "agents";
    const usesProjectImporter =
      workspace.location === "local" && Boolean(host.renderProjectImporter);
    const createProjectAction = (
      <ProjectCreationAction
        className="collaboration-primary-button inline-flex items-center gap-1.5"
        messages={messages}
        onSelect={(mode) => openWorkspaceProjectCreator(workspace.id, mode)}
        supportsLocalImport={usesProjectImporter}
        testId="collaboration-workspace-project-create"
      />
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
                  <WorkspaceGroupsPanel
                    key={workspace.id}
                    api={api}
                    workspace={workspace}
                    translate={translate}
                    locale={locale}
                    currentUserId={host.currentUser?.id}
                    commands={commands}
                    initialCreateOpen={workspaceGroupCreationRequested}
                    onCreateOpenChange={(open) => {
                      if (!open) setWorkspaceGroupCreationRequested(false);
                    }}
                  />
                }
                groupsLabel={messages.collaborationGroups}
                initialTab={initialWorkspaceParticipantTab}
                membersContent={
                  workspace.location === "cloud" ? (
                    <WorkspaceMembersPanel
                      key={workspace.id}
                      api={api}
                      workspace={workspace}
                      translate={translate}
                      locale={locale}
                      commands={commands}
                    />
                  ) : undefined
                }
                membersLabel={
                  workspace.location === "cloud" ? messages.members : undefined
                }
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
                <h2>
                  {usesProjectImporter
                    ? messages.firstLocalProjectTitle
                    : messages.firstProjectTitle}
                </h2>
                <p>
                  {usesProjectImporter
                    ? messages.firstLocalProjectHint
                    : messages.firstProjectHint}
                </p>
                <div>
                  <ProjectCreationAction
                    className="collaboration-primary-button"
                    messages={messages}
                    onSelect={(mode) =>
                      openWorkspaceProjectCreator(workspace.id, mode)
                    }
                    supportsLocalImport={usesProjectImporter}
                    testId="collaboration-workspace-starter-create-project"
                  />
                  <button
                    type="button"
                    className="collaboration-platform-secondary-button"
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
                  {workspace.location === "cloud" ? (
                    <button
                      type="button"
                      className="collaboration-platform-secondary-button"
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
                  ) : null}
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
      domain={collaborationDomain}
      host={host}
      messages={messages}
      workspaces={state.workspaces}
      workspaceNavigationContext={state.workspaceNavigationContext}
      projects={state.navigationProjects}
      navigationIncomplete={state.navigationIncomplete}
      onRetryNavigation={commands.reload}
      canCreateWorkspace={canCreateCloudWorkspace}
      onCreateWorkspace={() => {
        setCreateProjectAfterWorkspace(false);
        setWorkspaceDialogOpen(true);
      }}
      onCreateProject={openWorkspaceProjectCreator}
      onArchiveProject={setArchiveProject}
      onNewConversation={(projectId) => {
        setRootIssueProjectId(projectId);
        host.navigate({
          platformView: "spaces",
          collaborationDomain,
          rootView: "home",
          workspaceId: null,
          workspaceView: "home",
          projectId: null,
          projectView: "board",
          issueId: null,
        });
      }}
      footer={sidebarFooter}
    />
  );
  const main = (
    <main className="collaboration-platform-main">
      {standInRetry && (
        <div
          role="alert"
          data-testid="stand-in-run-error"
          className="flex items-center gap-2 p-3 text-sm text-text-secondary"
        >
          <span>
            {createCollaborationTranslator(locale)("standIn.start_failed")}{" "}
            {standInRetry.error}
          </span>
          <button
            type="button"
            data-testid="stand-in-run-retry"
            disabled={standInRetrying}
            onClick={async () => {
              if (!api.standIn?.run) return;
              setStandInRetrying(true);
              const remainingFiles = [...standInRetry.files];
              try {
                while (remainingFiles.length) {
                  await api.attachments.upload(
                    standInRetry.issueId,
                    remainingFiles[0],
                  );
                  remainingFiles.shift();
                }
                await api.standIn.run(
                  standInRetry.projectId,
                  standInRetry.issueId,
                  standInRetry.deviceId,
                  standInRetry.standInId,
                );
                setStandInRetry(null);
              } catch (error) {
                setStandInRetry({
                  ...standInRetry,
                  files: remainingFiles,
                  error: error instanceof Error ? error.message : String(error),
                });
              } finally {
                setStandInRetrying(false);
              }
            }}
            className="shrink-0 rounded-md px-2 py-1 hover:bg-muted"
          >
            {createCollaborationTranslator(locale)("standIn.retry")}
          </button>
        </div>
      )}
      {content}
      {archiveProject && (
        <ProjectArchiveDialog
          project={archiveProject}
          locale={locale}
          onClose={() => setArchiveProject(null)}
          onArchive={async () => {
            await commands.archiveProject(archiveProject);
            if (host.location.projectId === archiveProject.id)
              host.navigate({
                platformView: "spaces",
                workspaceId: archiveProject.workspace_id ?? null,
                workspaceView: "projects",
                projectId: null,
                projectView: "board",
                issueId: null,
              });
          }}
        />
      )}
    </main>
  );

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
          onClose={() => {
            setWorkspaceDialogOpen(false);
            setCreateProjectAfterWorkspace(false);
          }}
          onCreate={async (input) => {
            const workspace = await commands.createWorkspace(input);
            setWorkspaceDialogOpen(false);
            if (createProjectAfterWorkspace) {
              setCreateProjectAfterWorkspace(false);
              setProjectWorkspaceId(workspace.id);
              setProjectDialogOpen(true);
              return;
            }
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
          workspaces={domainWorkspaces}
          cloudAccess={host.cloudAccess}
          canCreateCloudWorkspace={canCreateCloudWorkspace}
          onClose={() => {
            setWorkspacePickerOpen(false);
            setProjectTemplate(null);
          }}
          onCreateCloudWorkspace={() => {
            setWorkspacePickerOpen(false);
            setCreateProjectAfterWorkspace(true);
            setWorkspaceDialogOpen(true);
          }}
          onSelect={(workspaceId) => {
            setWorkspacePickerOpen(false);
            openWorkspaceProjectCreator(workspaceId, pendingProjectMode);
          }}
        />
      ) : null}
      {projectImporterWorkspace && host.renderProjectImporter
        ? host.renderProjectImporter({
            workspace: projectImporterWorkspace,
            mode: projectImporter?.mode ?? "folder",
            projects: state.navigationProjects.filter(
              (project) => project.workspace_id === projectImporterWorkspace.id,
            ),
            onClose: () => setProjectImporter(null),
            onImported: async (project) => {
              setProjectImporter(null);
              commands.registerProject(project);
              openProject(project);
            },
          })
        : null}
      {projectDialogOpen && projectWorkspaceId ? (
        <ProjectCreateDialog
          initialTemplate={projectTemplate}
          targets={[
            {
              location: projectCreateLocation,
              create: (input) =>
                commands.createProject(input, projectWorkspaceId),
            },
          ]}
          defaultLocation={projectCreateLocation}
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
            projectWorkspace
              ? {
                  location: projectWorkspace.location,
                  currentUser: host.currentUser ?? {
                    id: projectWorkspace.created_by_user_id,
                    name: projectCreateLabels[locale].currentUser,
                  },
                  members: projectWorkspaceMembers,
                  agents: selectedProjectResourceAgents,
                  defaultAgentResourceIds: defaultProjectAgentResourceIds,
                  groups: projectWorkspaceGroups,
                  executionEnvironments: state.resources.execution_environments,
                  loadCollaborationGroupGenerationModels:
                    host.loadProjectCollaborationGroupGenerationModels,
                  generateCollaborationGroupDraft:
                    host.generateProjectCollaborationGroupDraft,
                  configure: async (project, selection) => {
                    const existingMembers = await api.members.list(project.id);
                    const existingMemberIds = new Set(
                      existingMembers.map((member) => member.user_id),
                    );
                    const selectedAgents = selectedProjectResourceAgents.filter(
                      (agent) => selection.agentResourceIds.includes(agent.id),
                    );
                    const sharedDeviceIds = new Set<number>(
                      projectWorkspace.location === "cloud" &&
                        selection.executionEnvironmentDeviceIds.length
                        ? (
                            await api.workspaces!.listExecutionEnvironments(
                              projectWorkspace.id,
                            )
                          ).flatMap((environment) =>
                            environment.device_id == null
                              ? []
                              : [environment.device_id],
                          )
                        : [],
                    );
                    await Promise.all([
                      ...selection.memberUserIds
                        .filter((userId) => !existingMemberIds.has(userId))
                        .map((userId) =>
                          api.members.add(project.id, userId, "Developer"),
                        ),
                      ...selection.executionEnvironmentDeviceIds.map(
                        async (deviceId) => {
                          if (projectWorkspace.location === "cloud") {
                            await ensureWorkspaceEnvironmentSharing(
                              api,
                              projectWorkspace.id,
                              deviceId,
                              sharedDeviceIds,
                            );
                          }
                          return api.projects.addExecutionEnvironment(
                            project.id,
                            deviceId,
                          );
                        },
                      ),
                    ]);
                    const selectedDefaultAgent = selectedAgents.find(
                      isCurrentDeviceCollaborationAgent,
                    );
                    const projectDefaultAgent = selectedDefaultAgent
                      ? (await api.agents.list(project.id)).find(
                          isCurrentDeviceCollaborationAgent,
                        )
                      : undefined;
                    const createdAgents = [
                      ...(selectedDefaultAgent && projectDefaultAgent
                        ? [
                            {
                              resourceId: selectedDefaultAgent.id,
                              projectAgent: projectDefaultAgent,
                            },
                          ]
                        : []),
                      ...(await Promise.all(
                        selectedAgents
                          .filter(
                            (agent) =>
                              agent.id !== selectedDefaultAgent?.id ||
                              !projectDefaultAgent,
                          )
                          .map(async (agent) => ({
                            resourceId: agent.id,
                            projectAgent: await api.agents.create(
                              project.id,
                              createResourceAgentBindingInput(agent),
                            ),
                          })),
                      )),
                    ];
                    for (const rawGroupDraft of selection.collaborationGroupDrafts) {
                      const groupDraft =
                        normalizeCollaborationGroupDraftForPersistence(
                          rawGroupDraft,
                        );
                      if (!api.projects.createCollaborationGroup) {
                        throw new Error(
                          locale === "zh-CN"
                            ? "当前项目不支持创建协作小组"
                            : "This project does not support collaboration groups",
                        );
                      }
                      const mapParticipant = (
                        participant: typeof groupDraft.leader,
                      ) => {
                        if (participant.kind === "human") {
                          return participant;
                        }
                        const projectAgent = createdAgents.find(
                          ({ resourceId }) => resourceId === participant.id,
                        )?.projectAgent;
                        if (!projectAgent) {
                          throw new Error(
                            locale === "zh-CN"
                              ? "协作小组中的智能体未成功加入项目"
                              : "An Agent in the group was not added to the project",
                          );
                        }
                        return {
                          ...participant,
                          id: String(projectAgent.id),
                        };
                      };
                      const leader = mapParticipant(groupDraft.leader);
                      if (!leader.id) {
                        throw new Error(
                          locale === "zh-CN"
                            ? "负责人不在当前协作成员中"
                            : "The owner is not a current collaborator",
                        );
                      }
                      await api.projects.createCollaborationGroup(project.id, {
                        name: groupDraft.name,
                        description: groupDraft.description,
                        instructions: groupDraft.instructions,
                        leader,
                        members: groupDraft.members.map(mapParticipant),
                        coordinationMode: "manager",
                        stages: groupDraft.stages.map((stage) => ({
                          ...stage,
                          assignee: stage.assignee
                            ? mapParticipant(stage.assignee)
                            : null,
                        })),
                        executionRequirements: groupDraft.executionRequirements,
                      });
                    }
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
            setProjectTemplate(null);
            setProjectWorkspaceId(null);
          }}
          onCreated={(project) => {
            setProjectDialogOpen(false);
            setProjectTemplate(null);
            setProjectWorkspaceId(null);
            openProject(project);
          }}
        />
      ) : null}
      {rootAgentForm?.mode === "create" &&
      rootAgentForm.source === "local" &&
      host.projectAgentConfiguration?.renderLocalAgentCreator
        ? host.projectAgentConfiguration.renderLocalAgentCreator({
            onClose: () => setRootAgentForm(null),
            onCreated: async () => {
              setRootAgentForm(null);
              await commands.reload();
              setProjectResourceRefreshKey((value) => value + 1);
              host.notify?.(messages.resourceSaved, "success");
            },
          })
        : null}
      {rootAgentForm?.mode === "create" &&
      rootAgentForm.source === "cloud" &&
      host.projectAgentConfiguration?.renderAgentCreator
        ? host.projectAgentConfiguration.renderAgentCreator({
            namespace: rootAgentForm.namespace,
            ownerOptions: rootAgentForm.ownerOptions,
            workspaceName: rootAgentForm.ownerLabel,
            onClose: () => setRootAgentForm(null),
            onCreated: async () => {
              setRootAgentForm(null);
              await commands.reload();
              setProjectResourceRefreshKey((value) => value + 1);
              host.notify?.(messages.resourceSaved, "success");
            },
          })
        : null}
      {rootAgentForm?.mode === "edit" &&
      rootAgentForm.source === "local" &&
      host.projectAgentConfiguration?.renderLocalAgentEditor
        ? host.projectAgentConfiguration.renderLocalAgentEditor({
            resourceId: rootAgentForm.resourceId ?? "",
            onClose: () => setRootAgentForm(null),
            onSaved: async () => {
              setRootAgentForm(null);
              await commands.reload();
              host.notify?.(messages.resourceSaved, "success");
            },
          })
        : null}
      {rootDeviceCreator && host.renderDeviceCreator
        ? host.renderDeviceCreator({
            source: rootDeviceCreator.source,
            workspaceId: rootDeviceCreator.workspaceId,
            hasCloudDevice: deviceCatalog.items.some(
              (environment) => environment.kind === "cloud_host",
            ),
            onClose: () => setRootDeviceCreator(null),
            onCreated: async (deviceId) => {
              if (deviceId && rootDeviceCreator.workspaceId && api.workspaces) {
                await api.workspaces.addExecutionEnvironment(
                  rootDeviceCreator.workspaceId,
                  {
                    deviceId,
                  },
                );
              }
              setRootDeviceCreator(null);
              await deviceCatalog.refresh();
              await commands.reload();
              host.notify?.(messages.resourceSaved, "success");
            },
          })
        : null}
      {rootTeamCreationWorkspaceId
        ? (() => {
            const workspace = state.workspaces.find(
              (candidate) => candidate.id === rootTeamCreationWorkspaceId,
            );
            if (!workspace) return null;
            return (
              <RootTeamEditor
                key={rootTeamEditingId ?? "create"}
                groupId={rootTeamEditingId}
                api={api}
                host={host}
                workspace={workspace}
                groups={state.collaborationGroups.filter(
                  (group) => group.workspace_id === workspace.id,
                )}
                locale={locale}
                onClose={() => setRootTeamCreationWorkspaceId(null)}
                onCreated={async () => {
                  setRootTeamCreationWorkspaceId(null);
                  await commands.reload();
                  host.notify?.(messages.resourceSaved, "success");
                }}
              />
            );
          })()
        : null}
      {rootAgentForm?.mode === "edit" &&
      rootAgentForm.source === "cloud" &&
      rootAgentForm.teamId &&
      host.projectAgentConfiguration?.renderAgentEditor
        ? host.projectAgentConfiguration.renderAgentEditor({
            agent: { teamId: rootAgentForm.teamId },
            namespace: rootAgentForm.namespace,
            workspaceName: rootAgentForm.ownerLabel,
            onClose: () => setRootAgentForm(null),
            onSaved: async () => {
              setRootAgentForm(null);
              await commands.reload();
              host.notify?.(messages.resourceSaved, "success");
            },
          })
        : null}
    </section>
  );
}

function WorkspaceProjectPicker({
  messages,
  workspaces,
  cloudAccess,
  canCreateCloudWorkspace,
  onClose,
  onCreateCloudWorkspace,
  onSelect,
}: {
  messages: PlatformMessages;
  workspaces: CollaborationWorkspace[];
  cloudAccess: CollaborationPlatformHostAdapter["cloudAccess"];
  canCreateCloudWorkspace: boolean;
  onClose(): void;
  onCreateCloudWorkspace(): void;
  onSelect(workspaceId: string): void;
}) {
  const hasCloudWorkspace = workspaces.some(
    (workspace) => workspace.location === "cloud",
  );
  const showCloudEntry = canCreateCloudWorkspace && !hasCloudWorkspace;
  const cloudLoginRequired = cloudAccess && !cloudAccess.authenticated;
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
          {showCloudEntry ? (
            <button
              type="button"
              data-testid={
                cloudLoginRequired
                  ? "collaboration-project-workspace-cloud-login"
                  : "collaboration-project-workspace-cloud-create"
              }
              onClick={
                cloudLoginRequired
                  ? cloudAccess.requestLogin
                  : onCreateCloudWorkspace
              }
            >
              <span className="collaboration-project-card-mark">
                <Cloud aria-hidden="true" />
              </span>
              <span>
                <strong>
                  {cloudLoginRequired
                    ? messages.loginForCloudProject
                    : messages.createWorkspace}
                </strong>
                <small>
                  {cloudLoginRequired
                    ? messages.loginForCloudProjectHint
                    : messages.cloudStorageNotice}
                </small>
              </span>
              <ChevronRight aria-hidden="true" />
            </button>
          ) : null}
        </div>
      </section>
    </div>
  );
}
