import { BrowserTaskDrafts } from "./issue-detail/BrowserTaskDrafts";
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { RuntimeConfigurationProvider } from "./runtime-profile/RuntimeConfigurationProvider";
import { useEffect, useMemo, useState, type ReactNode } from "react";

import {
  collaborationMessages,
  createCollaborationTranslator,
  localizeStandardStatuses,
  type CollaborationLocale,
} from "./i18n";
import { collaborationTestIds } from "./testIds";
import { CollaborationSettings } from "./CollaborationSettings";
import { IssueCreate, IssueDetail } from "./IssueDetail";
import { IssueExecutionEnvironmentNotice } from "./execution-environment/IssueExecutionEnvironmentNotice";
import { useProjectExecutionEnvironmentReadiness } from "./execution-environment/issueEnvironmentReadiness";
import { IssueArchiveDialog, IssueArchiveDrawer } from "./issue-archive";
import {
  CollaborationProjectViewShell,
  ProjectLoadingSkeleton,
} from "./project-shell";
import { CollaborationFilesAdapter } from "./web-adapter/CollaborationFilesAdapter";
import { MyWorkAdapter } from "./web-adapter/MyWorkAdapter";
import {
  ProjectBoardAdapter,
  type ProjectBoardIssueCardRenderContext,
} from "./web-adapter/ProjectBoardAdapter";
import { WorkspaceProjectsHomeAdapter } from "./web-adapter/WorkspaceProjectsHomeAdapter";
import type {
  CollaborationAssignment,
  CollaborationHostAdapter,
  CollaborationIssue,
  CollaborationProject,
  ProjectSettingsSectionId,
  CollaborationStatus,
  CollaborationView,
} from "./types";
import type {
  SharedWorkspaceApi,
  WorkspaceTaskBinding,
} from "./ports/SharedWorkspaceApi";
import { useCollaborationWorkspaceController } from "./workspace-controller";
import { canEditCollaborationIssue } from "./permissions";
import { ProjectCreateDialog, projectCreateLabels } from "./project-create";
import { ProjectIssueTable, useIssueAssignmentsByIssueId } from "./platform";
import {
  ProjectCollaborationParticipants,
  ProjectCollaborationGroups,
  ProjectAutomaticProcessing,
  ProjectBoardSettingsDialog,
  ProjectExecutionEnvironments,
  ProjectSettingsShell,
} from "./project-manage";

export interface CollaborationIssueDetailRenderContext {
  api: SharedWorkspaceApi;
  project: CollaborationProject;
  issue: CollaborationIssue;
  allIssues: CollaborationIssue[];
  assignments: CollaborationAssignment[];
  taskBindings: WorkspaceTaskBinding[];
  defaultAssistant?: CollaborationHostAdapter["defaultAssistant"];
  onClose(): void;
  onChange(issue: CollaborationIssue): void;
  onCreateTask?(): void;
  /** Present only for completed Issues when archiving is enabled. */
  onDelete?(): void;
}

interface CollaborationAppProps {
  api: SharedWorkspaceApi;
  host: CollaborationHostAdapter;
  initialProject?: CollaborationProject;
  locale?: CollaborationLocale;
  pollIntervalMs?: number;
  createProjectRequestKey?: number;
  refreshProjectRequestKey?: number;
  showProjectBack?: boolean;
  /** Enables completed-Issue archive actions and the project archive box. */
  issueArchiveEnabled?: boolean;
  onProjectChange?(project: CollaborationProject): void;
  /**
   * Host work that must succeed before the Issue is archived, such as stopping
   * an in-flight run on the device that owns it. A rejection aborts the archive
   * and its message is shown in the confirmation dialog.
   */
  onPrepareIssueArchive?(issue: CollaborationIssue): Promise<void>;
  onCreateTask?(project: CollaborationProject, issue: CollaborationIssue): void;
  renderIssueDetail?(context: CollaborationIssueDetailRenderContext): ReactNode;
  renderBoardIssueCard?(
    context: ProjectBoardIssueCardRenderContext & {
      onMarkRead(): Promise<void>;
    },
  ): ReactNode;
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

export function CollaborationApp({
  api,
  host,
  initialProject,
  locale = "zh-CN",
  pollIntervalMs = 15_000,
  createProjectRequestKey = 0,
  refreshProjectRequestKey = 0,
  showProjectBack = true,
  issueArchiveEnabled = false,
  onProjectChange,
  onCreateTask,
  onPrepareIssueArchive,
  renderBoardIssueCard,
  renderIssueDetail,
}: CollaborationAppProps) {
  const messages = collaborationMessages[locale];
  const translate = useMemo(
    () => createCollaborationTranslator(locale),
    [locale],
  );
  const [createProjectOpen, setCreateProjectOpen] = useState(false);
  const [createIssueOpen, setCreateIssueOpen] = useState(false);
  const [boardSettingsOpen, setBoardSettingsOpen] = useState(false);
  const [settingsSectionId, setSettingsSectionId] =
    useState<ProjectSettingsSectionId>(
      host.location.projectSettingsSection ?? "project",
    );
  const [archiveIssueTargets, setArchiveIssueTargets] = useState<
    CollaborationIssue[] | null
  >(null);
  const [archiveIssueBusy, setArchiveIssueBusy] = useState(false);
  const [archiveIssueError, setArchiveIssueError] = useState<string | null>(
    null,
  );
  const [archiveDrawerOpen, setArchiveDrawerOpen] = useState(false);
  const [archivedIssues, setArchivedIssues] = useState<CollaborationIssue[]>(
    [],
  );
  const [archiveNextCursor, setArchiveNextCursor] = useState<string | null>(
    null,
  );
  const [archiveDrawerLoading, setArchiveDrawerLoading] = useState(false);
  const [archiveDrawerError, setArchiveDrawerError] = useState<string | null>(
    null,
  );
  const [restoringIssueId, setRestoringIssueId] = useState<string | null>(null);
  const { state, commands } = useCollaborationWorkspaceController({
    api,
    location: host.location,
    initialProject,
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
    taskBindings,
    loading,
    error,
  } = state;
  const { assignmentsByIssueId, replaceIssueAssignments } =
    useIssueAssignmentsByIssueId({
      assignmentsApi: api.assignments,
      issues,
      enabled: project !== null,
    });
  const environmentReadiness = useProjectExecutionEnvironmentReadiness({
    api,
    project,
  });
  const requestIssueCreate = async () => {
    if (!project) return;
    const readiness =
      environmentReadiness.kind === "ready"
        ? environmentReadiness
        : await environmentReadiness.refresh();
    if (readiness.kind !== "ready") {
      host.notify?.(
        translate(
          "todo.issue_environment_create_blocked",
          "请先完成项目执行环境初始化，再创建 Issue。",
        ),
        "error",
      );
      host.navigate({
        projectId: project.id,
        issueId: null,
        view: "manage",
        projectSettingsSection: "environments",
      });
      return;
    }
    setCreateIssueOpen(true);
  };
  useEffect(() => {
    host.onProjectsChange?.(projects);
  }, [host, projects]);

  useEffect(() => {
    if (createProjectRequestKey > 0) setCreateProjectOpen(true);
  }, [createProjectRequestKey]);

  useEffect(() => {
    if (refreshProjectRequestKey <= 0 || !project) return;
    void commands.loadProjectSnapshot(project.id);
  }, [commands, project?.id, refreshProjectRequestKey]);

  useEffect(() => {
    setSettingsSectionId(
      host.location.view === "manage"
        ? (host.location.projectSettingsSection ?? "project")
        : "project",
    );
  }, [host.location.projectSettingsSection, host.location.view, project?.id]);

  useEffect(() => {
    setArchiveIssueTargets(null);
    setArchiveIssueError(null);
    setArchiveDrawerOpen(false);
    setArchivedIssues([]);
    setArchiveNextCursor(null);
    setArchiveDrawerError(null);
  }, [project?.id]);

  const navigateView = (view: CollaborationView) => {
    host.navigate({
      projectId: project?.id ?? null,
      issueId: null,
      view,
      projectSettingsSection: view === "manage" ? settingsSectionId : null,
    });
  };

  const requestIssueArchive = (issue: CollaborationIssue) => {
    setArchiveIssueError(null);
    setArchiveIssueTargets([issue]);
  };
  const closeIssueArchive = () => {
    setArchiveIssueTargets(null);
    setArchiveIssueError(null);
  };
  const confirmIssueArchive = async () => {
    if (!archiveIssueTargets?.length || archiveIssueBusy) return;
    setArchiveIssueBusy(true);
    setArchiveIssueError(null);
    const results = await Promise.allSettled(
      archiveIssueTargets.map(async (issue) => {
        await onPrepareIssueArchive?.(issue);
        const archived = await commands.archiveIssue(issue.id, {
          throwOnError: true,
        });
        if (!archived) throw new Error("Issue could not be archived");
        return issue;
      }),
    );
    const failed = results.flatMap((result, index) =>
      result.status === "rejected" ? [archiveIssueTargets[index]] : [],
    );
    const archivedIds = new Set(
      results.flatMap((result) =>
        result.status === "fulfilled" ? [result.value.id] : [],
      ),
    );
    if (host.location.issueId && archivedIds.has(host.location.issueId)) {
      host.navigate({
        projectId: project?.id ?? null,
        issueId: null,
        view: host.location.view,
      });
    }
    if (failed.length === 0) {
      setArchiveIssueTargets(null);
    } else {
      setArchiveIssueTargets(failed);
      setArchiveIssueError(
        translate(
          "todo.archive_issue_failed_count",
          "{{count}} 个任务归档失败，请重试。",
          { count: failed.length },
        ),
      );
    }
    setArchiveIssueBusy(false);
  };
  const loadArchivedIssues = async (cursor: string | null = null) => {
    if (!project || archiveDrawerLoading) return;
    setArchiveDrawerLoading(true);
    setArchiveDrawerError(null);
    try {
      const page = await api.issues.listArchived(project.id, {
        cursor,
        limit: 50,
      });
      setArchivedIssues((current) =>
        cursor ? [...current, ...page.items] : page.items,
      );
      setArchiveNextCursor(page.nextCursor);
    } catch (error) {
      setArchiveDrawerError(
        error instanceof Error
          ? error.message
          : translate("todo.archive_box_load_failed", "加载归档任务失败"),
      );
    } finally {
      setArchiveDrawerLoading(false);
    }
  };
  const openArchiveDrawer = () => {
    setArchiveDrawerOpen(true);
    setArchivedIssues([]);
    setArchiveNextCursor(null);
    void loadArchivedIssues();
  };
  const restoreArchivedIssue = async (issue: CollaborationIssue) => {
    if (!project || restoringIssueId) return;
    setRestoringIssueId(issue.id);
    setArchiveDrawerError(null);
    try {
      await api.issues.restore(issue.id);
      setArchivedIssues((current) =>
        current.filter((candidate) => candidate.id !== issue.id),
      );
      await commands.loadProjectSnapshot(project.id);
    } catch (error) {
      setArchiveDrawerError(
        error instanceof Error
          ? error.message
          : translate("todo.restore_issue_failed", "恢复任务失败"),
      );
    } finally {
      setRestoringIssueId(null);
    }
  };
  const issueArchiveAvailable = issueArchiveEnabled;
  const environmentNotice = project ? (
    <IssueExecutionEnvironmentNotice
      canManage={
        project.access_role === "Owner" || project.access_role === "Maintainer"
      }
      onOpenEnvironmentSettings={() =>
        host.navigate({
          projectId: project.id,
          issueId: null,
          view: "manage",
          projectSettingsSection: "environments",
        })
      }
      readiness={environmentReadiness}
      translate={translate}
    />
  ) : null;

  if (loading) {
    return (
      <ProjectLoadingSkeleton
        testId={collaborationTestIds.root}
        label={messages.loading}
        layout={
          host.location.projectId && host.location.view === "board"
            ? "board"
            : "list"
        }
      />
    );
  }

  return (
    <RuntimeConfigurationProvider api={api} project={project} locale={locale}>
      <BrowserTaskDrafts runtime={api.runtime}>
        <section
          className={`collaboration-app${project ? " collaboration-app-project issue-drawer-workspace" : ""}`}
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
                manage: messages.settings,
              }}
              testIds={{
                board: "collaboration-tab-board",
                table: "collaboration-tab-table",
                files: "collaboration-tab-files",
                manage: "collaboration-tab-manage",
              }}
              switcherAriaLabel={messages.title}
              compactSwitcherIcon={<span aria-hidden="true">▾</span>}
              onViewChange={(view) => navigateView(view as CollaborationView)}
              assistantOpen={false}
              backAction={
                showProjectBack ? (
                  <button
                    type="button"
                    className="relative z-10 mr-2 flex h-8 items-center rounded-lg px-2 text-sm text-text-secondary hover:bg-muted hover:text-text-primary"
                    data-testid="collaboration-project-back"
                    onClick={() =>
                      host.navigate({
                        projectId: null,
                        issueId: null,
                        view: "board",
                      })
                    }
                    aria-label={messages.back}
                  >
                    ←
                  </button>
                ) : undefined
              }
              embedded
              hasCreateAction
              sidebarCollapsed={false}
              title={
                <span className="collaboration-project-heading">
                  <strong>{project.name}</strong>
                  <small>
                    {locale === "zh-CN" ? "协作项目" : "Collaboration project"}{" "}
                    · {members.length}{" "}
                    {locale === "zh-CN" ? "位成员" : "members"}
                  </small>
                </span>
              }
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
                      onClick={requestIssueCreate}
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
                  <div className="relative flex min-h-0 min-w-0 flex-1">
                    {issues.length === 0 ? (
                      <div
                        data-testid={collaborationTestIds.board}
                        className="relative flex min-h-0 flex-1"
                      >
                        <button
                          className="absolute right-4 top-4 z-10 flex h-8 items-center rounded-lg px-3 text-sm text-text-secondary hover:bg-muted hover:text-text-primary"
                          data-testid="collaboration-board-settings"
                          onClick={() => setBoardSettingsOpen(true)}
                          type="button"
                        >
                          {translate("todo.board_settings", "看板设置")}
                        </button>
                        <div
                          className="collaboration-empty-project"
                          data-testid="collaboration-empty-project"
                        >
                          <div className="collaboration-empty-project-content">
                            <span className="collaboration-empty-project-icon">
                              ◇
                            </span>
                            <span className="collaboration-empty-project-progress">
                              {messages.emptyProjectProgress}
                            </span>
                            <h2>{messages.emptyProjectTitle}</h2>
                            <p>{messages.emptyProjectHint}</p>
                            <button
                              type="button"
                              className="collaboration-primary-button"
                              data-testid="collaboration-empty-project-create"
                              onClick={requestIssueCreate}
                            >
                              {messages.createIssue}
                            </button>
                            <div className="collaboration-empty-project-flow">
                              {[
                                [
                                  messages.emptyProjectStepIssue,
                                  messages.emptyProjectStepIssueHint,
                                ],
                                [
                                  messages.emptyProjectStepAssign,
                                  messages.emptyProjectStepAssignHint,
                                ],
                                [
                                  messages.emptyProjectStepDeliver,
                                  messages.emptyProjectStepDeliverHint,
                                ],
                              ].map(([title, hint]) => (
                                <div key={title}>
                                  <strong>{title}</strong>
                                  <small>{hint}</small>
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>
                    ) : (
                      <ProjectBoardAdapter
                        onMarkRead={(issue) =>
                          void commands.markIssueRead(issue)
                        }
                        runtime={api.runtime}
                        previewDisabled={Boolean(selectedIssue)}
                        translate={translate}
                        agents={agents ?? []}
                        boardError={error}
                        project={project}
                        issues={issues}
                        members={members ?? []}
                        statuses={projectStatuses(project, messages, translate)}
                        taskBindings={taskBindings}
                        labels={{
                          noIssues: messages.noIssues,
                          noPriority: translate(
                            "todo.priority_none",
                            "无优先级",
                          ),
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
                          if (
                            mutation.kind === "assignee" &&
                            mutation.assigneeType
                          ) {
                            await commands.assignIssue(
                              String(project.id),
                              issue.id,
                              {
                                version: issue.version,
                                assigneeType: mutation.assigneeType,
                                assigneeId: mutation.assigneeId!,
                                notifyAssignee: true,
                              },
                            );
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
                                ? {
                                    version: issue.version,
                                    tags: mutation.tags,
                                  }
                                : {
                                    version: issue.version,
                                    assigneeUserId: null,
                                    assigneeAgentId: null,
                                    assigneeTeamId: null,
                                  },
                            { throwOnError: true },
                          );
                        }}
                        onCreateIssue={requestIssueCreate}
                        onOpenBoardSettings={() => setBoardSettingsOpen(true)}
                        onDeleteIssue={
                          issueArchiveAvailable
                            ? requestIssueArchive
                            : undefined
                        }
                        onArchiveCompleted={
                          issueArchiveAvailable
                            ? (completedIssues) => {
                                if (completedIssues.length === 0) return;
                                setArchiveIssueError(null);
                                setArchiveIssueTargets(completedIssues);
                              }
                            : undefined
                        }
                        onOpenArchive={
                          issueArchiveAvailable ? openArchiveDrawer : undefined
                        }
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
                        renderIssueCard={
                          renderBoardIssueCard
                            ? (context) =>
                                renderBoardIssueCard({
                                  ...context,
                                  onMarkRead: async () => {
                                    await commands.markIssueRead(context.issue);
                                  },
                                })
                            : undefined
                        }
                      />
                    )}
                  </div>
                ),
                table: (
                  <div className="collaboration-project-content">
                    <ProjectIssueTable
                      issues={issues}
                      assignmentsByIssueId={assignmentsByIssueId}
                      emptyLabel={messages.noIssues}
                      issueLabel={messages.issueTitle}
                      statusLabel={messages.issueStatus}
                      assignmentsLabel={messages.assignments}
                      assignmentSourceLabel={messages.assignmentSource}
                      executionLabel={messages.executionStatus}
                      updatedLabel={messages.updatedAt}
                      projectKey={project.project_key}
                      searchPlaceholder={messages.searchIssues}
                      createLabel={messages.createIssue}
                      allLabel={locale === "zh-CN" ? "全部" : "All"}
                      tagLabel={messages.issueTags}
                      manualAssignmentLabel={translate(
                        "todo.manual_assignment",
                        locale === "zh-CN"
                          ? "Issue 内分配"
                          : "Assigned in Issue",
                      )}
                      actionsLabel={translate("common.actions", "操作")}
                      deleteLabel={translate("todo.archive_issue", "归档任务")}
                      canDelete={(issue) => issue.status === "completed"}
                      onDelete={
                        issueArchiveAvailable
                          ? (issue) => {
                              if (issue.status === "completed")
                                requestIssueArchive(issue);
                            }
                          : undefined
                      }
                      statusName={(status) =>
                        projectStatuses(project, messages, translate).find(
                          (candidate) => candidate.id === status,
                        )?.name ?? status
                      }
                      onCreate={requestIssueCreate}
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
                manage: (
                  <ProjectSettingsShell
                    ariaLabel={messages.settings}
                    onSectionChange={(sectionId) => {
                      const nextSectionId =
                        sectionId as ProjectSettingsSectionId;
                      setSettingsSectionId(nextSectionId);
                      host.navigate({
                        projectId: project.id,
                        issueId: null,
                        view: "manage",
                        projectSettingsSection: nextSectionId,
                      });
                    }}
                    selectedSectionId={settingsSectionId}
                    sections={[
                      {
                        id: "project",
                        label: messages.projectConfiguration,
                        testId: "collaboration-project-settings-project",
                        content: (
                          <CollaborationSettings
                            api={api}
                            key={project.id}
                            project={project}
                            onChange={commands.replaceProject}
                            onError={() =>
                              commands.reportError(messages.saveFailed)
                            }
                            translate={translate}
                            section="overview"
                          />
                        ),
                      },
                      {
                        id: "collaboration-participants",
                        label: messages.collaborationParticipants,
                        testId: "collaboration-project-settings-participants",
                        content: (
                          <ProjectCollaborationParticipants
                            translate={translate}
                            membersContent={
                              <CollaborationSettings
                                api={api}
                                embedded
                                project={project}
                                onChange={commands.replaceProject}
                                onError={() =>
                                  commands.reportError(messages.saveFailed)
                                }
                                translate={translate}
                                section="members"
                              />
                            }
                            agentsContent={
                              <CollaborationSettings
                                agentConfigurationHost={
                                  host.projectAgentConfiguration
                                }
                                agentResourceContext={
                                  host.projectAgentResourceContext
                                }
                                api={api}
                                embedded
                                project={project}
                                onChange={commands.replaceProject}
                                onError={() =>
                                  commands.reportError(messages.saveFailed)
                                }
                                onAgentsChange={() =>
                                  void commands.refreshProjectAgents(project.id)
                                }
                                translate={translate}
                                section="agents"
                              />
                            }
                            groupsContent={
                              api.projects.listCollaborationGroups ? (
                                <ProjectCollaborationGroups
                                  api={api}
                                  projectId={project.id}
                                  workspaceId={project.workspace_id}
                                  locale={locale}
                                  members={members}
                                  agents={agents}
                                  canManage={
                                    project.access_role === "Owner" ||
                                    project.access_role === "Maintainer"
                                  }
                                />
                              ) : (
                                <div
                                  className="rounded-xl border border-border bg-surface-subtle px-5 py-4 text-sm text-text-muted"
                                  data-testid="collaboration-project-groups-unavailable"
                                >
                                  {translate(
                                    "todo.collaboration_groups_unavailable_description",
                                    "协作小组服务当前不可用。",
                                  )}
                                </div>
                              )
                            }
                          />
                        ),
                      },
                      {
                        id: "environments",
                        label: messages.projectEnvironments,
                        testId: "collaboration-project-settings-environments",
                        content: (
                          <ProjectExecutionEnvironments
                            api={api}
                            onManageDevices={
                              host.manageResource
                                ? () => host.manageResource?.("environments")
                                : undefined
                            }
                            onProjectChange={(nextProject) => {
                              commands.replaceProject(nextProject);
                              onProjectChange?.(nextProject);
                            }}
                            project={project}
                            translate={translate}
                          />
                        ),
                      },
                      ...(host.capabilities.automation && api.automations
                        ? [
                            {
                              id: "automatic-processing",
                              label: messages.automaticProcessing,
                              testId:
                                "collaboration-project-settings-automatic-processing",
                              content: (
                                <ProjectAutomaticProcessing
                                  api={api}
                                  project={project}
                                  members={members}
                                  agents={agents}
                                  locale={locale}
                                  translate={translate}
                                />
                              ),
                            },
                          ]
                        : []),
                    ]}
                  />
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
              environmentNotice={environmentNotice}
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
          {boardSettingsOpen && project ? (
            <ProjectBoardSettingsDialog
              title={messages.boardSettings}
              closeLabel={messages.close}
              onClose={() => setBoardSettingsOpen(false)}
            >
              <CollaborationSettings
                api={api}
                embedded
                project={project}
                onChange={commands.replaceProject}
                onError={() => commands.reportError(messages.saveFailed)}
                translate={translate}
                section="board"
              />
            </ProjectBoardSettingsDialog>
          ) : null}
          {selectedIssue && project ? (
            renderIssueDetail ? (
              renderIssueDetail({
                api,
                project,
                issue: selectedIssue,
                allIssues: issues,
                assignments,
                taskBindings: taskBindings.filter(
                  (binding) => binding.issueId === selectedIssue.id,
                ),
                defaultAssistant: host.defaultAssistant,
                onClose: () => {
                  commands.clearSelectedIssue();
                  host.navigate({
                    projectId: project.id,
                    issueId: null,
                    view: host.location.view,
                  });
                },
                onChange: commands.replaceIssue,
                onCreateTask: onCreateTask
                  ? () => onCreateTask(project, selectedIssue)
                  : undefined,
                onDelete:
                  issueArchiveAvailable &&
                  selectedIssue.status === "completed" &&
                  canEditCollaborationIssue(selectedIssue)
                    ? () => requestIssueArchive(selectedIssue)
                    : undefined,
              })
            ) : (
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
                defaultAssistant={host.defaultAssistant}
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
                onCommentsChange={(nextComments) =>
                  commands.replaceComments(selectedIssue.id, nextComments)
                }
                onAssignmentsChange={(nextAssignments) => {
                  commands.replaceAssignments(
                    selectedIssue.id,
                    nextAssignments,
                  );
                  replaceIssueAssignments(selectedIssue.id, nextAssignments);
                }}
                onCreateTask={
                  onCreateTask
                    ? () => onCreateTask(project, selectedIssue)
                    : undefined
                }
                onDelete={
                  issueArchiveAvailable &&
                  selectedIssue.status === "completed" &&
                  canEditCollaborationIssue(selectedIssue)
                    ? () => requestIssueArchive(selectedIssue)
                    : undefined
                }
                onConflict={commands.refreshSelectedIssue}
                onError={() => commands.reportError(messages.saveFailed)}
              />
            )
          ) : null}
          {archiveIssueTargets?.length ? (
            <IssueArchiveDialog
              busy={archiveIssueBusy}
              count={archiveIssueTargets.length}
              error={archiveIssueError}
              hasChildren={issues.some(
                (candidate) =>
                  candidate.parent_id === archiveIssueTargets[0]?.id,
              )}
              onCancel={closeIssueArchive}
              onConfirm={() => void confirmIssueArchive()}
              title={archiveIssueTargets[0]?.title}
              translate={translate}
            />
          ) : null}
          {archiveDrawerOpen ? (
            <IssueArchiveDrawer
              busyId={restoringIssueId}
              error={archiveDrawerError}
              items={archivedIssues}
              loading={archiveDrawerLoading}
              nextCursor={archiveNextCursor}
              onClose={() => setArchiveDrawerOpen(false)}
              onLoadMore={() => void loadArchivedIssues(archiveNextCursor)}
              onRestore={(issue) => void restoreArchivedIssue(issue)}
              translate={translate}
            />
          ) : null}
        </section>
      </BrowserTaskDrafts>
    </RuntimeConfigurationProvider>
  );
}
