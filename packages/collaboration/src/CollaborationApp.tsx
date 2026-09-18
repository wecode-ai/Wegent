import { BrowserTaskDrafts } from './issue-detail/BrowserTaskDrafts'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { RuntimeConfigurationProvider } from './runtime-profile/RuntimeConfigurationProvider'
import { useEffect, useMemo, useState, type ReactNode } from 'react'

import {
  collaborationMessages,
  createCollaborationTranslator,
  localizeStandardStatuses,
  type CollaborationLocale,
} from './i18n'
import { collaborationTestIds } from './testIds'
import { CollaborationSettings } from './CollaborationSettings'
import { IssueCreate, IssueDetail } from './IssueDetail'
import { IssueDeleteDialog } from './issue-delete'
import { CollaborationProjectViewShell } from './project-shell'
import { CollaborationFilesAdapter } from './web-adapter/CollaborationFilesAdapter'
import { MyWorkAdapter } from './web-adapter/MyWorkAdapter'
import {
  ProjectBoardAdapter,
  type ProjectBoardIssueCardRenderContext,
} from './web-adapter/ProjectBoardAdapter'
import { WorkspaceProjectsHomeAdapter } from './web-adapter/WorkspaceProjectsHomeAdapter'
import type {
  CollaborationAssignment,
  CollaborationHostAdapter,
  CollaborationIssue,
  CollaborationProject,
  CollaborationStatus,
  CollaborationView,
} from './types'
import type { SharedWorkspaceApi, WorkspaceTaskBinding } from './ports/SharedWorkspaceApi'
import { useCollaborationWorkspaceController } from './workspace-controller'
import { canEditCollaborationIssue } from './permissions'
import { ProjectCreateDialog, projectCreateLabels } from './project-create'
import { ProjectIssueTable, useIssueAssignmentsByIssueId } from './platform'
import {
  ProjectCollaborationParticipants,
  ProjectCollaborationGroups,
  ProjectAutomaticProcessing,
  ProjectBoardSettingsDialog,
  ProjectExecutionEnvironments,
  ProjectSettingsShell,
} from './project-manage'

export interface CollaborationIssueDetailRenderContext {
  api: SharedWorkspaceApi
  project: CollaborationProject
  issue: CollaborationIssue
  allIssues: CollaborationIssue[]
  assignments: CollaborationAssignment[]
  taskBindings: WorkspaceTaskBinding[]
  onClose(): void
  onChange(issue: CollaborationIssue): void
  onCreateTask?(workflowStep?: string): void
  /** Present only when the host enabled Issue deletion. */
  onDelete?(): void
}

interface CollaborationAppProps {
  api: SharedWorkspaceApi
  host: CollaborationHostAdapter
  locale?: CollaborationLocale
  pollIntervalMs?: number
  createProjectRequestKey?: number
  refreshProjectRequestKey?: number
  showProjectBack?: boolean
  /** Enables the per-Issue delete action across board, table, and detail. */
  issueDeleteEnabled?: boolean
  /**
   * Host work that must succeed before the Issue is deleted, such as stopping
   * an in-flight run on the device that owns it. A rejection aborts the delete
   * and its message is shown in the confirmation dialog.
   */
  onPrepareIssueDelete?(issue: CollaborationIssue): Promise<void>
  onCreateTask?(
    project: CollaborationProject,
    issue: CollaborationIssue,
    workflowStep?: string
  ): void
  renderIssueDetail?(context: CollaborationIssueDetailRenderContext): ReactNode
  renderBoardIssueCard?(
    context: ProjectBoardIssueCardRenderContext & {
      onMarkRead(): Promise<void>
    }
  ): ReactNode
}

function projectStatuses(
  project: CollaborationProject,
  messages: (typeof collaborationMessages)['zh-CN'] | (typeof collaborationMessages)['en'],
  translate: ReturnType<typeof createCollaborationTranslator>
): CollaborationStatus[] {
  const statuses = project.board_config?.statuses
  return statuses && statuses.length > 0
    ? localizeStandardStatuses(statuses, translate)
    : [
        { id: 'inbox', name: messages.statusInbox, color: 'gray' },
        { id: 'pending', name: messages.statusPending, color: 'blue' },
        {
          id: 'in_progress',
          name: messages.statusInProgress,
          color: 'orange',
        },
        { id: 'in_review', name: messages.statusInReview, color: 'purple' },
        { id: 'completed', name: messages.statusCompleted, color: 'green' },
      ]
}

export function CollaborationApp({
  api,
  host,
  locale = 'zh-CN',
  pollIntervalMs = 15_000,
  createProjectRequestKey = 0,
  refreshProjectRequestKey = 0,
  showProjectBack = true,
  issueDeleteEnabled = false,
  onCreateTask,
  onPrepareIssueDelete,
  renderBoardIssueCard,
  renderIssueDetail,
}: CollaborationAppProps) {
  const messages = collaborationMessages[locale]
  const translate = useMemo(() => createCollaborationTranslator(locale), [locale])
  const [createProjectOpen, setCreateProjectOpen] = useState(false)
  const [createIssueOpen, setCreateIssueOpen] = useState(false)
  const [boardSettingsOpen, setBoardSettingsOpen] = useState(false)
  const [settingsSectionId, setSettingsSectionId] = useState('project')
  const [deleteIssueTarget, setDeleteIssueTarget] = useState<CollaborationIssue | null>(null)
  const [deleteIssueBusy, setDeleteIssueBusy] = useState(false)
  const [deleteIssueError, setDeleteIssueError] = useState<string | null>(null)
  const { state, commands } = useCollaborationWorkspaceController({
    api,
    location: host.location,
    messages,
    myWorkEnabled: host.capabilities.myWork === true,
    pollIntervalMs,
    notify: (message, kind) => host.notify?.(message, kind),
  })
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
  } = state
  const { assignmentsByIssueId, replaceIssueAssignments } = useIssueAssignmentsByIssueId({
    assignmentsApi: api.assignments,
    issues,
    enabled: project !== null,
  })
  useEffect(() => {
    host.onProjectsChange?.(projects)
  }, [host, projects])

  useEffect(() => {
    if (createProjectRequestKey > 0) setCreateProjectOpen(true)
  }, [createProjectRequestKey])

  useEffect(() => {
    if (refreshProjectRequestKey <= 0 || !project) return
    void commands.loadProjectSnapshot(project.id)
  }, [commands, project?.id, refreshProjectRequestKey])

  const navigateView = (view: CollaborationView) => {
    host.navigate({ projectId: project?.id ?? null, issueId: null, view })
  }

  const requestIssueDelete = (issue: CollaborationIssue) => {
    setDeleteIssueError(null)
    setDeleteIssueTarget(issue)
  }
  const closeIssueDelete = () => {
    setDeleteIssueTarget(null)
    setDeleteIssueError(null)
  }
  const confirmIssueDelete = async () => {
    if (!deleteIssueTarget || deleteIssueBusy) return
    setDeleteIssueBusy(true)
    setDeleteIssueError(null)
    try {
      // Stopping the run first keeps a deleted Issue from leaving an execution
      // that no board or detail view can reach any more.
      await onPrepareIssueDelete?.(deleteIssueTarget)
      await commands.archiveIssue(deleteIssueTarget.id, {
        throwOnError: true,
      })
      if (host.location.issueId === deleteIssueTarget.id) {
        host.navigate({
          projectId: project?.id ?? null,
          issueId: null,
          view: host.location.view,
        })
      }
      setDeleteIssueTarget(null)
    } catch (error) {
      setDeleteIssueError(
        error instanceof Error && error.message
          ? error.message
          : translate('todo.delete_issue_failed', '删除任务失败')
      )
    } finally {
      setDeleteIssueBusy(false)
    }
  }
  const issueDeleteAvailable = issueDeleteEnabled

  if (loading) {
    return (
      <div className="collaboration-loading" data-testid={collaborationTestIds.root}>
        {messages.loading}
      </div>
    )
  }

  return (
    <RuntimeConfigurationProvider api={api} project={project} locale={locale}>
      <BrowserTaskDrafts runtime={api.runtime}>
        <section
          className={`collaboration-app${project ? ' collaboration-app-project issue-drawer-workspace' : ''}`}
          data-testid={collaborationTestIds.root}
        >
          {error && (
            <div className="collaboration-alert" role="alert" data-testid="collaboration-error">
              {error}
            </div>
          )}
          {!project && host.capabilities.myWork === true && host.location.rootView === 'my-work' ? (
            <MyWorkAdapter
              items={myWork}
              locale={locale}
              onBack={() =>
                host.navigate({
                  projectId: null,
                  issueId: null,
                  view: 'board',
                  rootView: 'home',
                })
              }
              onSelectItem={item =>
                host.navigate({
                  projectId: item.cloud_project_id,
                  issueId: item.id,
                  view: 'board',
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
              onSelectProject={nextProject =>
                host.navigate({
                  projectId: nextProject.id,
                  issueId: null,
                  view: 'board',
                })
              }
              onManageProject={nextProject =>
                host.navigate({
                  projectId: nextProject.id,
                  issueId: null,
                  view: 'manage',
                })
              }
              onOpenMyWork={
                host.capabilities.myWork === true
                  ? () =>
                      host.navigate({
                        projectId: null,
                        issueId: null,
                        view: 'board',
                        rootView: 'my-work',
                      })
                  : undefined
              }
              onUnavailable={() => commands.reportError(messages.capabilitiesUnavailable)}
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
                board: 'collaboration-tab-board',
                table: 'collaboration-tab-table',
                files: 'collaboration-tab-files',
                manage: 'collaboration-tab-manage',
              }}
              switcherAriaLabel={messages.title}
              compactSwitcherIcon={<span aria-hidden="true">▾</span>}
              onViewChange={view => navigateView(view as CollaborationView)}
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
                        view: 'board',
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
                    {locale === 'zh-CN' ? '协作项目' : 'Collaboration project'} · {members.length}{' '}
                    {locale === 'zh-CN' ? '位成员' : 'members'}
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
                  {host.location.view === 'board' ? (
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
                  {host.projectActions?.map(action => (
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
                board:
                  issues.length === 0 ? (
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
                        {translate('todo.board_settings', '看板设置')}
                      </button>
                      <div
                        className="collaboration-empty-project"
                        data-testid="collaboration-empty-project"
                      >
                        <div className="collaboration-empty-project-content">
                          <span className="collaboration-empty-project-icon">◇</span>
                          <span className="collaboration-empty-project-progress">
                            {messages.emptyProjectProgress}
                          </span>
                          <h2>{messages.emptyProjectTitle}</h2>
                          <p>{messages.emptyProjectHint}</p>
                          <button
                            type="button"
                            className="collaboration-primary-button"
                            data-testid="collaboration-empty-project-create"
                            onClick={() => setCreateIssueOpen(true)}
                          >
                            {messages.createIssue}
                          </button>
                          <div className="collaboration-empty-project-flow">
                            {[
                              [messages.emptyProjectStepIssue, messages.emptyProjectStepIssueHint],
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
                      onMarkRead={issue => void commands.markIssueRead(issue)}
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
                        noPriority: translate('todo.priority_none', '无优先级'),
                        search: messages.searchIssues,
                        groupBy: messages.groupBy,
                        groupStatus: messages.groupStatus,
                        groupPriority: messages.groupPriority,
                        groupAssignee: messages.groupAssignee,
                        groupTag: messages.groupTag,
                        unassigned: messages.unassigned,
                        noTag: messages.noTag,
                      }}
                      onOpen={issue =>
                        host.navigate({
                          projectId: project.id,
                          issueId: issue.id,
                          view: 'board',
                        })
                      }
                      onMove={async (issue, mutation) => {
                        if (mutation.kind === 'status') {
                          await commands.reorderIssue({
                            issue,
                            status: mutation.status,
                            laneIds: mutation.laneIds,
                            optimisticItems: mutation.optimisticItems,
                          })
                          return
                        }
                        if (mutation.kind === 'assignee' && mutation.assigneeType) {
                          await commands.assignIssue(String(project.id), issue.id, {
                            version: issue.version,
                            assigneeType: mutation.assigneeType,
                            assigneeId: mutation.assigneeId!,
                            notifyAssignee: true,
                          })
                          return
                        }
                        await commands.updateIssue(
                          issue.id,
                          mutation.kind === 'priority'
                            ? {
                                version: issue.version,
                                priority: mutation.priority as CollaborationIssue['priority'],
                              }
                            : mutation.kind === 'tag'
                              ? { version: issue.version, tags: mutation.tags }
                              : {
                                  version: issue.version,
                                  assigneeUserId: null,
                                  assigneeAgentId: null,
                                  assigneeTeamId: null,
                                },
                          { throwOnError: true }
                        )
                      }}
                      onCreateIssue={() => setCreateIssueOpen(true)}
                      onOpenBoardSettings={() => setBoardSettingsOpen(true)}
                      onDeleteIssue={issueDeleteAvailable ? requestIssueDelete : undefined}
                      onGroupByChange={groupBy =>
                        commands.changeProjectGroup({
                          project,
                          groupBy,
                          defaultStatuses: projectStatuses(project, messages, translate),
                        })
                      }
                      renderIssueCard={
                        renderBoardIssueCard
                          ? context =>
                              renderBoardIssueCard({
                                ...context,
                                onMarkRead: async () => {
                                  await commands.markIssueRead(context.issue)
                                },
                              })
                          : undefined
                      }
                    />
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
                      allLabel={locale === 'zh-CN' ? '全部' : 'All'}
                      tagLabel={messages.issueTags}
                      manualAssignmentLabel={translate(
                        'todo.manual_assignment',
                        locale === 'zh-CN' ? 'Issue 内分配' : 'Assigned in Issue'
                      )}
                      actionsLabel={translate('common.actions', '操作')}
                      deleteLabel={translate('todo.delete_issue', '删除任务')}
                      onDelete={issueDeleteAvailable ? requestIssueDelete : undefined}
                      statusName={status =>
                        projectStatuses(project, messages, translate).find(
                          candidate => candidate.id === status
                        )?.name ?? status
                      }
                      onCreate={() => setCreateIssueOpen(true)}
                      onOpen={issue =>
                        host.navigate({
                          projectId: project.id,
                          issueId: issue.id,
                          view: 'table',
                        })
                      }
                    />
                  </div>
                ),
                files: (
                  <div className="collaboration-project-content">
                    <CollaborationFilesAdapter api={api} project={project} locale={locale} />
                  </div>
                ),
                manage: (
                  <ProjectSettingsShell
                    ariaLabel={messages.settings}
                    onSectionChange={setSettingsSectionId}
                    selectedSectionId={settingsSectionId}
                    sections={[
                      {
                        id: 'project',
                        label: messages.projectConfiguration,
                        testId: 'collaboration-project-settings-project',
                        content: (
                          <CollaborationSettings
                            api={api}
                            key={project.id}
                            project={project}
                            onChange={commands.replaceProject}
                            onError={() => commands.reportError(messages.saveFailed)}
                            translate={translate}
                            section="overview"
                          />
                        ),
                      },
                      {
                        id: 'collaboration-participants',
                        label: messages.collaborationParticipants,
                        testId: 'collaboration-project-settings-participants',
                        content: (
                          <ProjectCollaborationParticipants
                            translate={translate}
                            membersContent={
                              <CollaborationSettings
                                api={api}
                                embedded
                                project={project}
                                onChange={commands.replaceProject}
                                onError={() => commands.reportError(messages.saveFailed)}
                                translate={translate}
                                section="members"
                              />
                            }
                            agentsContent={
                              <CollaborationSettings
                                agentConfigurationHost={host.projectAgentConfiguration}
                                agentResourceContext={host.projectAgentResourceContext}
                                api={api}
                                embedded
                                project={project}
                                onChange={commands.replaceProject}
                                onError={() => commands.reportError(messages.saveFailed)}
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
                                    project.access_role === 'Owner' ||
                                    project.access_role === 'Maintainer'
                                  }
                                />
                              ) : (
                                <div
                                  className="rounded-xl border border-border bg-surface-subtle px-5 py-4 text-sm text-text-muted"
                                  data-testid="collaboration-project-groups-unavailable"
                                >
                                  {translate(
                                    'todo.collaboration_groups_unavailable_description',
                                    '协作小组服务当前不可用。'
                                  )}
                                </div>
                              )
                            }
                          />
                        ),
                      },
                      {
                        id: 'environments',
                        label: messages.projectEnvironments,
                        testId: 'collaboration-project-settings-environments',
                        content: (
                          <ProjectExecutionEnvironments
                            api={api}
                            project={project}
                            translate={translate}
                          />
                        ),
                      },
                      ...(host.capabilities.automation && api.automations
                        ? [
                            {
                              id: 'automatic-processing',
                              label: messages.automaticProcessing,
                              testId: 'collaboration-project-settings-automatic-processing',
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
                  location: 'cloud',
                  create: api.projects.create,
                },
              ]}
              defaultLocation="cloud"
              allowDingTalkAITable={host.capabilities.dingtalkAitable}
              labels={projectCreateLabels[locale]}
              testIds={{
                name: 'collaboration-project-name-input',
                description: 'collaboration-project-description-input',
                confirm: collaborationTestIds.createProjectConfirm,
              }}
              host={host.projectCreate}
              onClose={() => setCreateProjectOpen(false)}
              onCreated={created => {
                setCreateProjectOpen(false)
                host.navigate({
                  projectId: created.id,
                  issueId: null,
                  view: 'board',
                })
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
              onCreated={created => {
                commands.appendIssue(created)
                setCreateIssueOpen(false)
                host.navigate({
                  projectId: project.id,
                  issueId: created.id,
                  view: 'board',
                })
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
                taskBindings: taskBindings.filter(binding => binding.issueId === selectedIssue.id),
                onClose: () => {
                  commands.clearSelectedIssue()
                  host.navigate({
                    projectId: project.id,
                    issueId: null,
                    view: host.location.view,
                  })
                },
                onChange: commands.replaceIssue,
                onCreateTask: onCreateTask
                  ? workflowStep => onCreateTask(project, selectedIssue, workflowStep)
                  : undefined,
                onDelete:
                  issueDeleteAvailable && canEditCollaborationIssue(selectedIssue)
                    ? () => requestIssueDelete(selectedIssue)
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
                messages={messages}
                translate={translate}
                onClose={() => {
                  commands.clearSelectedIssue()
                  host.navigate({
                    projectId: project.id,
                    issueId: null,
                    view: host.location.view,
                  })
                }}
                onChange={commands.replaceIssue}
                onCommentsChange={nextComments =>
                  commands.replaceComments(selectedIssue.id, nextComments)
                }
                onAssignmentsChange={nextAssignments => {
                  commands.replaceAssignments(selectedIssue.id, nextAssignments)
                  replaceIssueAssignments(selectedIssue.id, nextAssignments)
                }}
                onCreateTask={
                  onCreateTask
                    ? workflowStep => onCreateTask(project, selectedIssue, workflowStep)
                    : undefined
                }
                onDelete={
                  issueDeleteAvailable && canEditCollaborationIssue(selectedIssue)
                    ? () => requestIssueDelete(selectedIssue)
                    : undefined
                }
                onConflict={commands.refreshSelectedIssue}
                onError={() => commands.reportError(messages.saveFailed)}
              />
            )
          ) : null}
          {deleteIssueTarget ? (
            <IssueDeleteDialog
              busy={deleteIssueBusy}
              error={deleteIssueError}
              hasChildren={issues.some(candidate => candidate.parent_id === deleteIssueTarget.id)}
              onCancel={closeIssueDelete}
              onConfirm={() => void confirmIssueDelete()}
              title={deleteIssueTarget.title}
              translate={translate}
            />
          ) : null}
        </section>
      </BrowserTaskDrafts>
    </RuntimeConfigurationProvider>
  )
}
