import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { BaseBoardStatusMigrationNotice } from '@wegent/collaboration'
import type {
  NativeBoardGroupBy,
  LocatedCloudProject,
  LocatedLoopItem,
} from './cloudTodoWorkspaceTypes'
import {
  nativeBoardGroupFields,
  aitableCellLabels,
  AITableGroupFieldPicker,
  withBoardTaskModelSelection,
} from './cloudTodoWorkspaceSupport'
import { CloudTodoBoardSkeleton, CloudTodoStartupAnimation } from './CloudTodoWorkspaceControls'
import { IssueChangeRequestBadges } from '@/features/change-requests/IssueChangeRequestBadges'
import {
  BoardViewNavigation,
  BoardViewNotice,
  isExecutionBoardColumn,
  boardDropHint,
} from '@wegent/collaboration'
import { projectBoardDragItemId } from '@wegent/collaboration/project-board/projectBoardDnd'
import { Archive, CheckCheck, Plus } from 'lucide-react'
import type { CloudLoopItem, CloudProject } from '@/api/deliveries'
import {
  CollaborationSettings,
  createProjectParticipantSections,
  projectAiSettingsGroup,
  ProjectAutomaticProcessing,
  ProjectCollaborationGroups,
  ProjectExecutionEnvironments,
  ProjectIssueTable,
} from '@wegent/collaboration'
import { ProjectSettingsShell } from '@wegent/collaboration/project-manage'
import { DesktopProjectSettingsPages } from './DesktopProjectSettingsPages'
import {
  createProjectBoardSortLabels,
  ProjectBoardBody,
  type ProjectBoardColumn,
  type ProjectBoardGroupBy,
} from '@wegent/collaboration/project-board'
import { Tooltip } from '@/components/ui/tooltip'
import { AITableView } from '@/features/todo/AITableView'
import { CloudTodoBoardCard, type BoardCardProgressDisplay } from './CloudTodoBoardCard'
import { CloudProjectManageView } from './CloudProjectManageView'
import { canEditProjectSpaceIssue } from './projectSpaceSelection'
import { CloudFilesView, LocalFilesView } from './CloudFilesView'
import { BoardQuickCreate } from './BoardQuickCreate'
import { BoardQuickStartGuide } from './BoardQuickStartGuide'
import type { CloudTodoWorkspaceViewModel } from './CloudTodoWorkspaceView'
export function createCloudTodoBoardSlots(
  model: CloudTodoWorkspaceViewModel,
  selectedProject: LocatedCloudProject
) {
  const {
    user,
    runtimeWork,
    services,
    startupActive,
    workspaceActive,
    onOpenRuntimeTask,
    onArchiveRuntimeTasks,
    t,
    i18n,
    boardTranslate,
    workbench,
    issueChangeRequestMonitor,
    changeRequestMonitor,
    cloudWorkspaceApi,
    projectAgentConfigurationHost,
    cloudWorkspace,
    localProjectManageApi,
    replaceProject,
    collaborationProjectMembers,
    connectDingTalkBoard,
    localProjectOptions,
    isMyTasksBoard,
    activeLocalProjectFilter,
    selectedLocalProject,
    selectedProjectKey,
    activeAssigneeQuickAddRequest,
    boardTaskBindings,
    loadBoardTaskRuntimeGoal,
    localProjectIdForItem,
    personalGroupKey,
    continueChangeRequestRepair,
    selectedProjectAutomationSupported,
    selectedProjectApi,
    isAITableProject,
    isExternalGitBoard,
    selectedProjectBoardItems,
    issueTableAssignmentsByIssue,
    activeExternalPageCursors,
    activeExternalPageLoading,
    selectedProjectAgents,
    agentNameById,
    boardCardDisplay,
    nativeStatuses,
    selectedGroupField,
    aitableGroupValues,
    availableTags,
    aitableApi,
    canCreateBoardTask,
    boardItemsLoading,
    isTaskBoardItemUnread,
    markTaskBoardItemRead,
    boardItems,
    savedViews,
    canManageViews,
    tagFilter,
    standardBoardController,
    activeDragItemId,
    boardBreadcrumb,
    boardColumns,
    boardParent,
    setActiveDragItemId,
    boardState,
    nativeGroupBy,
    nativeGroupFilter,
    nativeBoardQuery,
    setAitableGroupFilter,
    setQuickCreateStatus,
    parentIssueBoard,
    boardLayerCount,
    rootBoardItems,
    firstRootBoardItem,
    quickStartStorageKey,
    quickStartDetailOpened,
    taskColumnEmptyHints,
    issueColumnEmptyHints,
    consumeAssigneeQuickAddRequest,
    openBoardItem,
    projectSettingsSectionId,
    setProjectSettingsSectionId,
    setBoardSettingsOpen,
    setSelectedItem,
    boardParentId,
    setBoardParentId,
    itemTaskBindingsProjectKey,
    aitableFields,
    aitableGroupFieldId,
    setAitableGroupFieldId,
    setLocalProjectFilter,
    groupScopeBusy,
    boardError,
    baseBoardMigration,
    baseBoardStatusGrouping,
    setBoardError,
    dingtalkAuthPrompt,
    dingtalkAuthBusy,
    setBoardRefreshNonce,
    archiveBusy,
    setArchiveItem,
    setArchiveError,
    batchConfirmBusy,
    setBatchConfirmError,
    setBatchConfirmItems,
    setBatchConfirmRetryItemKeys,
    setRuntimeBatchArchiveItems,
    setBatchArchiveError,
    openTodoCreation,
    createTodoInBoardColumn,
    loadMoreExternalColumn,
    finishBoardDrop,
    saveGlobalGroupBy,
    openIssueCreation,
  } = model
  return {
    table:
      isAITableProject && aitableApi ? (
        <AITableView api={aitableApi} project={selectedProject} />
      ) : (
        <ProjectIssueTable
          issues={selectedProjectBoardItems}
          assignmentsByIssueId={issueTableAssignmentsByIssue}
          emptyLabel={t('todo.issue_table_empty', '暂无 Issue')}
          issueLabel={t('todo.issue_column', 'Issue')}
          statusLabel={t('todo.status', '状态')}
          assignmentsLabel={t('todo.assignments', '分配')}
          startAtLabel={t('todo.start_date', '开始时间')}
          dueAtLabel={t('todo.end_date', '结束时间')}
          executionLabel={t('todo.execution_status', '执行状态')}
          updatedLabel={t('todo.updated_at', '更新时间')}
          projectKey={selectedProject.project_key}
          searchPlaceholder={t('todo.search_issues', '搜索 Issue')}
          createLabel={t('todo.new_issue', '新建 Issue')}
          statusName={status =>
            nativeStatuses.find(candidate => candidate.id === status)?.name ?? status
          }
          onCreate={() => openTodoCreation(null, nativeStatuses[0]?.id ?? 'inbox')}
          onOpen={item => {
            if (item.can_view_detail !== false) {
              setSelectedItem(item as LocatedLoopItem)
            }
          }}
        />
      ),
    files: (selectedProject.location === 'cloud' ? cloudWorkspaceApi : selectedProjectApi) ? (
      selectedProject.location === 'cloud' ? (
        <CloudFilesView api={cloudWorkspaceApi!} project={selectedProject} />
      ) : (
        <LocalFilesView api={selectedProjectApi!} project={selectedProject} />
      )
    ) : null,
    manage: (selectedProject.location === 'cloud' ? cloudWorkspaceApi : selectedProjectApi) ? (
      <ProjectSettingsShell
        pageRenderer={DesktopProjectSettingsPages}
        scopeKey={`${selectedProject.location}:${selectedProject.id}`}
        ariaLabel={t('todo.project_settings', '项目设置')}
        selectedSectionId={projectSettingsSectionId}
        onSectionChange={setProjectSettingsSectionId}
        sections={[
          {
            id: 'project',
            label: t('todo.basic_information', '基本信息'),
            testId: 'cloud-project-settings-project',
            content:
              selectedProject.location === 'cloud' ? (
                <CloudProjectManageView
                  api={cloudWorkspaceApi!}
                  aitableApi={aitableApi}
                  dwsApi={services.dwsApi}
                  project={selectedProject}
                  boardCardDisplay={boardCardDisplay}
                  section="overview"
                  onProjectUpdated={updated => replaceProject(selectedProject, updated)}
                />
              ) : (
                <CloudProjectManageView
                  api={localProjectManageApi!}
                  aitableApi={aitableApi}
                  dwsApi={services.dwsApi}
                  project={selectedProject}
                  boardCardDisplay={boardCardDisplay}
                  section="overview"
                  onProjectUpdated={updated => replaceProject(selectedProject, updated)}
                />
              ),
          },
          ...createProjectParticipantSections({
            translate: (key, fallback, options) =>
              fallback === undefined ? t(key, options) : t(key, fallback, options),
            membersContent: (
              <CollaborationSettings
                api={
                  selectedProject.location === 'cloud' ? cloudWorkspaceApi! : localProjectManageApi!
                }
                embedded
                project={selectedProject}
                quickAddRequest={activeAssigneeQuickAddRequest ?? undefined}
                onQuickAddRequestConsumed={consumeAssigneeQuickAddRequest}
                section="members"
                onChange={updated => replaceProject(selectedProject, updated as CloudProject)}
                onError={() =>
                  setBoardError(t('todo.project_members_save_failed', '项目成员保存失败'))
                }
                translate={(key, fallback, options) =>
                  fallback === undefined ? t(key, options) : t(key, fallback, options)
                }
              />
            ),
            agentsContent: (
              <CollaborationSettings
                agentConfigurationHost={projectAgentConfigurationHost}
                api={
                  selectedProject.location === 'cloud' ? cloudWorkspaceApi! : localProjectManageApi!
                }
                embedded
                project={selectedProject}
                quickAddRequest={activeAssigneeQuickAddRequest ?? undefined}
                onQuickAddRequestConsumed={consumeAssigneeQuickAddRequest}
                section="agents"
                onChange={updated => replaceProject(selectedProject, updated as CloudProject)}
                onError={() =>
                  setBoardError(t('todo.project_agents_save_failed', '项目智能体保存失败'))
                }
                onAgentsChange={() => {
                  if (selectedProject.location === 'cloud') {
                    void cloudWorkspace.commands.refreshProjectAgents(String(selectedProject.id))
                    return
                  }
                  setBoardRefreshNonce(value => value + 1)
                }}
                translate={(key, fallback, options) =>
                  fallback === undefined ? t(key, options) : t(key, fallback, options)
                }
              />
            ),
            groupsContent: (
              selectedProject.location === 'cloud'
                ? cloudWorkspaceApi?.projects.listCollaborationGroups
                : localProjectManageApi?.projects.listCollaborationGroups
            ) ? (
              <ProjectCollaborationGroups
                key={selectedProject.id}
                api={
                  selectedProject.location === 'cloud' ? cloudWorkspaceApi! : localProjectManageApi!
                }
                projectId={String(selectedProject.id)}
                workspaceId={
                  selectedProject.workspace_id ? String(selectedProject.workspace_id) : null
                }
                locale={i18n.language.startsWith('zh') ? 'zh-CN' : 'en'}
                currentUserId={Number(user.id)}
                members={collaborationProjectMembers[selectedProjectKey ?? ''] ?? []}
                agents={selectedProjectAgents.map(agent => ({
                  id: String(agent.id),
                  name: agent.name,
                  agent_id: String(agent.id),
                  ...(agent.wegentTeamId == null ? {} : { team_id: agent.wegentTeamId }),
                }))}
                canManage={['Owner', 'Maintainer'].includes(selectedProject.access_role ?? 'Owner')}
                location={selectedProject.location}
                agentConfiguration={projectAgentConfigurationHost}
                agentResourceContext={{
                  name: selectedProject.name,
                  namespace: 'default',
                }}
              />
            ) : (
              <div
                className="rounded-xl border border-border bg-surface-subtle px-5 py-4 text-sm text-text-muted"
                data-testid="cloud-project-groups-unavailable"
              >
                {t('todo.collaboration_groups_unavailable', '协作小组服务当前不可用。')}
              </div>
            ),
            testIdPrefix: 'cloud-project-settings',
          }),
          {
            id: 'environments',
            group: projectAiSettingsGroup((key, fallback) => t(key, fallback ?? key)),
            label: t('todo.project_execution_environments', '执行环境'),
            testId: 'cloud-project-settings-environments',
            content: (
              <ProjectExecutionEnvironments
                api={
                  selectedProject.location === 'cloud' ? cloudWorkspaceApi! : localProjectManageApi!
                }
                onProjectChange={updated =>
                  replaceProject(selectedProject, updated as CloudProject)
                }
                project={selectedProject}
                translate={(key, fallback, options) =>
                  fallback === undefined ? t(key, options) : t(key, fallback, options)
                }
              />
            ),
          },
          ...(selectedProjectAutomationSupported &&
          (selectedProject.location === 'cloud'
            ? Boolean(cloudWorkspaceApi?.automations)
            : Boolean(localProjectManageApi?.automations))
            ? [
                {
                  id: 'automatic-processing',
                  label: t('todo.automatic_processing', '自动处理'),
                  testId: 'cloud-project-settings-automatic-processing',
                  content: (
                    <ProjectAutomaticProcessing
                      api={
                        selectedProject.location === 'cloud'
                          ? cloudWorkspaceApi!
                          : localProjectManageApi!
                      }
                      project={selectedProject}
                      members={collaborationProjectMembers[selectedProjectKey ?? ''] ?? []}
                      agents={selectedProjectAgents.map(agent => ({
                        id: String(agent.id),
                        name: agent.name,
                        agent_id: String(agent.id),
                        ...(agent.wegentTeamId == null ? {} : { team_id: agent.wegentTeamId }),
                      }))}
                      locale={i18n.language.startsWith('zh') ? 'zh-CN' : 'en'}
                      translate={(key, fallback, options) =>
                        fallback === undefined ? t(key, options) : t(key, fallback, options)
                      }
                    />
                  ),
                },
              ]
            : []),
        ]}
      />
    ) : null,
    board: (
      <ProjectBoardBody<LocatedLoopItem>
        translate={boardTranslate}
        filterAction={
          !isAITableProject && !isExternalGitBoard && !isMyTasksBoard
            ? tagFilter.control
            : undefined
        }
        toolbarAction={parentIssueBoard.toggle}
        parentRows={
          parentIssueBoard.active
            ? {
                rows: parentIssueBoard.rows,
                scopeKey: parentIssueBoard.scopeKey,
                translate: boardTranslate,
                getParentTitle: item => item.title,
                getParentKey: item => item.id,
                onOpenParent: openBoardItem,
                onEnterParent: item => setBoardParentId(item.id),
              }
            : undefined
        }
        customView={Boolean(savedViews.view)}
        dropFeedback={
          standardBoardController.lastMove
            ? {
                ...standardBoardController.lastMove,
                message: boardTranslate('todo.board_drop_success', undefined, {
                  title:
                    boardItems.find(item => item.id === standardBoardController.lastMove?.itemId)
                      ?.title ?? '',
                  action:
                    boardColumns.find(
                      column => column.key === standardBoardController.lastMove?.columnKey
                    )?.label ?? '',
                }),
              }
            : null
        }
        viewNavigation={
          !isMyTasksBoard && !isAITableProject && !isExternalGitBoard ? (
            <BoardViewNavigation
              key={selectedProjectKey}
              controller={savedViews}
              statuses={nativeStatuses}
              tags={availableTags}
              canManage={canManageViews}
              settings={{
                cardDisplay: selectedProject?.card_display,
                boardConfig: selectedProject?.board_config,
                canEditStatuses: selectedProject?.task_provider === 'local',
              }}
              translate={boardTranslate}
            />
          ) : undefined
        }
        state={boardState}
        activeDragItemId={activeDragItemId}
        viewNotice={
          !isMyTasksBoard && !isAITableProject && !isExternalGitBoard ? (
            <BoardViewNotice
              controller={savedViews}
              statuses={nativeStatuses}
              translate={boardTranslate}
            />
          ) : undefined
        }
        boardError={boardError ?? standardBoardController.moveError}
        boardItemsLoading={boardItemsLoading}
        breadcrumb={boardBreadcrumb}
        columns={boardColumns as ProjectBoardColumn[]}
        currentParent={boardParent}
        currentParentId={boardParentId}
        onDragStart={source => {
          standardBoardController.setActiveSourceColumnKey(source.columnKey ?? null)
          setActiveDragItemId(projectBoardDragItemId(source))
        }}
        onDragCancel={() => setActiveDragItemId(null)}
        onDrop={finishBoardDrop}
        externalGroupLabel={selectedGroupField?.name ?? '记录'}
        externalGroupValues={aitableGroupValues}
        externalManagedLabel="数据由钉钉托管 · AI 可直接管理"
        externalSearchPlaceholder="搜索记录"
        focusLabels={{
          enter: t('todo.focus_view_description', '展开进行中与待确认列'),
          exit: t('todo.exit_focus_view_description', '退出执行阶段专注视图'),
          title: t('todo.focus_view', '专注视图'),
        }}
        sortLabels={
          !isExternalGitBoard && !isMyTasksBoard ? createProjectBoardSortLabels(t) : undefined
        }
        getColumnDragHint={column =>
          activeDragItemId && boardItems.some(item => item.id === activeDragItemId)
            ? boardDropHint(
                boardItems.find(item => item.id === activeDragItemId)!,
                column,
                boardColumns.find(
                  source => source.key === standardBoardController.activeSourceColumnKey
                ),
                nativeGroupBy,
                boardTranslate
              )
            : undefined
        }
        getColumnEmptyState={column => {
          const status = column.status as CloudLoopItem['status']
          const hint = (
            boardParent || isMyTasksBoard ? taskColumnEmptyHints : issueColumnEmptyHints
          )[status]
          if (!hint) return undefined
          const isTaskBoard = Boolean(boardParent) || isMyTasksBoard
          if (status !== 'inbox' && (status !== 'pending' || !isTaskBoard)) return { hint }
          return {
            hint,
            action: {
              label:
                status === 'inbox'
                  ? t(
                      isTaskBoard ? 'todo.create_first_task' : 'todo.create_first_issue',
                      isTaskBoard ? '创建第一个任务' : '创建第一个 Issue'
                    )
                  : t('todo.create_task_in_pending', '创建到待开始'),
              ariaLabel: t(isTaskBoard ? 'todo.new_task_in_column' : 'todo.new_issue_in_column', {
                column: column.label,
              }),
              onClick: () => setQuickCreateStatus(status),
            },
          }
        }}
        getColumnItems={(column, state) => {
          const standardItems = isAITableProject
            ? boardItems
            : standardBoardController.getColumnItems(column, state)
          return standardItems.filter(
            item =>
              (isAITableProject
                ? item.parent_id === boardParentId &&
                  (!column.groupValue ||
                    (column.groupValue === '未设置'
                      ? !aitableCellLabels(item.source_cells?.[aitableGroupFieldId]).length
                      : aitableCellLabels(item.source_cells?.[aitableGroupFieldId]).includes(
                          column.groupValue
                        )))
                : true) &&
              (!isMyTasksBoard ||
                activeLocalProjectFilter === 'all' ||
                !selectedLocalProject ||
                localProjectIdForItem(item) === selectedLocalProject.id ||
                (item.status === 'inbox' && localProjectIdForItem(item) === null)) &&
              (!state.externalGroupFilter || column.groupValue === state.externalGroupFilter) &&
              (!state.externalQuery.trim() ||
                `${item.title} ${item.description ?? ''}`
                  .toLowerCase()
                  .includes(state.externalQuery.trim().toLowerCase()))
          )
        }}
        getItemKey={item => item.id}
        groupFields={nativeBoardGroupFields as Array<{ id: ProjectBoardGroupBy; name: string }>}
        isExternalBoard={isAITableProject}
        isMyTasksBoard={isMyTasksBoard}
        layerCount={boardLayerCount}
        localProjectFilter={
          isMyTasksBoard
            ? {
                activeId: activeLocalProjectFilter,
                allLabel: t('todo.all_local_projects', '全部项目'),
                ariaLabel: t('todo.local_project_filter', '本地项目'),
                label: t('todo.project_with_name', '项目：{{project}}', {
                  project: '{{project}}',
                }),
                options: localProjectOptions,
                selectedName:
                  activeLocalProjectFilter === 'all'
                    ? t('todo.all_local_projects', '全部项目')
                    : (selectedLocalProject?.name ?? t('todo.select_local_project', '选择项目')),
                onChange: setLocalProjectFilter,
              }
            : undefined
        }
        onBreadcrumbSelect={setBoardParentId}
        onSaveGlobalGroupBy={saveGlobalGroupBy}
        renderColumnFooter={(column, _items, state) => {
          const status = column.status as CloudLoopItem['status']
          return canCreateBoardTask &&
            !isAITableProject &&
            (column.type ?? state.groupBy) === 'status' &&
            (status === 'inbox' || (status === 'pending' && Boolean(boardParent))) &&
            state.quickCreateStatus === status ? (
            <BoardQuickCreate
              key={`${selectedProjectKey}:${boardParentId ?? 'root'}:${column.key}`}
              columnKey={column.key}
              columnLabel={column.label}
              localProjects={isMyTasksBoard ? localProjectOptions : undefined}
              localProjectId={selectedLocalProject?.id}
              onLocalProjectChange={
                isMyTasksBoard ? id => setLocalProjectFilter(String(id)) : undefined
              }
              onCancel={() => setQuickCreateStatus(null)}
              onCreate={title => createTodoInBoardColumn(status, title)}
              onOpenFull={title =>
                boardParent
                  ? openTodoCreation(boardParent, status, title)
                  : openIssueCreation(status, title, 'popup')
              }
            />
          ) : null
        }}
        renderColumnHeaderActions={(column, columnItems, state) => {
          const status = column.status as CloudLoopItem['status']
          const editableColumnItems = columnItems.filter(canEditProjectSpaceIssue)
          const open = () =>
            !boardParent && status === 'pending'
              ? openIssueCreation('pending', '', 'popup')
              : setQuickCreateStatus(status)
          return (
            <>
              {!isMyTasksBoard &&
              !isAITableProject &&
              (column.type ?? state.groupBy) === 'status' &&
              status === 'in_review' &&
              editableColumnItems.length > 0 ? (
                <Tooltip
                  label={t('todo.batch_confirm_review_items', '批量确认完成待确认事项')}
                  side="bottom"
                  align="end"
                >
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    data-testid="cloud-todo-batch-confirm-review"
                    disabled={batchConfirmBusy}
                    onClick={() => {
                      setBatchConfirmError(null)
                      setBatchConfirmRetryItemKeys(new Set())
                      setBatchConfirmItems([...editableColumnItems])
                    }}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted opacity-0 transition hover:bg-background hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30 disabled:opacity-50 group-hover:opacity-100"
                    aria-label={t('todo.batch_confirm_review_items', '批量确认完成待确认事项')}
                  >
                    <CheckCheck className="h-3.5 w-3.5" />
                  </ControlButton>
                </Tooltip>
              ) : null}
              {isMyTasksBoard &&
              (column.type ?? state.groupBy) === 'status' &&
              status === 'completed' &&
              columnItems.length > 0 &&
              onArchiveRuntimeTasks ? (
                <Tooltip
                  label={t('todo.archive_completed_tasks', '批量归档已完成任务')}
                  side="bottom"
                  align="end"
                >
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    data-testid="cloud-my-tasks-archive-completed"
                    disabled={archiveBusy}
                    onClick={() => {
                      setBatchArchiveError(null)
                      setRuntimeBatchArchiveItems([...columnItems])
                    }}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted opacity-0 transition hover:bg-background hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30 group-hover:opacity-100"
                    aria-label={t('todo.archive_completed_tasks', '批量归档已完成任务')}
                  >
                    <Archive className="h-3.5 w-3.5" />
                  </ControlButton>
                </Tooltip>
              ) : null}
              {canCreateBoardTask &&
              !isAITableProject &&
              (column.type ?? state.groupBy) === 'status' &&
              (status === 'inbox' || status === 'pending') ? (
                <Tooltip
                  label={t(
                    boardParent || isMyTasksBoard
                      ? 'todo.new_task_in_column'
                      : 'todo.new_issue_in_column',
                    boardParent || isMyTasksBoard
                      ? '在{{column}}中新建任务'
                      : '在{{column}}中新建 Issue',
                    { column: column.label }
                  )}
                  side="bottom"
                  align="end"
                >
                  <ControlButton
                    variant="unstyled"
                    type="button"
                    data-testid={`cloud-todo-column-add-${column.key}`}
                    onClick={open}
                    className="flex h-6 w-6 items-center justify-center rounded-md text-text-muted opacity-0 transition hover:bg-background hover:text-text-primary focus-visible:opacity-100 focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-focus/30 group-hover:opacity-100"
                    aria-label={t(
                      boardParent || isMyTasksBoard
                        ? 'todo.new_task_in_column'
                        : 'todo.new_issue_in_column',
                      { column: column.label }
                    )}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </ControlButton>
                </Tooltip>
              ) : null}
            </>
          )
        }}
        renderExternalGroupPicker={() => (
          <AITableGroupFieldPicker
            fields={aitableFields}
            value={aitableGroupFieldId}
            onChange={id => {
              setAitableGroupFieldId(id)
              setAitableGroupFilter('')
            }}
          />
        )}
        renderGroupPicker={(value, onChange) =>
          baseBoardStatusGrouping ? null : (
            <AITableGroupFieldPicker
              fields={nativeBoardGroupFields}
              value={value}
              testIdPrefix="cloud-board-group"
              searchPlaceholder="搜索分组字段"
              onChange={id => onChange(id as NativeBoardGroupBy)}
            />
          )
        }
        renderBoardSettingsAction={
          !isMyTasksBoard && (isAITableProject || isExternalGitBoard)
            ? () => (
                <ControlButton
                  variant="unstyled"
                  type="button"
                  className="h-8 shrink-0 rounded-lg border border-border bg-background px-3 text-xs font-medium text-text-secondary hover:bg-muted hover:text-text-primary"
                  data-testid="cloud-board-settings"
                  disabled={!canManageViews || !savedViews.supported}
                  onClick={() => setBoardSettingsOpen(true)}
                >
                  {t('todo.board_settings', '看板设置')}
                </ControlButton>
              )
            : undefined
        }
        renderItem={(item, column, state) => {
          const progressDisplay: BoardCardProgressDisplay =
            state.focusExecutionColumns && isExecutionBoardColumn(column, state.groupBy)
              ? 'focused'
              : 'compact'
          return (
            <CloudTodoBoardCard
              projectStore={selectedProject.project_store}
              statusNames={Object.fromEntries(
                nativeStatuses.map(status => [status.id, status.name])
              )}
              item={item}
              unread={isMyTasksBoard && isTaskBoardItemUnread(item)}
              taskBindings={
                (
                  selectedProject.location === 'cloud'
                    ? cloudWorkspace.state.project?.id === String(selectedProject.id)
                    : itemTaskBindingsProjectKey === selectedProjectKey
                )
                  ? (boardTaskBindings[item.id] ?? []).map(binding =>
                      withBoardTaskModelSelection(binding, runtimeWork)
                    )
                  : []
              }
              onClick={() => {
                openBoardItem(item)
              }}
              onArchive={() => {
                setArchiveError(null)
                setArchiveItem(item)
              }}
              onMarkRead={isMyTasksBoard ? markTaskBoardItemRead : undefined}
              onLoadRuntimeGoal={loadBoardTaskRuntimeGoal}
              getRuntimeTranscript={
                workspaceActive ? services.runtimeWorkApi?.getRuntimeTranscript : undefined
              }
              onOpenRuntimeTask={onOpenRuntimeTask}
              display={boardCardDisplay}
              agentNames={agentNameById}
              dragDisabled={isAITableProject}
              issueDetailOnly={!isMyTasksBoard}
              archiveDisabled={isAITableProject || archiveBusy}
              progressDisplay={progressDisplay}
              changeRequestMonitor={changeRequestMonitor}
              renderBadges={badges => (
                <IssueChangeRequestBadges
                  badges={badges}
                  monitor={issueChangeRequestMonitor}
                  compact
                  testId={`cloud-todo-card-badges-${item.id}`}
                />
              )}
              onContinueChangeRequestRepair={workbench ? continueChangeRequestRepair : undefined}
            />
          )
        }}
        renderItemsFooter={column =>
          isExternalGitBoard &&
          activeExternalPageCursors[column.status as CloudLoopItem['status']] ? (
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid={`cloud-todo-column-load-more-${column.key}`}
              disabled={activeExternalPageLoading[column.status as CloudLoopItem['status']]}
              onClick={() => void loadMoreExternalColumn(column.status as CloudLoopItem['status'])}
              className="flex h-8 w-full items-center justify-center rounded-lg border border-border bg-background text-xs font-medium text-text-secondary transition hover:bg-muted hover:text-text-primary disabled:opacity-50"
            >
              {activeExternalPageLoading[column.status as CloudLoopItem['status']]
                ? t('todo.loading_more_issues')
                : t('todo.load_more_issues')}
            </ControlButton>
          ) : null
        }
        renderQuickStart={() =>
          quickStartStorageKey ? (
            <BoardQuickStartGuide
              key={quickStartStorageKey}
              storageKey={quickStartStorageKey}
              itemKind={isMyTasksBoard ? 'task' : 'issue'}
              hasCreatedItem={rootBoardItems.length > 0}
              hasAdvancedItem={rootBoardItems.some(item => item.status !== 'inbox')}
              detailOpened={quickStartDetailOpened}
              onCreateItem={() => openIssueCreation()}
              onOpenFirstItem={() => {
                if (firstRootBoardItem) openBoardItem(firstRootBoardItem)
              }}
            />
          ) : null
        }
        renderSkeleton={() =>
          startupActive ? (
            <CloudTodoStartupAnimation label={t('todo.startup_loading', '正在准备项目空间…')} />
          ) : (
            <CloudTodoBoardSkeleton />
          )
        }
        renderStatus={() =>
          isAITableProject && dingtalkAuthPrompt ? (
            <div className="mx-6 mb-2 flex items-center gap-3 rounded-lg border border-border bg-muted px-3 py-2 text-xs text-text-secondary">
              <span className="flex-1">{t('todo.dingtalk_board_not_connected')}</span>
              <ControlButton
                variant="unstyled"
                type="button"
                data-testid="aitable-board-dws-login"
                disabled={dingtalkAuthBusy}
                onClick={() => void connectDingTalkBoard()}
                className="h-7 rounded-md border border-border bg-background px-2.5 text-xs font-medium text-text-primary transition hover:bg-muted disabled:opacity-50"
              >
                {dingtalkAuthBusy
                  ? t('todo.dingtalk_board_connecting')
                  : t('todo.dingtalk_board_connect')}
              </ControlButton>
            </div>
          ) : baseBoardMigration.error ? (
            <BaseBoardStatusMigrationNotice
              error={baseBoardMigration.error}
              retry={baseBoardMigration.retry}
              translate={boardTranslate}
            />
          ) : null
        }
        rootLabel={isMyTasksBoard ? '任务' : isAITableProject ? '父任务' : 'Issue'}
        rootUnitLabel={isMyTasksBoard ? '个任务' : isAITableProject ? '条记录' : '个 Issue'}
        saveGlobalDisabled={
          groupScopeBusy ||
          !['Owner', 'Maintainer'].includes(selectedProject.access_role ?? 'Owner')
        }
        saveGlobalLabel="应用到全局"
        searchPlaceholder={
          boardParent ? t('todo.search_tasks', '搜索任务') : t('todo.search_issues', '搜索 Issue')
        }
        showQuickStart={Boolean(
          quickStartStorageKey &&
          !boardItemsLoading &&
          !isAITableProject &&
          !boardParent &&
          nativeGroupBy === 'status' &&
          !nativeGroupFilter &&
          !nativeBoardQuery.trim()
        )}
        showSaveGlobal={Boolean(
          !baseBoardStatusGrouping && personalGroupKey && localStorage.getItem(personalGroupKey)
        )}
      />
    ),
  }
}
