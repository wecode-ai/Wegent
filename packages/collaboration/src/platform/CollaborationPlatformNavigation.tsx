// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import {
  Bot,
  ChevronRight,
  Ellipsis,
  FolderOpen,
  FolderPlus,
  Monitor,
  Plus,
  Settings,
  SquarePen,
  UsersRound,
  UserRound,
} from "lucide-react";
import { ActionMenu } from "../controls/ActionMenu";
import { Tooltip } from "../issue-detail/Tooltip";
import { StandInIcon } from "../StandInIcon";
import { canAccessCollaborationProjectView } from "../permissions";
import type {
  CollaborationProject,
  CollaborationWorkspace,
  CollaborationWorkspaceNavigationContext,
} from "../types";
import type {
  CollaborationDomain,
  CollaborationPlatformHostAdapter,
} from "./types";
import type { PlatformMessages } from "./platformMessages";
import { buildWorkspaceNavigation } from "./workspaceNavigation";

export function CollaborationPlatformNavigation({
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
  onCreateStandaloneProject,
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
  onCreateStandaloneProject(location: CollaborationDomain): void;
  onNewConversation(project: CollaborationProject): void;
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
  const autoExpandedWorkspaceId =
    selectedWorkspaceId ?? navigationWorkspaces[0]?.workspace.id ?? null;
  const [workspaceExpansion, setWorkspaceExpansion] = useState<
    Map<string, boolean>
  >(
    () =>
      new Map(autoExpandedWorkspaceId ? [[autoExpandedWorkspaceId, true]] : []),
  );
  const [autoExpandedWorkspaceSelection, setAutoExpandedWorkspaceSelection] =
    useState<string | null>(autoExpandedWorkspaceId);
  const projectFirst = host.capabilities.projectNavigation === "projects";
  const [workspacesExpanded, setWorkspacesExpanded] = useState(true);
  const [retryingNavigation, setRetryingNavigation] = useState(false);
  const fullSidebar = host.capabilities.sidebarPresentation !== "context";
  // Expansion follows the selected workspace during render so it cannot land
  // after the user has already clicked the toggle that was just rendered.
  if (autoExpandedWorkspaceSelection !== autoExpandedWorkspaceId) {
    setAutoExpandedWorkspaceSelection(autoExpandedWorkspaceId);
    if (autoExpandedWorkspaceId) {
      setWorkspaceExpansion((current) => {
        if (current.get(autoExpandedWorkspaceId) === true) return current;
        const next = new Map(current);
        next.set(autoExpandedWorkspaceId, true);
        return next;
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
    setWorkspaceExpansion((current) => {
      const next = new Map(current);
      next.set(workspaceId, !(current.get(workspaceId) ?? projectFirst));
      return next;
    });
  };
  const localWorkspace = workspaces.find(
    (workspace) => workspace.location === "local",
  );
  const createWorkspaceButton = canCreateWorkspace ? (
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
  ) : null;
  const renderWorkspaceActions = (
    candidate: ReturnType<
      typeof buildWorkspaceNavigation
    >["workspaces"][number]["workspace"],
  ) => (
    <ActionMenu
      ariaLabel={messages.settings}
      icon={Ellipsis}
      items={[
        {
          label: messages.addProject,
          icon: Plus,
          testId: "collaboration-workspace-nav-create-project",
          children: [
            {
              label: messages.blankProject,
              icon: SquarePen,
              testId: "collaboration-workspace-nav-create-blank-project",
              onSelect: () => onCreateProject(candidate.id, "blank"),
            },
            ...(candidate.location === "local" && host.renderProjectImporter
              ? [
                  {
                    label: messages.addFolder,
                    icon: FolderPlus,
                    testId: "collaboration-workspace-nav-add-folder",
                    onSelect: () => onCreateProject(candidate.id, "folder"),
                  },
                  {
                    label: messages.importExistingProject,
                    icon: FolderOpen,
                    testId:
                      "collaboration-workspace-nav-import-existing-project",
                    onSelect: () => onCreateProject(candidate.id, "existing"),
                  },
                ]
              : []),
          ],
        },
        {
          separator: true,
          label: "",
          testId: "collaboration-workspace-nav-project-separator",
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
  );
  const renderWorkspaceGroup = ({
    workspace: candidate,
    canOpen,
  }: ReturnType<typeof buildWorkspaceNavigation>["workspaces"][number]) => {
    const expanded = workspaceExpansion.get(candidate.id) ?? projectFirst;
    const candidateProjects = projectsByWorkspace.get(candidate.id) ?? [];
    const workspaceActive =
      host.location.workspaceId === candidate.id && !host.location.projectId;
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
              {renderWorkspaceActions(candidate)}
            </div>
          ) : null}
          {candidateProjects.length > 0 ? (
            <button
              type="button"
              className="collaboration-workspace-toggle"
              aria-expanded={expanded}
              aria-label={
                expanded ? messages.collapseWorkspace : messages.expandWorkspace
              }
              data-testid={`collaboration-workspace-toggle-${candidate.id}`}
              onClick={() => toggleWorkspace(candidate.id)}
            >
              <ChevronRight aria-hidden="true" />
            </button>
          ) : null}
        </div>
        {expanded ? (
          <nav
            className="collaboration-workspace-project-list"
            aria-label={`${candidate.name} · ${messages.projects}`}
          >
            {candidateProjects.map((project) => (
              <ProjectNavigationRow
                key={project.id}
                project={project}
                host={host}
                messages={messages}
                onNewConversation={onNewConversation}
                onArchiveProject={onArchiveProject}
              />
            ))}
          </nav>
        ) : null}
      </section>
    );
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
              {host.renderPersonalHome ? <UserRound aria-hidden="true" /> : <Plus aria-hidden="true" />}
              <span>{host.renderPersonalHome ? messages.personalHome : messages.home}</span>
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
          </nav>
        </>
      ) : null}
      {!projectFirst ? (
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
          <div className="collaboration-workspace-section-actions">
            {createWorkspaceButton}
          </div>
        </div>
      ) : null}
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
      {projectFirst
        ? (["local", "cloud"] as const).map((location) => (
            <section
              key={location}
              className={`collaboration-project-group-${location}`}
              data-testid={`collaboration-project-group-${location}`}
            >
              <div
                data-testid={
                  location === "local" && localWorkspace
                    ? `collaboration-workspace-tree-${localWorkspace.id}`
                    : undefined
                }
              >
                <div className="collaboration-workspace-section-heading">
                  {location === "local" && localWorkspace ? (
                    <button
                      type="button"
                      className="collaboration-workspace-identity collaboration-local-projects-heading"
                      data-testid={
                        host.location.workspaceId === localWorkspace.id
                          ? "collaboration-workspace-nav-projects"
                          : `collaboration-workspace-home-${localWorkspace.id}`
                      }
                      aria-current={
                        host.location.workspaceId === localWorkspace.id &&
                        !host.location.projectId
                          ? "page"
                          : undefined
                      }
                      onClick={() =>
                        openWorkspaceHome(localWorkspace.id, "local")
                      }
                    >
                      <span
                        data-testid={`collaboration-workspace-${localWorkspace.id}`}
                      >
                        {messages.localProjects}
                      </span>
                    </button>
                  ) : (
                    <span className="collaboration-workspace-section-title">
                      {location === "local"
                        ? messages.localProjects
                        : messages.remoteProjects}
                    </span>
                  )}
                  <div className="collaboration-workspace-section-actions">
                    {location === "cloud" ? createWorkspaceButton : null}
                    {location === "local" &&
                    localWorkspace &&
                    ["Owner", "Maintainer"].includes(localWorkspace.access_role)
                      ? renderWorkspaceActions(localWorkspace)
                      : null}
                    <button
                      type="button"
                      className="collaboration-workspace-section-create"
                      aria-label={
                        location === "local"
                          ? messages.createLocalProject
                          : messages.createRemoteProject
                      }
                      title={
                        location === "local"
                          ? messages.createLocalProject
                          : messages.createRemoteProject
                      }
                      data-testid={`collaboration-project-create-${location}`}
                      onClick={() => onCreateStandaloneProject(location)}
                      disabled={
                        location === "local" &&
                        !workspaces.some(
                          (workspace) => workspace.location === "local",
                        )
                      }
                    >
                      <Plus aria-hidden="true" />
                    </button>
                  </div>
                </div>
                <nav
                  className="collaboration-workspace-project-list"
                  aria-label={
                    location === "local"
                      ? messages.localProjects
                      : messages.remoteProjects
                  }
                >
                  {projects
                    .filter(
                      (project) =>
                        (location === "local" ||
                          !project.workspace_id ||
                          !navigationWorkspaces.some(
                            ({ workspace }) =>
                              workspace.id === project.workspace_id,
                          )) &&
                        (project.project_store === "local"
                          ? "local"
                          : "cloud") === location,
                    )
                    .map((project) => (
                      <ProjectNavigationRow
                        key={project.id}
                        project={project}
                        host={host}
                        messages={messages}
                        onNewConversation={onNewConversation}
                        onArchiveProject={onArchiveProject}
                      />
                    ))}
                </nav>
                <div className="collaboration-workspace-tree">
                  {navigationWorkspaces
                    .filter(
                      ({ workspace }) =>
                        location === "cloud" && workspace.location === "cloud",
                    )
                    .map(renderWorkspaceGroup)}
                </div>
              </div>
            </section>
          ))
        : null}
      {!projectFirst && (fullSidebar || workspacesExpanded) ? (
        <div className="collaboration-workspace-tree">
          {navigationWorkspaces.map(renderWorkspaceGroup)}
        </div>
      ) : null}
      {footer ? (
        <div className="collaboration-platform-sidebar-footer">{footer}</div>
      ) : null}
    </aside>
  );
}

function ProjectNavigationRow({
  project,
  host,
  messages,
  onNewConversation,
  onArchiveProject,
}: {
  project: CollaborationProject;
  host: CollaborationPlatformHostAdapter;
  messages: PlatformMessages;
  onNewConversation(project: CollaborationProject): void;
  onArchiveProject(project: CollaborationProject): void;
}) {
  return (
    <div className="collaboration-workspace-project-row" key={project.id}>
      <button
        type="button"
        className={`collaboration-workspace-project${
          host.location.projectId === project.id ? " active" : ""
        }`}
        aria-current={
          host.location.projectId === project.id ? "page" : undefined
        }
        title={project.name}
        data-testid={`collaboration-workspace-project-${project.id}`}
        onClick={() =>
          host.navigate({
            platformView: "spaces",
            workspaceId: project.workspace_id ?? null,
            collaborationDomain:
              project.project_store === "local" ? "local" : "cloud",
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
            onClick={() => onNewConversation(project)}
          >
            <SquarePen aria-hidden="true" />
          </button>
        </Tooltip>
        {canAccessCollaborationProjectView(project, "manage") && (
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
  );
}
