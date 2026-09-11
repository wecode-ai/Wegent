// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { useEffect, useMemo, useState } from "react";

import {
  collaborationMessages,
  createCollaborationTranslator,
  localizeStandardStatuses,
  type CollaborationLocale,
} from "./i18n";
import { collaborationTestIds } from "./testIds";
import { CollaborationSettings } from "./CollaborationSettings";
import { IssueCreate, IssueDetail } from "./IssueDetail";
import { CollaborationProjectViewShell } from "./project-shell";
import { CollaborationFilesAdapter } from "./web-adapter/CollaborationFilesAdapter";
import { MyWorkAdapter } from "./web-adapter/MyWorkAdapter";
import { ProjectBoardAdapter } from "./web-adapter/ProjectBoardAdapter";
import { WorkspaceProjectsHomeAdapter } from "./web-adapter/WorkspaceProjectsHomeAdapter";
import type {
  CollaborationHostAdapter,
  CollaborationIssue,
  CollaborationProject,
  CollaborationStatus,
  CollaborationView,
} from "./types";
import type { SharedWorkspaceApi } from "./ports/SharedWorkspaceApi";
import {
  ProjectAutomationRulesView,
  createSharedWorkspaceAutomationPorts,
  type AutomationUiHost,
} from "./automation-ui";
import type { AutomationProject } from "./automation";
import { useCollaborationWorkspaceController } from "./workspace-controller";
import { ProjectCreateDialog, projectCreateLabels } from "./project-create";
import { ProjectIssueTable } from "./platform";

interface CollaborationAppProps {
  api: SharedWorkspaceApi;
  host: CollaborationHostAdapter;
  locale?: CollaborationLocale;
  pollIntervalMs?: number;
  automationUiHost?: AutomationUiHost;
  createProjectRequestKey?: number;
  onCreateTask?(
    project: CollaborationProject,
    issue: CollaborationIssue,
    workflowStep?: string,
  ): void;
}

function projectStatuses(
  project: CollaborationProject,
  messages:
    | (typeof collaborationMessages)["zh-CN"]
    | (typeof collaborationMessages)["en"],
  translate: ReturnType<typeof createCollaborationTranslator>,
): CollaborationStatus[] {
  const statuses = project.board_config?.statuses;
  return statuses && statuses.length > 0
    ? localizeStandardStatuses(statuses, translate)
    : [
        { id: "inbox", name: messages.statusInbox, color: "gray" },
        { id: "pending", name: messages.statusPending, color: "blue" },
        {
          id: "in_progress",
          name: messages.statusInProgress,
          color: "orange",
        },
        { id: "in_review", name: messages.statusInReview, color: "purple" },
        { id: "completed", name: messages.statusCompleted, color: "green" },
      ];
}

function requireAutomationUiHost(
  host: AutomationUiHost | undefined,
): AutomationUiHost {
  if (!host)
    throw new Error(
      "CollaborationApp automationUiHost is required for automation view",
    );
  return host;
}

export function CollaborationApp({
  api,
  host,
  locale = "zh-CN",
  pollIntervalMs = 15_000,
  automationUiHost,
  createProjectRequestKey = 0,
  onCreateTask,
}: CollaborationAppProps) {
  const messages = collaborationMessages[locale];
  const translate = useMemo(
    () => createCollaborationTranslator(locale),
    [locale],
  );
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [createIssueOpen, setCreateIssueOpen] = useState(false);
  const { state, commands } = useCollaborationWorkspaceController({
    api,
    location: host.location,
    messages,
    myWorkEnabled: host.capabilities.myWork === true,
    pollIntervalMs,
    notify: (message, kind) => host.notify?.(message, kind),
  });
  const {
    projects,
    myWork,
    projectItems,
    projectMembers,
    project,
    issues,
    members,
    agents,
    selectedIssue,
    comments,
    assignments,
    executions,
    loading,
    error,
  } = state;
  const automationPorts = useMemo(
    () =>
      host.location.view === "automation"
        ? createSharedWorkspaceAutomationPorts(api)
        : null,
    [api, host.location.view],
  );

  useEffect(() => {
    host.onProjectsChange?.(projects);
  }, [host, projects]);

  useEffect(() => {
    if (createProjectRequestKey > 0) setCreateProjectOpen(true);
  }, [createProjectRequestKey]);

  const navigateView = (view: CollaborationView) => {
    host.navigate({ projectId: project?.id ?? null, issueId: null, view });
  };

  if (loading) {
    return (
      <div
        className="collaboration-loading"
        data-testid={collaborationTestIds.root}
      >
        {messages.loading}
      </div>
    );
  }

  return (
    <section
      className={`collaboration-app${project ? " collaboration-app-project" : ""}`}
      data-testid={collaborationTestIds.root}
    >
      {error && (
        <div
          className="collaboration-alert"
          role="alert"
          data-testid="collaboration-error"
        >
          {error}
        </div>
      )}
      {!project &&
      host.capabilities.myWork === true &&
      host.location.rootView === "my-work" ? (
        <MyWorkAdapter
          items={myWork}
          locale={locale}
          onBack={() =>
            host.navigate({
              projectId: null,
              issueId: null,
              view: "board",
              rootView: "home",
            })
          }
          onSelectItem={(item) =>
            host.navigate({
              projectId: item.cloud_project_id,
              issueId: item.id,
              view: "board",
            })
          }
        />
      ) : !project ? (
        <WorkspaceProjectsHomeAdapter
          projects={projects}
          projectItems={projectItems}
          projectMembers={projectMembers}
          myWork={host.capabilities.myWork === true ? myWork : []}
          onCreateProject={() => setCreateProjectOpen(true)}
          onSelectProject={(nextProject) =>
            host.navigate({
              projectId: nextProject.id,
              issueId: null,
              view: "board",
            })
          }
          onManageProject={(nextProject) =>
            host.navigate({
              projectId: nextProject.id,
              issueId: null,
              view: "manage",
            })
          }
          onOpenMyWork={
            host.capabilities.myWork === true
              ? () =>
                  host.navigate({
                    projectId: null,
                    issueId: null,
                    view: "board",
                    rootView: "my-work",
                  })
              : undefined
          }
          onUnavailable={() =>
            commands.reportError(messages.capabilitiesUnavailable)
          }
          locale={locale}
        />
      ) : (
        <CollaborationProjectViewShell
          project={project}
          view={host.location.view}
          labels={{
            board: messages.board,
            table: messages.table,
            files: messages.files,
            automation: messages.automation,
            manage: messages.settings,
          }}
          testIds={{
            board: "collaboration-tab-board",
            table: "collaboration-tab-table",
            files: "collaboration-tab-files",
            automation: "collaboration-tab-automation",
            manage: "collaboration-tab-manage",
          }}
          automationSupported={host.capabilities.automation}
          switcherAriaLabel={messages.title}
          compactSwitcherIcon={<span aria-hidden="true">▾</span>}
          onViewChange={(view) => navigateView(view as CollaborationView)}
          assistantOpen={false}
          backAction={
            <button
              type="button"
              className="relative z-10 mr-2 flex h-8 items-center rounded-lg px-2 text-sm text-text-secondary hover:bg-muted hover:text-text-primary"
              data-testid="collaboration-project-back"
              onClick={() =>
                host.navigate({ projectId: null, issueId: null, view: "board" })
              }
              aria-label={messages.back}
            >
              ←
            </button>
          }
          embedded
          hasCreateAction
          sidebarCollapsed={false}
          title={project.name}
          titleIcon={
            <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-indigo-500/10 text-xs font-semibold text-indigo-600">
              {project.project_key.slice(0, 2)}
            </span>
          }
          renderRightActions={({ actionRefs, showLabels }) => (
            <>
              {host.location.view === "board" ? (
                <button
                  ref={actionRefs.add}
                  type="button"
                  className="relative z-10 ml-2 flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg bg-text-primary px-3 text-sm font-medium text-background"
                  data-testid={collaborationTestIds.createIssue}
                  onClick={() => setCreateIssueOpen(true)}
                >
                  <span aria-hidden="true">＋</span>
                  {showLabels ? messages.createIssue : null}
                </button>
              ) : null}
              {host.projectActions?.map((action) => (
                <button
                  type="button"
                  className="relative z-10 ml-2 flex h-8 items-center gap-1.5 rounded-lg border border-border bg-background px-3 text-sm text-text-primary hover:bg-muted"
                  data-testid={action.testId}
                  key={action.id}
                  onClick={() => action.invoke(project)}
                >
                  {action.renderIcon?.()}
                  {showLabels ? action.label : null}
                </button>
              ))}
            </>
          )}
          slots={{
            board: (
              <ProjectBoardAdapter
                agents={agents ?? []}
                boardError={error}
                project={project}
                issues={issues}
                members={members ?? []}
                statuses={projectStatuses(project, messages, translate)}
                labels={{
                  noIssues: messages.noIssues,
                  search: messages.searchIssues,
                  groupBy: messages.groupBy,
                  groupStatus: messages.groupStatus,
                  groupPriority: messages.groupPriority,
                  groupAssignee: messages.groupAssignee,
                  groupTag: messages.groupTag,
                  unassigned: messages.unassigned,
                  noTag: messages.noTag,
                }}
                onOpen={(issue) =>
                  host.navigate({
                    projectId: project.id,
                    issueId: issue.id,
                    view: "board",
                  })
                }
                onMove={async (issue, mutation) => {
                  if (mutation.kind === "status") {
                    await commands.reorderIssue({
                      issue,
                      status: mutation.status,
                      laneIds: mutation.laneIds,
                      optimisticItems: mutation.optimisticItems,
                    });
                    return;
                  }
                  if (mutation.kind === "assignee" && mutation.assigneeType) {
                    await commands.assignIssue(String(project.id), issue.id, {
                      version: issue.version,
                      assigneeType: mutation.assigneeType,
                      assigneeId: mutation.assigneeId!,
                      notifyAssignee: true,
                    });
                    return;
                  }
                  await commands.updateIssue(
                    issue.id,
                    mutation.kind === "priority"
                      ? {
                          version: issue.version,
                          priority:
                            mutation.priority as CollaborationIssue["priority"],
                        }
                      : mutation.kind === "tag"
                        ? { version: issue.version, tags: mutation.tags }
                        : {
                            version: issue.version,
                            assigneeUserId: null,
                            assigneeAgentId: null,
                            assigneeTeamId: null,
                          },
                    { throwOnError: true },
                  );
                }}
                onCreateIssue={() => setCreateIssueOpen(true)}
                onGroupByChange={(groupBy) =>
                  commands.changeProjectGroup({
                    project,
                    groupBy,
                    defaultStatuses: projectStatuses(
                      project,
                      messages,
                      translate,
                    ),
                  })
                }
              />
            ),
            table: (
              <div className="collaboration-project-content">
                <ProjectIssueTable
                  issues={issues}
                  emptyLabel={messages.noIssues}
                  issueLabel={messages.issueTitle}
                  statusLabel={messages.issueStatus}
                  assignmentsLabel={messages.assignments}
                  updatedLabel={messages.updatedAt}
                  onOpen={(issue) =>
                    host.navigate({
                      projectId: project.id,
                      issueId: issue.id,
                      view: "table",
                    })
                  }
                />
              </div>
            ),
            files: (
              <div className="collaboration-project-content">
                <CollaborationFilesAdapter
                  api={api}
                  project={project}
                  locale={locale}
                />
              </div>
            ),
            automation: automationPorts ? (
              <div className="collaboration-project-content">
                <ProjectAutomationRulesView
                  automationApi={automationPorts.automationApi}
                  automationCacheSource={api.automations}
                  projectApi={automationPorts.projectApi}
                  incomingHooksApi={automationPorts.incomingHooksApi}
                  locale={locale}
                  uiHost={requireAutomationUiHost(automationUiHost)}
                  project={project as CollaborationProject & AutomationProject}
                  currentUserId={project.current_user_id}
                  canManage={
                    project.access_role === "Owner" ||
                    project.access_role === "Maintainer"
                  }
                  onProjectUpdated={(updated) =>
                    commands.replaceProject(updated as CollaborationProject)
                  }
                  onLoadExecutionCatalog={
                    api.automationExecutionCatalog
                      ? () => api.automationExecutionCatalog!.load(project.id)
                      : undefined
                  }
                  onLoadExecutionPlugins={
                    api.automationExecutionCatalog
                      ? (deviceIds) =>
                          api.automationExecutionCatalog!.loadPlugins(
                            project.id,
                            deviceIds,
                          )
                      : undefined
                  }
                  onRunRefreshError={(refreshError) => {
                    console.error(
                      "[Web collaboration automation] run history refresh failed",
                      {
                        projectId: project.id,
                        error: refreshError,
                      },
                    );
                  }}
                />
              </div>
            ) : null,
            manage: (
              <div className="collaboration-project-content">
                <CollaborationSettings
                  api={api}
                  key={project.id}
                  project={project}
                  onChange={commands.replaceProject}
                  onError={() => commands.reportError(messages.saveFailed)}
                  translate={translate}
                />
              </div>
            ),
          }}
        />
      )}
      {createProjectOpen && (
        <ProjectCreateDialog
          targets={[
            {
              location: "cloud",
              create: api.projects.create,
            },
          ]}
          defaultLocation="cloud"
          allowDingTalkAITable={host.capabilities.dingtalkAitable}
          labels={projectCreateLabels[locale]}
          testIds={{
            name: "collaboration-project-name-input",
            description: "collaboration-project-description-input",
            confirm: collaborationTestIds.createProjectConfirm,
          }}
          host={host.projectCreate}
          onClose={() => setCreateProjectOpen(false)}
          onCreated={(created) => {
            setCreateProjectOpen(false);
            host.navigate({
              projectId: created.id,
              issueId: null,
              view: "board",
            });
          }}
        />
      )}
      {createIssueOpen && project && (
        <IssueCreate
          api={api}
          project={project}
          allIssues={issues}
          messages={messages}
          translate={translate}
          onClose={() => setCreateIssueOpen(false)}
          onCreated={(created) => {
            commands.appendIssue(created);
            setCreateIssueOpen(false);
            host.navigate({
              projectId: project.id,
              issueId: created.id,
              view: "board",
            });
          }}
          onError={() => commands.reportError(messages.saveFailed)}
        />
      )}
      {selectedIssue && project && (
        <IssueDetail
          api={api}
          project={project}
          issue={selectedIssue}
          allIssues={issues}
          comments={comments}
          assignments={assignments}
          executions={executions}
          members={members}
          agents={agents}
          messages={messages}
          translate={translate}
          onClose={() => {
            commands.clearSelectedIssue();
            host.navigate({
              projectId: project.id,
              issueId: null,
              view: host.location.view,
            });
          }}
          onChange={commands.replaceIssue}
          onCommentsChange={commands.replaceComments}
          onAssignmentsChange={commands.replaceAssignments}
          onCreateTask={
            onCreateTask
              ? (workflowStep) =>
                  onCreateTask(project, selectedIssue, workflowStep)
              : undefined
          }
          onConflict={commands.refreshSelectedIssue}
          onError={() => commands.reportError(messages.saveFailed)}
        />
      )}
    </section>
  );
}
