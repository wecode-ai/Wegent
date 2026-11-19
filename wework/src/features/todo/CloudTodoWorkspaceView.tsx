import { TextField as ControlInput } from '@wegent/collaboration/controls/TextField'
import { Checkbox as ControlCheckbox } from '@wegent/collaboration/controls/Checkbox'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { resolveIssueReference } from './resolveIssueReference'
import { CloudTodoWorkspaceSidebar } from './CloudTodoWorkspaceSidebar'
import { createCloudTodoBoardSlots } from './cloudTodoBoardSlots'
import { CloudTodoIssuePanel } from './CloudTodoIssuePanel'
import type { ProjectView, LocatedCloudProject } from './cloudTodoWorkspaceTypes'
import { toWeworkCloudProject, cloudProjectRequestError } from './cloudTodoWorkspaceSupport'
import { RuntimeConfigurationProvider } from '@wegent/collaboration'
import { Bot, ChevronDown, Cloud, Ellipsis, Grid3X3, HardDrive, Plus, Search } from 'lucide-react'
import { isDefaultWorkItemProject } from '@/api/deliveries'
import {
  CollaborationProjectViewShell,
  ProjectBoardSettingsDialog,
  ProjectCreateDialog,
  projectCreateLabels,
  type CollaborationIssue,
  type CollaborationProject,
} from '@wegent/collaboration'
import { DesktopWindowControls } from '@/components/layout/DesktopWindowControls'
import { MacOSTitleBarDragRegion } from '@/components/layout/MacOSTitleBarDragRegion'
import { ActionMenu } from '@/components/common/ActionMenu'
import { Tooltip } from '@/components/ui/tooltip'
import { TransientNotice } from '@/components/common/TransientNotice'
import { cn } from '@/lib/utils'
import { track } from '@/telemetry/client'
import { AutomationSelectionDialog } from '@/features/todo/AutomationSelectionDialog'
import { CloudTodoModal as Modal } from './CloudTodoModal'
import { CloudProjectManageView } from './CloudProjectManageView'
import { projectSpaceKey, projectSpaceRef, sameProjectSpace } from './projectSpaceSelection'
import { ProjectSpaceChatSidebar } from './ProjectSpaceChatSidebar'
import { GlobalTodoSearch } from './GlobalTodoSearch'
import { parseDingTalkAITableLink } from './projectProviderConfig'
import { TaskSearchPanel } from './TaskSearchPanel'
import { TodoEditor } from './TodoEditor'
import { IssueComposer } from './IssueComposer'
import type { CloudTodoWorkspaceData } from './useCloudTodoWorkspaceData'
import type { createCloudTodoProjectActions } from './cloudTodoProjectActions'
import type { createCloudTodoBoardActions } from './cloudTodoBoardActions'
import type { createCloudTodoTaskActions } from './cloudTodoTaskActions'
export type CloudTodoWorkspaceViewModel = CloudTodoWorkspaceData &
  ReturnType<typeof createCloudTodoProjectActions> &
  ReturnType<typeof createCloudTodoBoardActions> &
  ReturnType<typeof createCloudTodoTaskActions>
export function CloudTodoWorkspaceView({ model }: { model: CloudTodoWorkspaceViewModel }) {
  const {
    localProjects,
    services,
    embedded,
    embeddedTitle,
    onActiveProjectChange,
    notificationChoice,
    t,
    i18n,
    cloudWorkspaceApi,
    deviceNamesById,
    cloudWorkspace,
    projectSpaceApis,
    localProjectManageApi,
    availableProjectSpaceApis,
    projects,
    replaceProject,
    prependProject,
    collaborationProjectItems,
    collaborationProjectMembers,
    openProjectAssistant,
    clearTaskDispatchError,
    selectedProject,
    selectedProjectForViewAccess,
    localProjectOptions,
    isMyTasksBoard,
    selectedLocalProject,
    selectedProjectKey,
    selectedProjectAgentApi,
    boardCardDisplay,
    isProcessingStatus,
    availableTags,
    aitableApi,
    canCreateBoardTask,
    openItemForProject,
    detailAllItems,
    createTodoProject,
    createTodoApi,
    boardItems,
    boardParent,
    taskPanelOpen,
    openBoardItem,
    projectView,
    setProjectView,
    boardSettingsOpen,
    setBoardSettingsOpen,
    selectedItem,
    setSelectedItem,
    setLocalProjectMembers,
    items,
    backgroundTaskItemId,
    createProjectOpen,
    setCreateProjectOpen,
    createTodoOpen,
    setCreateTodoOpen,
    createTodoParent,
    setCreateTodoParent,
    createTodoStatus,
    createTodoInitialTitle,
    setCreateTodoInitialTitle,
    createTodoNonce,
    setCreateTodoNonce,
    createTodoStartRuntime,
    setCreateTodoStartRuntime,
    createTodoContinueCreating,
    setCreateTodoContinueCreating,
    issueComposerOpen,
    setIssueComposerOpen,
    issueComposerBoardKey,
    issueComposerStatus,
    issueComposerInitialContent,
    issueComposerPresentation,
    issueComposerBusy,
    issueComposerError,
    pendingAutomationSelection,
    projectAssistantOpen,
    setProjectAssistantOpen,
    globalSearchScope,
    globalSearchOpen,
    setGlobalSearchOpen,
    globalSearchQuery,
    setGlobalSearchQuery,
    projectSearchOpen,
    setProjectSearchOpen,
    projectSearchQuery,
    setProjectSearchQuery,
    projectSearchFilters,
    setProjectSearchFilters,
    localProjectsLoading,
    localProjectsError,
    taskDispatchError,
    sidebarCollapsed,
    setSidebarCollapsed,
    renameProject,
    setRenameProject,
    renameProjectName,
    setRenameProjectName,
    renameBusy,
    renameError,
    setRenameError,
    archiveProject,
    setArchiveProject,
    archiveItem,
    setArchiveItem,
    archiveBusy,
    archiveError,
    setArchiveError,
    batchConfirmBusy,
    batchConfirmError,
    setBatchConfirmError,
    batchConfirmItems,
    setBatchConfirmItems,
    setBatchConfirmRetryItemKeys,
    runtimeBatchArchiveItems,
    batchArchiveError,
    setRuntimeBatchArchiveItems,
    applyProjectSelection,
    selectProject,
    openAssigneeQuickAdd,
    renameSelectedProject,
    confirmArchiveProject,
    confirmArchiveItem,
    archiveCompletedItems,
    openTodoCreation,
    addCreatedTodo,
    openCreatedItemRuntimeTask,
    retryLocalProjects,
    confirmReviewItems,
    openIssueCreation,
    createIssueFromComposer,
    closeTopPanel,
  } = model
  return (
    <RuntimeConfigurationProvider
      api={cloudWorkspaceApi}
      project={
        selectedProject?.location === 'cloud' ? (selectedProject as CollaborationProject) : null
      }
      locale={i18n.language}
    >
      <div
        className={cn(
          'z-content flex min-h-0 min-w-0 overflow-hidden bg-background text-text-primary',
          embedded ? 'relative flex-1' : 'absolute inset-0 w-full'
        )}
        data-testid="cloud-todo-workspace"
        data-embedded={embedded}
        data-sidebar-collapsed={embedded || sidebarCollapsed}
      >
        {notificationChoice.dialog}
        <TransientNotice
          message={taskDispatchError}
          tone="error"
          onClear={clearTaskDispatchError}
        />

        <div className="flex min-h-0 flex-1 overflow-hidden">
          <CloudTodoWorkspaceSidebar model={model} />
          <main
            className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
            data-testid="cloud-todo-main"
          >
            {isMyTasksBoard && batchArchiveError && (
              <p className="shrink-0 px-4 py-2 text-sm text-destructive" role="alert">
                {batchArchiveError}
              </p>
            )}
            {!embedded && !selectedProject && (
              <MacOSTitleBarDragRegion className="absolute inset-x-0 top-0 z-0 h-[38px]" />
            )}
            {!embedded && sidebarCollapsed && (
              <div
                data-testid="cloud-todo-collapsed-chrome-controls"
                className="electron-titlebar-interactive-region pointer-events-auto absolute left-2 top-0 z-20 flex h-[38px] items-center gap-1"
              >
                <DesktopWindowControls
                  sidebarCollapsed
                  onToggleSidebar={() => setSidebarCollapsed(false)}
                  className="gap-1"
                  toggleTestId="cloud-todo-expand-sidebar"
                />
              </div>
            )}
            {!selectedProject && projects.length > 0 && localProjectsError ? (
              <div
                data-testid="local-project-spaces-error"
                className="flex shrink-0 items-center justify-between gap-3 border-b border-border bg-destructive/5 px-4 py-2 text-sm text-destructive"
              >
                <span>本地项目空间加载失败：{localProjectsError}</span>
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="local-project-spaces-retry"
                  onClick={retryLocalProjects}
                  className="h-7 shrink-0 rounded-md border border-destructive/30 px-2 text-xs font-medium hover:bg-destructive/10"
                >
                  {t('common.retry', '重试')}
                </ControlButton>
              </div>
            ) : null}
            {issueComposerOpen ? (
              <IssueComposer
                key={`${issueComposerBoardKey}:${issueComposerStatus}:${issueComposerInitialContent}`}
                projects={projects}
                initialBoardKey={issueComposerBoardKey}
                initialStartExecution={isProcessingStatus(issueComposerStatus)}
                initialContent={issueComposerInitialContent}
                localProjects={localProjectOptions}
                projectMembers={collaborationProjectMembers}
                initialLocalProjectId={selectedLocalProject?.id ?? null}
                presentation={issueComposerPresentation}
                busy={issueComposerBusy}
                error={issueComposerError}
                onCancel={() => setIssueComposerOpen(false)}
                onCreate={createIssueFromComposer}
              />
            ) : !selectedProject && localProjectsError ? (
              <div
                data-testid="local-project-spaces-error"
                className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-sm text-destructive"
              >
                <span>本地项目空间加载失败：{localProjectsError}</span>
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="local-project-spaces-retry"
                  onClick={retryLocalProjects}
                  className="h-8 rounded-lg border border-destructive/30 px-3 text-sm font-medium hover:bg-destructive/10"
                >
                  {t('common.retry', '重试')}
                </ControlButton>
              </div>
            ) : (projectSpaceApis.local ? localProjectsLoading : cloudWorkspace.state.loading) ? (
              <div className="flex flex-1 items-center justify-center text-sm text-text-muted">
                正在加载项目…
              </div>
            ) : !selectedProject ? (
              <div
                data-testid="cloud-project-unavailable"
                className="flex flex-1 items-center justify-center text-sm text-text-muted"
              >
                未找到要打开的项目
              </div>
            ) : (
              <CollaborationProjectViewShell
                project={selectedProjectForViewAccess ?? selectedProject}
                view={projectView}
                labels={{
                  board: t('todo.board_view', '看板'),
                  table: t('todo.issue_table', '表格'),
                  files: t('todo.files_title', '文件'),
                  manage: t('todo.project_settings', '项目设置'),
                }}
                testIds={{
                  board: 'cloud-project-board-view',
                  table: 'cloud-project-table-view',
                  files: 'cloud-project-files-view',
                  manage: 'cloud-project-manage-view',
                }}
                enabledStandardViews={isMyTasksBoard ? ['board'] : undefined}
                compactSwitcherIcon={<ChevronDown className="h-3 w-3" />}
                onViewChange={view => setProjectView(view as ProjectView)}
                assistantAction={{
                  icon: <Bot className="h-3.5 w-3.5" />,
                  label: t('workbench.project_chat'),
                  onClick: openProjectAssistant,
                  renderTooltip: (children, label) => (
                    <Tooltip label={label} side="bottom" align="end">
                      {children}
                    </Tooltip>
                  ),
                }}
                assistantOpen={projectAssistantOpen}
                dragRegion={
                  !embedded ? (
                    <MacOSTitleBarDragRegion
                      className={cn(
                        'absolute right-0 top-0 z-0 h-full',
                        sidebarCollapsed ? 'left-12' : 'left-0'
                      )}
                    />
                  ) : null
                }
                embedded={embedded}
                hasCreateAction={projectView === 'board' && canCreateBoardTask}
                renderRightActions={({ actionRefs, level, showLabels }) => (
                  <>
                    {projectView === 'board' && level < 2 ? (
                      <>
                        <Tooltip
                          label={
                            boardParent || isMyTasksBoard
                              ? t('todo.search_tasks', '搜索任务')
                              : t('todo.search_issues', '搜索 Issue')
                          }
                          side="bottom"
                          align="end"
                        >
                          <ControlButton
                            variant="unstyled"
                            ref={actionRefs.search}
                            type="button"
                            data-testid="cloud-project-task-search-toggle"
                            aria-label={
                              boardParent || isMyTasksBoard
                                ? t('todo.search_tasks', '搜索任务')
                                : t('todo.search_issues', '搜索 Issue')
                            }
                            onClick={() => setProjectSearchOpen(current => !current)}
                            className="electron-titlebar-interactive-region relative z-10 ml-2 flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg border border-border bg-background px-2.5 text-xs text-text-secondary transition hover:bg-muted"
                          >
                            <Search className="h-3.5 w-3.5" />
                            {showLabels
                              ? boardParent || isMyTasksBoard
                                ? t('todo.search_tasks', '搜索任务')
                                : t('todo.search_issues', '搜索 Issue')
                              : null}
                          </ControlButton>
                        </Tooltip>
                        {canCreateBoardTask ? (
                          <Tooltip
                            label={
                              boardParent || isMyTasksBoard
                                ? t('todo.new_task', '新建任务')
                                : t('todo.new_issue', '新建 Issue')
                            }
                            side="bottom"
                            align="end"
                          >
                            <ControlButton
                              variant="unstyled"
                              ref={actionRefs.add}
                              type="button"
                              data-testid="cloud-todo-add"
                              aria-label={
                                boardParent || isMyTasksBoard
                                  ? t('todo.new_task', '新建任务')
                                  : t('todo.new_issue', '新建 Issue')
                              }
                              onClick={() =>
                                boardParent ? openTodoCreation(boardParent) : openIssueCreation()
                              }
                              className="electron-titlebar-interactive-region relative z-10 ml-2 flex h-8 items-center gap-1.5 whitespace-nowrap rounded-lg bg-text-primary px-3 text-sm font-medium text-background transition hover:opacity-90"
                            >
                              <Plus className="h-3.5 w-3.5" />
                              {showLabels
                                ? boardParent || isMyTasksBoard
                                  ? t('todo.new_task', '新建任务')
                                  : t('todo.new_issue', '新建 Issue')
                                : null}
                            </ControlButton>
                          </Tooltip>
                        ) : null}
                      </>
                    ) : null}
                    {level >= 2 && (!projectAssistantOpen || projectView === 'board') ? (
                      <ActionMenu
                        ariaLabel={t('workbench.more', '更多')}
                        testId="cloud-project-header-more"
                        icon={Ellipsis}
                        placement="bottom-end"
                        triggerClassName="electron-titlebar-interactive-region relative z-10 ml-2 flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-background text-text-secondary transition hover:bg-muted hover:text-text-primary"
                        items={[
                          ...(!projectAssistantOpen
                            ? [
                                {
                                  label: t('workbench.project_chat'),
                                  icon: Bot,
                                  testId: 'cloud-project-header-more-ask-ai',
                                  onSelect: openProjectAssistant,
                                },
                              ]
                            : []),
                          ...(projectView === 'board'
                            ? [
                                {
                                  label:
                                    boardParent || isMyTasksBoard
                                      ? t('todo.search_tasks', '搜索任务')
                                      : t('todo.search_issues', '搜索 Issue'),
                                  icon: Search,
                                  testId: 'cloud-project-header-more-search',
                                  onSelect: () => setProjectSearchOpen(true),
                                },
                              ]
                            : []),
                        ]}
                      />
                    ) : null}
                    {projectView === 'board' && level >= 2 && canCreateBoardTask ? (
                      <Tooltip
                        label={
                          boardParent || isMyTasksBoard
                            ? t('todo.new_task', '新建任务')
                            : t('todo.new_issue', '新建 Issue')
                        }
                        side="bottom"
                        align="end"
                      >
                        <ControlButton
                          variant="unstyled"
                          ref={actionRefs.add}
                          type="button"
                          data-testid="cloud-todo-add"
                          aria-label={
                            boardParent || isMyTasksBoard
                              ? t('todo.new_task', '新建任务')
                              : t('todo.new_issue', '新建 Issue')
                          }
                          onClick={() =>
                            boardParent ? openTodoCreation(boardParent) : openIssueCreation()
                          }
                          className="electron-titlebar-interactive-region relative z-10 ml-2 flex h-8 w-8 items-center justify-center rounded-lg bg-text-primary text-background transition hover:opacity-90"
                        >
                          <Plus className="h-3.5 w-3.5" />
                        </ControlButton>
                      </Tooltip>
                    ) : null}
                  </>
                )}
                searchPanel={
                  projectView === 'board' && projectSearchOpen ? (
                    <TaskSearchPanel
                      items={boardItems}
                      members={
                        selectedProjectKey
                          ? (collaborationProjectMembers[selectedProjectKey] ?? [])
                          : []
                      }
                      query={projectSearchQuery}
                      filters={projectSearchFilters}
                      tags={availableTags}
                      onQueryChange={setProjectSearchQuery}
                      onFiltersChange={setProjectSearchFilters}
                      onSelect={item => {
                        openBoardItem(item)
                        setProjectSearchOpen(false)
                      }}
                    />
                  ) : null
                }
                sidebarCollapsed={sidebarCollapsed}
                compactTitle={selectedProject.name}
                title={
                  embedded && embeddedTitle === 'workspace'
                    ? t('workbench.workspace_tab_board', '协作')
                    : selectedProject.name
                }
                titleIcon={
                  embedded ? (
                    <Grid3X3 className="h-4 w-4 shrink-0 text-text-muted" />
                  ) : selectedProject.location === 'local' ? (
                    <HardDrive className="h-4 w-4 shrink-0 text-text-muted" />
                  ) : (
                    <Cloud className="h-4 w-4 shrink-0 text-text-muted" />
                  )
                }
                slots={createCloudTodoBoardSlots(model, selectedProject)}
              />
            )}
          </main>
          {pendingAutomationSelection ? (
            <AutomationSelectionDialog
              candidates={pendingAutomationSelection.candidates}
              onCancel={pendingAutomationSelection.onCancel}
              onConfirm={pendingAutomationSelection.onConfirm}
            />
          ) : null}
          {boardSettingsOpen && selectedProject ? (
            <ProjectBoardSettingsDialog
              title={t('todo.board_settings', '看板设置')}
              closeLabel={t('common.close', '关闭')}
              onClose={() => setBoardSettingsOpen(false)}
            >
              <CloudProjectManageView
                api={
                  selectedProject.location === 'cloud' ? cloudWorkspaceApi! : localProjectManageApi!
                }
                aitableApi={aitableApi}
                dwsApi={services.dwsApi}
                embedded
                project={selectedProject}
                boardCardDisplay={boardCardDisplay}
                section="board"
                onProjectUpdated={updated => replaceProject(selectedProject, updated)}
              />
            </ProjectBoardSettingsDialog>
          ) : null}
          {selectedItem && backgroundTaskItemId !== selectedItem.id ? (
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid="cloud-todo-detail-dismiss-layer"
              aria-label={taskPanelOpen ? '关闭任务对话' : '关闭 Issue 详情'}
              onClick={closeTopPanel}
              className="todo-panel-backdrop"
            />
          ) : null}
          <CloudTodoIssuePanel model={model} />
          {selectedProject && projectAssistantOpen && !selectedItem ? (
            <ProjectSpaceChatSidebar
              key={`${selectedProject.id}:project`}
              project={selectedProject}
              localProjects={localProjects}
              onClose={() => {
                setProjectAssistantOpen(false)
              }}
            />
          ) : null}
        </div>

        {globalSearchOpen && (
          <GlobalTodoSearch
            projects={projects}
            projectItems={collaborationProjectItems}
            projectMembers={collaborationProjectMembers}
            lookupScope={globalSearchScope}
            onResolveReference={reference =>
              resolveIssueReference(reference, [
                ...(localProjectManageApi
                  ? [{ location: 'local' as const, api: localProjectManageApi }]
                  : []),
                ...(cloudWorkspaceApi
                  ? [{ location: 'cloud' as const, api: cloudWorkspaceApi }]
                  : []),
              ])
            }
            query={globalSearchQuery}
            onQueryChange={setGlobalSearchQuery}
            onClose={() => setGlobalSearchOpen(false)}
            onSelectProject={project => {
              selectProject(project)
              setProjectView('board')
              setSelectedItem(null)
              setGlobalSearchOpen(false)
            }}
            onSelectItem={(project, item) => {
              if (item.can_view_detail === false) return
              if (
                !projects.some(candidate =>
                  sameProjectSpace(projectSpaceRef(candidate), projectSpaceRef(project))
                )
              )
                prependProject(project)
              selectProject(project)
              setProjectView('board')
              openItemForProject(project, {
                ...item,
                project_store: project.project_store,
              })
              setGlobalSearchOpen(false)
            }}
          />
        )}
        {createProjectOpen && (
          <ProjectCreateDialog
            targets={availableProjectSpaceApis}
            defaultLocation={projectSpaceApis.defaultLocation}
            allowDingTalkAITable
            labels={projectCreateLabels[i18n.language.startsWith('zh') ? 'zh-CN' : 'en']}
            host={{
              renderModal: ({ title, children, onClose, closeLabel }) => (
                <Modal title={title} width="wide" onClose={onClose} closeLabel={closeLabel}>
                  {children}
                </Modal>
              ),
              parseDingTalkAITableLink,
              formatError: cloudProjectRequestError,
              track: event => {
                if (event === 'created') {
                  track('feature_action_completed', {
                    domain: 'project_space',
                    action: 'create',
                  })
                } else {
                  track('operation_failed', { operation: 'project_space_action' })
                }
              },
            }}
            onClose={() => setCreateProjectOpen(false)}
            onCreated={(project, location) => {
              const weworkProject = toWeworkCloudProject(project)
              const locatedProject: LocatedCloudProject = {
                ...weworkProject,
                project_store: location === 'local' ? 'local' : 'backend',
                location,
              }
              prependProject(locatedProject)
              const membersRequest =
                location === 'local'
                  ? projectSpaceApis.local?.listCloudProjectMembers(weworkProject.id)
                  : undefined
              if (membersRequest) {
                const spaceKey = projectSpaceKey(projectSpaceRef(locatedProject))
                void membersRequest.then(members =>
                  setLocalProjectMembers(current => ({ ...current, [spaceKey]: members }))
                )
              }
              applyProjectSelection(locatedProject)
              onActiveProjectChange?.(locatedProject)
              setCreateProjectOpen(false)
            }}
          />
        )}
        {createTodoOpen &&
          createTodoProject &&
          (createTodoProject.location === 'cloud' ? cloudWorkspaceApi : createTodoApi) && (
            <TodoEditor
              key={`${projectSpaceKey(projectSpaceRef(createTodoProject))}:${createTodoNonce}`}
              mode="create"
              {...(createTodoProject.location === 'cloud'
                ? { sharedApi: cloudWorkspaceApi! }
                : { api: createTodoApi! })}
              projectChatAgentApi={selectedProjectAgentApi}
              teamApi={services.teamApi}
              project={createTodoProject}
              deviceNamesById={deviceNamesById}
              onAddAssigneeMember={
                createTodoProject.location === 'cloud' &&
                !isDefaultWorkItemProject(createTodoProject)
                  ? () => openAssigneeQuickAdd(createTodoProject, 'members')
                  : undefined
              }
              onAddAssigneeAgent={
                !isDefaultWorkItemProject(createTodoProject)
                  ? () => openAssigneeQuickAdd(createTodoProject, 'agents')
                  : undefined
              }
              initialParent={createTodoParent}
              initialStatus={createTodoStatus}
              initialTitle={createTodoInitialTitle}
              allItems={createTodoParent ? detailAllItems : items}
              createOptions={
                createTodoProject.location === 'cloud' && !createTodoParent ? (
                  <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm text-text-secondary">
                    <label className="flex cursor-pointer items-center gap-2">
                      <ControlCheckbox
                        data-testid="cloud-todo-create-runtime-option"
                        checked={createTodoStartRuntime}
                        onCheckedChange={checked => setCreateTodoStartRuntime(checked === true)}
                      />
                      {t('todo.create_runtime_task_after_issue', '创建后启动 Runtime 任务')}
                    </label>
                    <label className="flex cursor-pointer items-center gap-2">
                      <ControlCheckbox
                        data-testid="cloud-todo-continue-creating-option"
                        checked={createTodoContinueCreating}
                        onCheckedChange={checked => setCreateTodoContinueCreating(checked === true)}
                      />
                      {t('todo.continue_creating', '继续创建')}
                    </label>
                  </div>
                ) : undefined
              }
              onClose={() => {
                setCreateTodoOpen(false)
                setCreateTodoParent(null)
                setCreateTodoInitialTitle(undefined)
              }}
              onCreated={item => {
                const locatedItem = addCreatedTodo(item, createTodoProject)
                if (createTodoProject.location === 'cloud') {
                  cloudWorkspace.commands.appendIssue(item as CollaborationIssue)
                }
                if (createTodoStartRuntime) {
                  openCreatedItemRuntimeTask(locatedItem, createTodoProject)
                } else if (!createTodoContinueCreating) {
                  setSelectedItem(locatedItem)
                }
                if (createTodoContinueCreating && !createTodoParent) {
                  setCreateTodoInitialTitle(undefined)
                  setCreateTodoNonce(current => current + 1)
                } else {
                  setCreateTodoOpen(false)
                  setCreateTodoParent(null)
                  setCreateTodoInitialTitle(undefined)
                }
              }}
            />
          )}
        {renameProject && (
          <Modal
            title="修改项目名称"
            onClose={() => setRenameProject(null)}
            pending={renameBusy}
            onSubmit={renameSelectedProject}
          >
            <div className="px-5 pb-5 pt-4">
              <label className="block text-sm font-medium text-text-secondary">
                项目名称
                <ControlInput
                  data-testid="cloud-project-rename-input"
                  value={renameProjectName}
                  autoFocus
                  onFocus={event => event.currentTarget.select()}
                  onChange={event => {
                    setRenameProjectName(event.target.value)
                    setRenameError(null)
                  }}
                  className="mt-2 h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-text-primary outline-none keyboard:focus:border-focus keyboard:focus:ring-2 keyboard:focus:ring-focus/15"
                />
              </label>
              <p className="mt-2 text-xs text-text-muted">新名称会显示在项目空间和看板侧栏中。</p>
              {renameError ? (
                <p className="mt-3 text-xs text-destructive wework:text-red-600">{renameError}</p>
              ) : null}
              <div className="mt-6 flex justify-end gap-2">
                <ControlButton
                  variant="unstyled"
                  type="button"
                  onClick={() => setRenameProject(null)}
                  disabled={renameBusy}
                  className="h-9 rounded-lg border border-border px-4 text-sm text-text-primary hover:bg-muted disabled:opacity-50"
                >
                  取消
                </ControlButton>
                <ControlButton
                  variant="unstyled"
                  type="submit"
                  data-testid="cloud-project-rename-confirm"
                  disabled={!renameProjectName.trim() || renameBusy}
                  className="h-9 rounded-lg bg-text-primary px-4 text-sm font-medium text-background hover:bg-text-primary/90 disabled:opacity-50"
                >
                  {renameBusy ? '保存中…' : '保存'}
                </ControlButton>
              </div>
            </div>
          </Modal>
        )}
        {runtimeBatchArchiveItems && (
          <Modal
            title={t('todo.archive_completed_tasks_title', '归档已完成任务？')}
            onClose={() => setRuntimeBatchArchiveItems(null)}
          >
            <div className="px-5 pb-5 pt-4">
              <p className="text-sm leading-5 text-text-secondary">
                {t(
                  'todo.archive_completed_tasks_description',
                  '将从任务列表中归档 {{count}} 个已完成任务。归档后可在设置中恢复。',
                  { count: runtimeBatchArchiveItems.length }
                )}
              </p>

              <div className="mt-6 flex justify-end gap-2">
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="cloud-my-tasks-archive-completed-cancel"
                  onClick={() => setRuntimeBatchArchiveItems(null)}
                  className="h-9 rounded-lg border border-border px-4 text-sm text-text-primary hover:bg-muted disabled:opacity-50"
                >
                  {t('common.cancel', '取消')}
                </ControlButton>
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="cloud-my-tasks-archive-completed-confirm"
                  onClick={() => void archiveCompletedItems(runtimeBatchArchiveItems)}
                  className="h-9 rounded-lg bg-destructive px-4 text-sm font-medium text-destructive-contrast hover:bg-destructive/90 disabled:opacity-50 wework:bg-red-600 wework:text-white wework:hover:bg-red-700"
                >
                  {archiveBusy
                    ? t('todo.archiving', '归档中…')
                    : t('todo.confirm_archive', '确认归档')}
                </ControlButton>
              </div>
            </div>
          </Modal>
        )}
        {batchConfirmItems && (
          <Modal
            title={t('todo.batch_confirm_review_title', '确认待确认事项？')}
            onClose={() => {
              if (batchConfirmBusy) return
              setBatchConfirmItems(null)
              setBatchConfirmError(null)
              setBatchConfirmRetryItemKeys(new Set())
            }}
          >
            <div className="px-5 pb-5 pt-4" data-testid="cloud-todo-batch-confirm-review-dialog">
              <p className="text-sm leading-5 text-text-secondary">
                {t(
                  'todo.batch_confirm_review_description',
                  '将当前列中的 {{count}} 个事项标记为已完成。',
                  { count: batchConfirmItems.length }
                )}
              </p>
              {batchConfirmError ? (
                <p className="mt-3 text-xs text-destructive" role="alert">
                  {batchConfirmError}
                </p>
              ) : null}
              <div className="mt-6 flex justify-end gap-2">
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="cloud-todo-batch-confirm-review-cancel"
                  disabled={batchConfirmBusy}
                  onClick={() => {
                    setBatchConfirmItems(null)
                    setBatchConfirmError(null)
                    setBatchConfirmRetryItemKeys(new Set())
                  }}
                  className="h-9 rounded-lg border border-border px-4 text-sm text-text-primary hover:bg-muted disabled:opacity-50"
                >
                  {t('common.cancel', '取消')}
                </ControlButton>
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="cloud-todo-batch-confirm-review-confirm"
                  disabled={batchConfirmBusy}
                  onClick={() => void confirmReviewItems(batchConfirmItems)}
                  className="h-9 rounded-lg bg-text-primary px-4 text-sm font-medium text-background hover:bg-text-primary/90 disabled:opacity-50"
                >
                  {batchConfirmBusy
                    ? t('todo.batch_confirming', '确认中…')
                    : t('todo.confirm_complete', '确认完成')}
                </ControlButton>
              </div>
            </div>
          </Modal>
        )}
        {(archiveProject || archiveItem) && (
          <Modal
            title={archiveProject ? '归档项目？' : '归档任务？'}
            onClose={() => {
              if (archiveBusy) return
              setArchiveProject(null)
              setArchiveItem(null)
              setArchiveError(null)
            }}
          >
            <div className="px-5 pb-5 pt-4">
              <p className="text-sm leading-5 text-text-secondary">
                {archiveProject
                  ? `“${archiveProject.name}”及其中任务将从项目列表中隐藏。`
                  : `“${archiveItem?.title}”${items.some(item => item.parent_id === archiveItem?.id) ? '及其子任务' : ''}将从看板中隐藏。`}
              </p>
              <p className="mt-2 text-xs text-text-muted">归档数据会保留，不会立即永久删除。</p>
              {archiveError ? (
                <p className="mt-3 text-xs text-destructive wework:text-red-600">{archiveError}</p>
              ) : null}
              <div className="mt-6 flex justify-end gap-2">
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid="cloud-archive-cancel"
                  disabled={archiveBusy}
                  onClick={() => {
                    setArchiveProject(null)
                    setArchiveItem(null)
                    setArchiveError(null)
                  }}
                  className="h-9 rounded-lg border border-border px-4 text-sm text-text-primary hover:bg-muted disabled:opacity-50"
                >
                  取消
                </ControlButton>
                <ControlButton
                  variant="unstyled"
                  type="button"
                  data-testid={
                    archiveProject ? 'cloud-project-archive-confirm' : 'cloud-todo-archive-confirm'
                  }
                  disabled={archiveBusy}
                  onClick={() => {
                    void (archiveProject ? confirmArchiveProject() : confirmArchiveItem())
                  }}
                  className="h-9 rounded-lg bg-destructive px-4 text-sm font-medium text-destructive-contrast hover:bg-destructive/90 disabled:opacity-50 wework:bg-red-600 wework:text-white wework:hover:bg-red-700"
                >
                  {archiveBusy ? '归档中…' : '确认归档'}
                </ControlButton>
              </div>
            </div>
          </Modal>
        )}
      </div>
    </RuntimeConfigurationProvider>
  )
}
