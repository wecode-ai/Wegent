// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { useMemo, useState } from "react";
import {
  CloudOff,
  ChevronRight,
  Ellipsis,
  FolderOpen,
  FolderPlus,
  Plus,
  Settings,
  SquarePen,
} from "lucide-react";
import { ActionMenu } from "../controls/ActionMenu";
import {
  CollaborationPrimaryNavigation,
  CollaborationManagementNavigation,
} from "./CollaborationPrimaryNavigation";
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
  onArchiveProject(project: CollaborationProject): void;
  footer?: React.ReactNode;
}) {
  const { workspaces: navigationWorkspaces, projectsByWorkspace } = useMemo(
    () =>
      buildWorkspaceNavigation(
        workspaces,
        projects,
        workspaceNavigationContext,
        host.capabilities.projectNavigation === "projects"
          ? messages.defaultProjectWorkspace
          : undefined,
      ),
    [
      projects,
      workspaces,
      workspaceNavigationContext,
      host.capabilities.projectNavigation,
      messages.defaultProjectWorkspace,
    ],
  );
  const selectedProjectWorkspaceId = [...projectsByWorkspace].find(
    ([, items]) =>
      items.some((project) => project.id === host.location.projectId),
  )?.[0];
  const selectedWorkspaceId =
    selectedProjectWorkspaceId ?? host.location.workspaceId ?? null;
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
  const allowLocalProjects =
    host.capabilities.workspaceLocations?.includes("local") ?? true;
  const localWorkspace = workspaces.find(
    (workspace) => allowLocalProjects && workspace.location === "local",
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
    isDefault = false,
    canOpen = true,
  ) => (
    <ActionMenu
      ariaLabel={messages.settings}
      icon={Ellipsis}
      items={[
        {
          label: messages.addProject,
          icon: Plus,
          testId: "collaboration-workspace-nav-create-project",
          disabled:
            isDefault &&
            (host.capabilities.projectLocation ?? domain) === "local" &&
            !localWorkspace,
          ...(isDefault
            ? {
                onSelect: () =>
                  onCreateStandaloneProject(
                    host.capabilities.projectLocation ?? domain,
                  ),
              }
            : {
                children: [
                  {
                    label: messages.blankProject,
                    icon: SquarePen,
                    testId: "collaboration-workspace-nav-create-blank-project",
                    onSelect: () => onCreateProject(candidate.id, "blank"),
                  },
                  ...(candidate.location === "local" &&
                  localWorkspace &&
                  host.renderProjectImporter
                    ? [
                        {
                          label: messages.addFolder,
                          icon: FolderPlus,
                          testId: "collaboration-workspace-nav-add-folder",
                          onSelect: () =>
                            onCreateProject(localWorkspace!.id, "folder"),
                        },
                        {
                          label: messages.importExistingProject,
                          icon: FolderOpen,
                          testId:
                            "collaboration-workspace-nav-import-existing-project",
                          onSelect: () =>
                            onCreateProject(localWorkspace!.id, "existing"),
                        },
                      ]
                    : []),
                ],
              }),
        },
        ...(canOpen
          ? [
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
                    collaborationDomain: candidate.location,
                    workspaceView: "settings",
                    projectId: null,
                    projectView: "board",
                    issueId: null,
                  });
                },
              },
            ]
          : []),
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
    isDefault,
  }: ReturnType<typeof buildWorkspaceNavigation>["workspaces"][number]) => {
    const expanded = workspaceExpansion.get(candidate.id) ?? projectFirst;
    const candidateProjects = projectsByWorkspace.get(candidate.id) ?? [];
    const workspaceActive =
      host.location.workspaceId === candidate.id && !host.location.projectId;
    const canManageWorkspace =
      isDefault ||
      (canOpen &&
        "access_role" in candidate &&
        (candidate.access_role === "Owner" ||
          candidate.access_role === "Maintainer"));
    return (
      <section
        className="collaboration-workspace-group"
        data-testid={`collaboration-workspace-tree-${candidate.id}`}
        key={isDefault ? "personal-group" : candidate.id}
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
              {renderWorkspaceActions(candidate, isDefault, canOpen)}
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
          <CollaborationPrimaryNavigation
            domain={domain}
            host={host}
            messages={messages}
          />
        </>
      ) : null}
      <div
        className="collaboration-projects-scroll"
        data-testid="collaboration-projects-scroll"
      >
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
        {projectFirst ? (
          <>
            <div className="collaboration-workspace-section-heading">
              <span className="collaboration-workspace-section-title">
                {messages.projects}
              </span>
              <div className="collaboration-workspace-section-actions">
                {createWorkspaceButton}
              </div>
            </div>
            <div
              className="collaboration-workspace-tree"
              data-testid="collaboration-project-tree"
            >
              {navigationWorkspaces.map(renderWorkspaceGroup)}
            </div>
          </>
        ) : null}
        {!projectFirst && (fullSidebar || workspacesExpanded) ? (
          <div className="collaboration-workspace-tree">
            {navigationWorkspaces.map(renderWorkspaceGroup)}
          </div>
        ) : null}
      </div>
      {fullSidebar ? (
        <CollaborationManagementNavigation
          domain={domain}
          host={host}
          messages={messages}
        />
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
  onArchiveProject,
}: {
  project: CollaborationProject;
  host: CollaborationPlatformHostAdapter;
  messages: PlatformMessages;
  onArchiveProject(project: CollaborationProject): void;
}) {
  return (
    <div
      className={`collaboration-workspace-project-row${project.project_store === "local" ? " has-offline-project" : ""}`}
      key={project.id}
    >
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
      {project.project_store === "local" ? (
        host.convertLocalProjectToCloud ? (
          <button
            type="button"
            className="collaboration-project-offline"
            data-testid={`collaboration-project-convert-${project.id}`}
            aria-label={messages.convertProjectToCloud}
            title={messages.convertProjectToCloud}
            onClick={() => host.convertLocalProjectToCloud?.(project)}
          >
            <CloudOff aria-hidden="true" />
          </button>
        ) : (
          <span
            className="collaboration-project-offline"
            title={messages.offlineProject}
            role="img"
            aria-label={messages.offlineProject}
          >
            <CloudOff aria-hidden="true" />
          </span>
        )
      ) : null}
      <div className="collaboration-project-row-actions">
        {canAccessCollaborationProjectView(project, "manage") && (
          <ActionMenu
            ariaLabel={`${messages.projectActions} · ${project.name}`}
            testId={`collaboration-project-menu-${project.id}`}
            triggerClassName="collaboration-project-new-conversation"
            items={[
              {
                label: messages.projectSettings,
                icon: Settings,
                testId: `collaboration-project-settings-${project.id}`,
                onSelect: () =>
                  host.navigate({
                    platformView: "spaces",
                    collaborationDomain:
                      project.project_store === "local" ? "local" : "cloud",
                    workspaceId: project.workspace_id ?? null,
                    workspaceView: "projects",
                    projectId: project.id,
                    projectView: "manage",
                    projectSettingsSection: "project",
                    issueId: null,
                  }),
              },
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
