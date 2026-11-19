import { milestonePageProps } from './collaborationAppMilestoneFilter'
import {
  collaborationAppProjectViewCatalog,
  resolveCollaborationAppProjectView,
} from './collaborationAppProjectViews'
import { useMilestones, milestoneVisibilityScope } from './milestones/useMilestones'
import { useMilestoneFilter } from './milestones/useMilestoneFilter'
import { MilestoneBulkAction } from './milestones/MilestoneBulkAction'
import { MilestonesPage } from './milestones/MilestonesPage'
import { MilestonePicker } from './milestones/MilestonePicker'
import { milestoneMessages } from './milestones/messages'
// SPDX-FileCopyrightText: 2026 Weibo, Inc.
//
// SPDX-License-Identifier: Apache-2.0

import { projectStatuses } from './board'
import { useCollaborationTemplateStore } from './templates/context'
import { bulkIssueStatus } from './platform/bulkIssueStatus'
import { runnerEnvironmentError } from './execution-environment/runnerEnvironmentError'
import { BrowserTaskDrafts } from './issue-detail/BrowserTaskDrafts'
import { saveProjectBoardViews } from './project-board/saveProjectBoardViews'
import { RuntimeConfigurationProvider } from './runtime-profile/RuntimeConfigurationProvider'
import { useMemo } from 'react'

import { collaborationMessages, createCollaborationTranslator } from './i18n'
import { collaborationTestIds } from './testIds'
import { IssueDetail } from './IssueDetail'
import { IssueExecutionEnvironmentNotice } from './execution-environment/IssueExecutionEnvironmentNotice'
import { useProjectExecutionEnvironmentReadiness } from './execution-environment/issueEnvironmentReadiness'
import { renderCollaborationAppArchiveDialogs } from './collaborationAppArchiveDialogs'
import { useCollaborationAppState } from './useCollaborationAppState'
import type { CollaborationAppProps } from './collaborationAppTypes'
export type { CollaborationIssueDetailRenderContext } from './collaborationAppTypes'
import { CollaborationProjectViewShell, ProjectLoadingSkeleton } from './project-shell'
import { ProjectCalendarView, ProjectGanttView } from './project-schedule/ProjectScheduleViews'
import { useProjectScheduleViewOptions } from './project-schedule/useProjectScheduleViewOptions'
import { CollaborationFilesAdapter } from './web-adapter/CollaborationFilesAdapter'
import { MyWorkAdapter } from './web-adapter/MyWorkAdapter'
import { ProjectBoardAdapter } from './web-adapter/ProjectBoardAdapter'
import { WorkspaceProjectsHomeAdapter } from './web-adapter/WorkspaceProjectsHomeAdapter'
import type { CollaborationAssignment, CollaborationIssue, CollaborationView } from './types'
import { executeStandardCloudBoardMutation } from './project-board/useStandardCloudBoardController'
import { useCollaborationWorkspaceController } from './workspace-controller'
import { canEditCollaborationIssue } from './permissions'
import { renderCollaborationAppCreateDialogs } from './collaborationAppCreateDialogs'
import { ProjectIssueTable, useIssueAssignmentsByIssueId } from './platform'
import { renderCollaborationAppSettings } from './collaborationAppSettings'

export function CollaborationApp({
  participationUserId,
  parentGroupingEnabled = false,
  api,
  host,
  initialProject,
  locale = 'zh-CN',
  pollIntervalMs = 15_000,
  createProjectRequestKey = 0,
  refreshProjectRequestKey = 0,
  showProjectBack = true,
  issueArchiveEnabled = false,
  normalizePastedFiles,
  onProjectChange,
  onCreateTask,
  onPrepareIssueArchive,
  renderBoardIssueCard,
  renderIssueDetail,
  isIssueRunning,
}: CollaborationAppProps) {
  const messages = collaborationMessages[locale]
  const templateStore = useCollaborationTemplateStore()
  const translate = useMemo(() => createCollaborationTranslator(locale), [locale])
  const { state, commands } = useCollaborationWorkspaceController({
    api,
    location: host.location,
    initialProject,
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
  const milestonesEnabled = Boolean(
    api.milestones && project && ['local', 'backend'].includes(project.task_provider)
  )
  const projectViewCatalog = useMemo(
    () =>
      collaborationAppProjectViewCatalog(
        messages,
        milestoneMessages[locale].title,
        milestonesEnabled
      ),
    [messages, locale, milestonesEnabled]
  )
  const projectViewNavigation = useMemo(
    () =>
      !loading && project && String(project.id) === String(host.location.projectId)
        ? resolveCollaborationAppProjectView(project, host.location.view, projectViewCatalog)
        : undefined,
    [loading, project, host.location.projectId, host.location.view, projectViewCatalog]
  )
  const { assignmentsByIssueId, replaceIssueAssignments } = useIssueAssignmentsByIssueId({
    assignmentsApi: api.assignments,
    issues,
    enabled: project !== null && host.location.view === 'table',
  })
  const environmentReadiness = useProjectExecutionEnvironmentReadiness({
    api,
    project,
  })
  const scheduleView = useProjectScheduleViewOptions(project)
  const {
    createProjectOpen,
    setCreateProjectOpen,
    issueBoard,
    setIssueBoard,
    createIssueOpen,
    setCreateIssueOpen,
    createIssueDefaults,
    setCreateIssueDefaults,
    settingsSectionId,
    setSettingsSectionId,
    appState,
    archiveIssueTargets,
    archiveIssueBusy,
    archiveIssueError,
    archiveDrawerOpen,
    archivedIssues,
    archiveNextCursor,
    archiveDrawerLoading,
    archiveDrawerError,
    restoringIssueId,
    savingScheduleView,
    saveScheduleView,
    confirmIssueArchive,
    closeIssueArchive,
    loadArchivedIssues,
    openArchiveDrawer,
    closeArchiveDrawer,
    restoreArchivedIssue,
  } = useCollaborationAppState(
    {
      api,
      project,
      projects,
      issues,
      host,
      commands,
      refreshProjectRequestKey,
      messages,
      translate,
      onPrepareIssueArchive,
      acceptProjectOptions: scheduleView.acceptProjectOptions,
      projectViewNavigation,
    },
    createProjectRequestKey
  )
  const canSaveScheduleView =
    project?.project_store === 'local' ||
    project?.access_role === 'Owner' ||
    project?.access_role === 'Maintainer'
  const requestIssueCreate = () => {
    if (!project) return
    setCreateIssueDefaults(undefined)
    setCreateIssueOpen(true)
  }
  const requestIssueArchive = (issue: CollaborationIssue) => appState.requestIssueArchive([issue])
  const navigateView = (view: CollaborationView) => {
    host.navigate({
      projectId: project?.id ?? null,
      issueId: null,
      view,
      projectSettingsSection: view === 'manage' ? settingsSectionId : null,
    })
  }
  const issueArchiveAvailable = issueArchiveEnabled
  const environmentNotice = project ? (
    <IssueExecutionEnvironmentNotice
      canManage={project.access_role === 'Owner' || project.access_role === 'Maintainer'}
      onOpenEnvironmentSettings={() =>
        host.navigate({
          projectId: project.id,
          issueId: null,
          view: 'manage',
          projectSettingsSection: 'environments',
        })
      }
      readiness={environmentReadiness}
      translate={translate}
    />
  ) : null

  const milestoneFilter = useMilestoneFilter(project?.id, host.location.view, issues)
  const { value: currentMilestoneFilter, filteredIssues } = milestoneFilter
  const milestoneLabels = milestoneMessages[locale]
  const boardMilestones = useMilestones(
    api.milestones,
    project?.id ?? '',
    milestonesEnabled && ['board', 'table'].includes(host.location.view),
    issues.map(issue => `${issue.id}:${issue.version}`).join('|'),
    project ? milestoneVisibilityScope(project) : ''
  )
  const hasHeaderCreateAction =
    host.location.view === 'board' ||
    host.location.view === 'calendar' ||
    host.location.view === 'gantt'
  const milestoneFilterControl =
    milestonesEnabled && project ? (
      <div className="min-w-0 max-w-full shrink-0">
        <MilestonePicker
          api={api.milestones}
          query={boardMilestones}
          projectId={project.id}
          value={currentMilestoneFilter}
          onChange={milestoneFilter.select}
          label={milestoneLabels.title}
          searchLabel={milestoneLabels.search}
          emptyLabel={milestoneLabels.noMatches}
          noneLabel={milestoneLabels.none}
          allLabel={milestoneLabels.all}
          errorLabel={milestoneLabels.error}
          retryLabel={milestoneLabels.retry}
          onMissingValue={milestoneFilter.clear}
          compact
          testId="milestone-filter"
        />
      </div>
    ) : null

  const renderIssueTable = (
    tableIssues: CollaborationIssue[],
    view: CollaborationView,
    tableAssignments: Record<string, CollaborationAssignment[]> = assignmentsByIssueId,
    options: { emptyLabel?: string; milestoneId?: string } = {}
  ) => {
    if (!project) return null
    return (
      <ProjectIssueTable
        issues={tableIssues}
        toolbarAction={view === 'table' ? milestoneFilterControl : null}
        renderBulkActions={
          milestonesEnabled
            ? selected => (
                <MilestoneBulkAction
                  api={api}
                  projectId={project.id}
                  issues={selected}
                  locale={locale}
                  onUpdated={commands.replaceIssue}
                />
              )
            : undefined
        }
        assignmentsByIssueId={tableAssignments}
        emptyLabel={options.emptyLabel ?? messages.noIssues}
        issueLabel={messages.issueTitle}
        statusLabel={messages.issueStatus}
        assignmentsLabel={messages.assignments}
        executionLabel={messages.executionStatus}
        updatedLabel={messages.updatedAt}
        startAtLabel={messages.startTime}
        dueAtLabel={messages.endTime}
        projectKey={project.project_key}
        searchPlaceholder={messages.searchIssues}
        createLabel={messages.createIssue}
        allLabel={locale === 'zh-CN' ? '全部' : 'All'}
        tagLabel={messages.issueTags}
        actionsLabel={translate('common.actions', '操作')}
        deleteLabel={translate('todo.archive_issue', '归档任务')}
        selectAllLabel={
          locale === 'zh-CN' ? '选择当前筛选结果中的全部任务' : 'Select all visible issues'
        }
        selectIssueLabel={locale === 'zh-CN' ? '选择任务' : 'Select issue'}
        selectedLabel={locale === 'zh-CN' ? '项已选择' : 'selected'}
        batchStatusLabel={locale === 'zh-CN' ? '批量修改状态' : 'Change status'}
        batchApplyLabel={locale === 'zh-CN' ? '应用' : 'Apply'}
        batchDeleteLabel={locale === 'zh-CN' ? '批量归档' : 'Archive selected'}
        availableStatuses={projectStatuses(project, messages, translate).map(status => status.id)}
        canDelete={issue => issue.status === 'completed'}
        onDelete={
          issueArchiveAvailable
            ? issue => {
                if (issue.status === 'completed') requestIssueArchive(issue)
              }
            : undefined
        }
        onBulkDelete={
          issueArchiveAvailable
            ? selectedIssues => {
                const completedIssues = selectedIssues.filter(issue => issue.status === 'completed')
                if (completedIssues.length === 0) return
                appState.requestIssueArchive(completedIssues)
              }
            : undefined
        }
        batchFailedLabel={translate(
          'todo.batch_status_failed',
          '部分任务更新失败，请查看以下原因并重试。'
        )}
        onBulkStatusChange={(selectedIssues, status) =>
          bulkIssueStatus(
            selectedIssues,
            issue =>
              commands.updateIssue(
                issue.id,
                { version: issue.version, status },
                { throwOnError: true }
              ),
            error =>
              runnerEnvironmentError(error, translate) ??
              (error instanceof Error ? error.message : messages.saveFailed)
          )
        }
        statusName={status =>
          projectStatuses(project, messages, translate).find(candidate => candidate.id === status)
            ?.name ?? status
        }
        onCreate={
          options.milestoneId
            ? () => {
                setCreateIssueDefaults({
                  status: project.board_config?.statuses?.[0]?.id ?? 'inbox',
                  tags: [],
                  parent: null,
                  milestoneId: options.milestoneId,
                  draftScope: `milestone:${options.milestoneId}`,
                })
                setCreateIssueOpen(true)
              }
            : requestIssueCreate
        }
        onOpen={issue =>
          host.navigate({
            projectId: project.id,
            issueId: issue.id,
            view,
          })
        }
      />
    )
  }

  if (selectedIssue?.invited_only) {
    return (
      <section
        className="collaboration-app collaboration-app-project issue-drawer-workspace"
        data-testid={collaborationTestIds.root}
      >
        <IssueDetail
          api={api}
          issue={selectedIssue}
          allIssues={[selectedIssue]}
          comments={comments}
          assignments={assignments}
          messages={messages}
          translate={translate}
          onClose={() => {
            commands.clearSelectedIssue()
            host.navigate({ ...host.location, projectId: null, issueId: null })
          }}
          onChange={commands.replaceIssue}
          onRead={commands.confirmIssueRead}
          onCommentsChange={next => commands.replaceComments(selectedIssue.id, next)}
          onConflict={async () => {
            await commands.loadSelectedIssue(selectedIssue.id)
          }}
          onError={() => commands.reportError(messages.loadFailed)}
        />
      </section>
    )
  }

  if (loading) {
    return (
      <ProjectLoadingSkeleton
        testId={collaborationTestIds.root}
        label={messages.loading}
        layout={
          host.location.projectId &&
          (host.location.view === 'board' ||
            host.location.view === 'calendar' ||
            host.location.view === 'gantt')
            ? 'board'
            : 'list'
        }
      />
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
              labels={projectViewCatalog.labels}
              extensions={[
                {
                  ...projectViewCatalog.extensions.milestones,
                  content:
                    host.location.view === 'milestones' ? (
                      <MilestonesPage
                        key={project.id}
                        api={api}
                        project={project}
                        issues={issues}
                        locale={locale}
                        {...milestonePageProps(milestoneFilter, project.id, commands)}
                        onOpenArchive={issueArchiveAvailable ? openArchiveDrawer : undefined}
                        renderIssues={(linkedIssues, linkedAssignments, emptyLabel, milestoneId) =>
                          renderIssueTable(linkedIssues, 'milestones', linkedAssignments, {
                            emptyLabel,
                            milestoneId,
                          })
                        }
                      />
                    ) : null,
                },
                {
                  ...projectViewCatalog.extensions.calendar,
                  content: (
                    <ProjectCalendarView
                      issues={issues}
                      locale={locale}
                      statuses={projectStatuses(project, messages, translate)}
                      viewOptions={scheduleView.options}
                      hasPersonalViewOptions={scheduleView.hasPersonalOverride}
                      savingProjectViewOptions={savingScheduleView}
                      onViewOptionsChange={scheduleView.changeOptions}
                      onResetViewOptions={scheduleView.resetOptions}
                      onSaveProjectViewOptions={canSaveScheduleView ? saveScheduleView : undefined}
                      onOpen={issue =>
                        host.navigate({
                          projectId: project.id,
                          issueId: issue.id,
                          view: 'calendar',
                        })
                      }
                      onSchedule={async (issue, range) => {
                        await commands.updateIssue(issue.id, {
                          version: issue.version,
                          startAt: range.startAt,
                          dueAt: range.dueAt,
                        })
                      }}
                    />
                  ),
                },
                {
                  ...projectViewCatalog.extensions.gantt,
                  content: (
                    <ProjectGanttView
                      issues={issues}
                      locale={locale}
                      statuses={projectStatuses(project, messages, translate)}
                      viewOptions={scheduleView.options}
                      hasPersonalViewOptions={scheduleView.hasPersonalOverride}
                      savingProjectViewOptions={savingScheduleView}
                      onViewOptionsChange={scheduleView.changeOptions}
                      onResetViewOptions={scheduleView.resetOptions}
                      onSaveProjectViewOptions={canSaveScheduleView ? saveScheduleView : undefined}
                      onOpen={issue =>
                        host.navigate({
                          projectId: project.id,
                          issueId: issue.id,
                          view: 'gantt',
                        })
                      }
                      onSchedule={async (issue, range) => {
                        await commands.updateIssue(issue.id, {
                          version: issue.version,
                          startAt: range.startAt,
                          dueAt: range.dueAt,
                        })
                      }}
                    />
                  ),
                },
              ]}
              testIds={projectViewCatalog.testIds}
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
              hasCreateAction={hasHeaderCreateAction}
              sidebarCollapsed={false}
              compactTitle={project.name}
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
                  {host.renderProjectHeaderAction?.(project)}
                  {hasHeaderCreateAction ? (
                    <button
                      ref={actionRefs.add}
                      type="button"
                      className="relative z-10 ml-2 flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg bg-text-primary px-3 text-sm font-medium text-background"
                      data-testid={collaborationTestIds.createIssue}
                      aria-label={messages.createIssue}
                      title={messages.createIssue}
                      onClick={requestIssueCreate}
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
                      aria-label={action.label}
                      title={action.label}
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
                    <ProjectBoardAdapter
                      projectApi={api.projects}
                      onProjectMigrated={commands.replaceProject}
                      participationUserId={participationUserId}
                      isIssueRunning={isIssueRunning}
                      parentGroupingEnabled={parentGroupingEnabled}
                      emptyState={
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
                      }
                      filterAction={milestoneFilterControl}
                      toolbarAction={host.renderBoardToolbarAction?.(project)}
                      onMarkRead={issue => void commands.markIssueRead(issue)}
                      runtime={api.runtime}
                      previewDisabled={Boolean(selectedIssue)}
                      translate={translate}
                      agents={agents ?? []}
                      boardError={error}
                      project={project}
                      issues={filteredIssues}
                      allIssues={issues}
                      milestones={boardMilestones.items}
                      onOpenChildren={milestoneFilter.openChildren}
                      onCurrentParentIdChange={milestoneFilter.changeParent}
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
                      onOpen={(issue, board) => {
                        setIssueBoard(
                          board
                            ? {
                                issueId: issue.id,
                                projectId: project.id,
                                board,
                              }
                            : null
                        )
                        host.navigate({
                          projectId: project.id,
                          issueId: issue.id,
                          view: 'board',
                        })
                      }}
                      onMove={async (issue, mutation) => {
                        await executeStandardCloudBoardMutation({
                          item: issue,
                          mutation,
                          commands: {
                            update: async (target, input) => {
                              const updated = await commands.updateIssue(
                                target.id,
                                {
                                  version: target.version,
                                  position: input.position,
                                  ...(input.status !== undefined ? { status: input.status } : {}),
                                  ...(input.priority !== undefined
                                    ? {
                                        priority: input.priority as CollaborationIssue['priority'],
                                      }
                                    : {}),
                                  ...(input.tags !== undefined ? { tags: input.tags } : {}),
                                  ...(input.assignee_user_id !== undefined
                                    ? {
                                        assigneeUserId: input.assignee_user_id,
                                      }
                                    : {}),
                                  ...(input.assignee_agent_id !== undefined
                                    ? {
                                        assigneeAgentId: input.assignee_agent_id,
                                      }
                                    : {}),
                                  ...(input.assignee_team_id !== undefined
                                    ? {
                                        assigneeTeamId: input.assignee_team_id,
                                      }
                                    : {}),
                                },
                                { throwOnError: true }
                              )
                              if (!updated) throw new Error(messages.saveFailed)
                              return updated
                            },
                            assign: async (target, assignment) => {
                              const updated = await commands.assignIssue(
                                String(project.id),
                                target.id,
                                {
                                  version: target.version,
                                  ...assignment,
                                }
                              )
                              if (!updated) throw new Error(messages.saveFailed)
                              return updated
                            },
                            refreshOrder: async target => {
                              await commands.loadProjectSnapshot(target.cloud_project_id, {
                                invalidate: true,
                                throwOnError: true,
                              })
                            },
                          },
                        })
                      }}
                      onCreateIssue={requestIssueCreate}
                      onCreateUnmatchedIssue={defaults => {
                        setCreateIssueDefaults(defaults)
                        setCreateIssueOpen(true)
                      }}
                      onDeleteIssue={issueArchiveAvailable ? requestIssueArchive : undefined}
                      onArchiveCompleted={
                        issueArchiveAvailable
                          ? completedIssues => {
                              if (completedIssues.length === 0) return
                              appState.requestIssueArchive(completedIssues)
                            }
                          : undefined
                      }
                      onOpenArchive={issueArchiveAvailable ? openArchiveDrawer : undefined}
                      onSaveViews={async (boardViews, settings) => {
                        await saveProjectBoardViews({
                          api: api.projects,
                          projectId: project.id,
                          version: project.version,
                          config: boardViews,
                          settings,
                          accept: commands.replaceProject,
                          translate,
                        })
                      }}
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
                  </div>
                ),
                table: (
                  <div className="collaboration-project-content">
                    {renderIssueTable(filteredIssues, 'table')}
                  </div>
                ),
                files: (
                  <div className="collaboration-project-content">
                    <CollaborationFilesAdapter api={api} project={project} locale={locale} />
                  </div>
                ),
                manage: renderCollaborationAppSettings({
                  api,
                  project,
                  host,
                  locale,
                  messages,
                  translate,
                  templateStore,
                  members,
                  agents,
                  commands,
                  settingsSectionId,
                  setSettingsSectionId,
                  onProjectChange,
                }),
              }}
            />
          )}
          {renderCollaborationAppCreateDialogs({
            api,
            project,
            host,
            commands,
            locale,
            allIssues: issues,
            environmentNotice,
            environmentReadiness: environmentReadiness.kind,
            messages,
            translate,
            normalizePastedFiles,
            createProjectOpen,
            setCreateProjectOpen,
            createIssueOpen,
            setCreateIssueOpen,
            createIssueDefaults,
          })}
          {selectedIssue && project ? (
            renderIssueDetail ? (
              renderIssueDetail({
                commentBoard:
                  issueBoard?.issueId === selectedIssue.id && issueBoard.projectId === project.id
                    ? issueBoard.board
                    : undefined,
                api,
                project,
                issue: selectedIssue,
                allIssues: issues,
                assignments,
                taskBindings: taskBindings.filter(binding => binding.issueId === selectedIssue.id),
                defaultAssistant: host.defaultAssistant,
                onClose: () => {
                  commands.clearSelectedIssue()
                  host.navigate({
                    projectId: project.id,
                    issueId: null,
                    view: host.location.view,
                  })
                },
                onChange: commands.replaceIssue,
                onRead: commands.confirmIssueRead,
                onOpenRelatedIssue: related => {
                  if (related.can_view_detail === false || related.cloud_project_id !== project.id)
                    return
                  host.navigate({
                    projectId: project.id,
                    issueId: related.id,
                    view: host.location.view,
                  })
                },
                onAddChild: canEditCollaborationIssue(selectedIssue)
                  ? () => {
                      setCreateIssueDefaults({
                        status: projectStatuses(project, messages, translate)[0]?.id ?? 'inbox',
                        tags: [],
                        draftScope: `child:${selectedIssue.id}`,
                        parent: selectedIssue,
                      })
                      setCreateIssueOpen(true)
                    }
                  : undefined,
                onCreateTask: onCreateTask ? () => onCreateTask(project, selectedIssue) : undefined,
                onDelete:
                  issueArchiveAvailable && canEditCollaborationIssue(selectedIssue)
                    ? () => requestIssueArchive(selectedIssue)
                    : undefined,
              })
            ) : (
              <IssueDetail
                commentBoard={
                  issueBoard?.issueId === selectedIssue.id && issueBoard.projectId === project.id
                    ? issueBoard.board
                    : undefined
                }
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
                normalizePastedFiles={normalizePastedFiles}
                onClose={() => {
                  commands.clearSelectedIssue()
                  host.navigate({
                    projectId: project.id,
                    issueId: null,
                    view: host.location.view,
                  })
                }}
                onChange={commands.replaceIssue}
                onRead={commands.confirmIssueRead}
                onCommentsChange={nextComments =>
                  commands.replaceComments(selectedIssue.id, nextComments)
                }
                onAssignmentsChange={nextAssignments => {
                  commands.replaceAssignments(selectedIssue.id, nextAssignments)
                  replaceIssueAssignments(selectedIssue.id, nextAssignments)
                }}
                onCreateTask={onCreateTask ? () => onCreateTask(project, selectedIssue) : undefined}
                onDelete={
                  issueArchiveAvailable && canEditCollaborationIssue(selectedIssue)
                    ? () => requestIssueArchive(selectedIssue)
                    : undefined
                }
                onConflict={commands.refreshSelectedIssue}
                onError={() => commands.reportError(messages.saveFailed)}
              />
            )
          ) : null}
          {renderCollaborationAppArchiveDialogs({
            archiveIssueTargets,
            archiveIssueBusy,
            archiveIssueError,
            archiveDrawerOpen,
            archivedIssues,
            archiveNextCursor,
            archiveDrawerLoading,
            archiveDrawerError,
            restoringIssueId,
            confirmIssueArchive,
            closeIssueArchive,
            loadArchivedIssues,
            closeArchiveDrawer,
            restoreArchivedIssue,
            issues,
            translate,
          })}
        </section>
      </BrowserTaskDrafts>
    </RuntimeConfigurationProvider>
  )
}
