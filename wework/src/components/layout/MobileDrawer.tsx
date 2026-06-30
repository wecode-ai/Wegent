import {
  Edit3,
  Folder,
  FolderOpen,
  FolderPlus,
  GitCompareArrows,
  Loader2,
  Monitor,
  RotateCw,
  Search,
  SquarePen,
  X,
} from 'lucide-react'
import { useMemo, useRef, useState } from 'react'
import { ProjectCreateDialog } from '@/components/projects/ProjectCreateDialog'
import { useTranslation } from '@/hooks/useTranslation'
import { usePullToRefresh } from '@/hooks/usePullToRefresh'
import { cn } from '@/lib/utils'
import { runtimeProjectUiId } from '@/lib/runtime-project'
import type {
  CreateGitWorkspaceProjectRequest,
  CreateProjectRequest,
  DeleteDeviceWorkspaceRequest,
  DeviceWorkspacePrepareRequest,
  DeviceWorkspacePrepareResponse,
  DeviceInfo,
  GitBranch,
  GitRepoInfo,
  ProjectWithTasks,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  User,
} from '@/types/api'
import {
  getRuntimeChatSidebarTaskItems,
  getNextRuntimeSidebarTaskVisibleLimit,
  getRuntimeTaskAddress,
  getRuntimeTaskTime,
  getRuntimeTaskWorkspaceTitle,
  getRuntimeSidebarTaskItems,
  getVisibleRuntimeSidebarTaskItems,
  hasHiddenRuntimeSidebarTaskItems,
  isRuntimeTaskSelected,
  isRuntimeWorktreeTask,
  RUNTIME_PROJECT_TASK_PREVIEW_LIMIT,
} from './runtimeTaskSidebarHelpers'

const MOBILE_RUNNING_SPINNER_CLASS = 'h-3.5 w-3.5 shrink-0 animate-spin'
type ProjectCreateMode = 'scratch' | 'existing' | 'git'

interface MobileDrawerProps {
  open: boolean
  user: User | null
  devices?: DeviceInfo[]
  projects: ProjectWithTasks[]
  runtimeWork?: RuntimeWorkListResponse | null
  currentProjectId?: number
  currentRuntimeTask?: RuntimeTaskAddress | null
  activeItem?: 'chat' | 'plugins' | 'automation'
  onClose: () => void
  onNewChat?: () => void
  onStartStandaloneChat?: () => void
  onOpenSettings?: () => void
  onCreateProject?: (data: CreateProjectRequest) => Promise<ProjectWithTasks>
  onCreateGitWorkspaceProject?: (
    data: CreateGitWorkspaceProjectRequest
  ) => Promise<ProjectWithTasks>
  onPrepareDeviceWorkspace?: (
    data: DeviceWorkspacePrepareRequest
  ) => Promise<DeviceWorkspacePrepareResponse>
  onDeleteDeviceWorkspace?: (data: DeleteDeviceWorkspaceRequest) => Promise<void>
  onListGitRepositories?: () => Promise<GitRepoInfo[]>
  onListGitBranches?: (repo: GitRepoInfo) => Promise<GitBranch[]>
  onGetDeviceHomeDirectory?: (deviceId: string) => Promise<string>
  onGetProjectWorkspaceRoot?: (deviceId: string) => Promise<string>
  onListDeviceDirectories?: (deviceId: string, path: string) => Promise<string[]>
  onCreateDeviceDirectory?: (deviceId: string, path: string) => Promise<void>
  onUpdateProjectName?: (projectId: number, name: string) => Promise<void>
  onRemoveProject?: (projectId: number) => Promise<void>
  onSelectProject: (projectId: number) => void
  onOpenRuntimeLocalTask?: (address: RuntimeTaskAddress) => Promise<void> | void
  onRefreshWorkLists?: () => Promise<void>
}

function formatRelativeTime(value?: string | number) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''

  const elapsedMs = Math.max(0, Date.now() - date.getTime())
  const minutes = Math.floor(elapsedMs / 60000)
  if (minutes < 60) return `${Math.max(1, minutes)}m`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h`

  const days = Math.floor(hours / 24)
  if (days < 7) return `${days}d`

  return `${Math.floor(days / 7)}w`
}

export function MobileDrawer({
  open,
  user,
  devices = [],
  projects,
  runtimeWork,
  currentProjectId,
  currentRuntimeTask,
  onClose,
  onNewChat,
  onStartStandaloneChat,
  onOpenSettings,
  onCreateProject,
  onCreateGitWorkspaceProject,
  onPrepareDeviceWorkspace,
  onDeleteDeviceWorkspace,
  onListGitRepositories,
  onListGitBranches,
  onGetDeviceHomeDirectory,
  onGetProjectWorkspaceRoot,
  onListDeviceDirectories,
  onCreateDeviceDirectory,
  onUpdateProjectName,
  onRemoveProject,
  onSelectProject,
  onOpenRuntimeLocalTask,
  onRefreshWorkLists,
}: MobileDrawerProps) {
  const { t } = useTranslation('common')
  const {
    scrollRef,
    pullDistance,
    refreshing,
    threshold,
    handlers: pullHandlers,
  } = usePullToRefresh(onRefreshWorkLists ?? (async () => {}))
  const [searchOpen, setSearchOpen] = useState(false)
  const [projectCreateMode, setProjectCreateMode] = useState<ProjectCreateMode | null>(null)
  const [projectActionTarget, setProjectActionTarget] = useState<ProjectWithTasks | null>(null)
  const [renamingProjectId, setRenamingProjectId] = useState<number | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [actionMenuPosition, setActionMenuPosition] = useState({
    left: 12,
    top: 12,
  })
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const longPressStartRef = useRef({ x: 0, y: 0 })
  const longPressTriggeredRef = useRef(false)
  const [expandedProjectIds, setExpandedProjectIds] = useState<Set<number>>(() => new Set())
  const [runtimeProjectTaskVisibleLimits, setRuntimeProjectTaskVisibleLimits] = useState<
    Record<number, number>
  >({})
  const runtimeWorkByProjectId = useMemo(() => {
    const items = runtimeWork?.projects ?? []
    return new Map(items.map(item => [runtimeProjectUiId(item.project), item]))
  }, [runtimeWork])
  const chatWorkspaces = useMemo(() => runtimeWork?.chats ?? [], [runtimeWork])
  const chatTaskItems = useMemo(
    () => getRuntimeChatSidebarTaskItems(chatWorkspaces),
    [chatWorkspaces]
  )

  if (!open) return null

  const renderRuntimeTaskRunningStatus = (testId: string) => {
    const label = t('workbench.runtime_task_running')
    return (
      <span
        data-testid={testId}
        role="status"
        aria-label={label}
        title={label}
        className="ml-2 inline-flex h-7 w-7 shrink-0 items-center justify-center text-[#6B7280]"
      >
        <Loader2 className={MOBILE_RUNNING_SPINNER_CLASS} aria-hidden="true" />
      </span>
    )
  }

  const closeAfter = (action?: () => void) => {
    action?.()
    onClose()
  }

  const canOpenProjectSheet = devices.length > 0
  const unavailableProjectAction = async () => {
    throw new Error(t('workbench.project_create_failed', '项目创建失败'))
  }

  const getUserInitials = () => {
    const name = user?.user_name?.trim()
    if (!name) return t('workbench.user_fallback', '我')
    return name.slice(0, 2).toUpperCase()
  }

  const toggleProject = (projectId: number) => {
    setExpandedProjectIds(previous => {
      const next = new Set(previous)
      if (next.has(projectId)) {
        next.delete(projectId)
      } else {
        next.add(projectId)
      }
      return next
    })
    onSelectProject(projectId)
  }

  const openProjectCreateDialog = () => {
    setProjectCreateMode('scratch')
  }

  const cancelLongPress = () => {
    if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current)
    longPressTimerRef.current = null
  }

  const positionActionMenu = (clientX: number, clientY: number, rowCount: number) => {
    const menuWidth = 240
    const menuHeight = rowCount * 56 + 16
    setActionMenuPosition({
      left: Math.min(Math.max(12, clientX - 24), window.innerWidth - menuWidth - 12),
      top: Math.min(Math.max(12, clientY + 12), window.innerHeight - menuHeight - 12),
    })
  }

  const startLongPress = (
    clientX: number,
    clientY: number,
    rowCount: number,
    onTrigger: () => void
  ) => {
    cancelLongPress()
    longPressTriggeredRef.current = false
    longPressStartRef.current = { x: clientX, y: clientY }
    longPressTimerRef.current = setTimeout(() => {
      longPressTriggeredRef.current = true
      positionActionMenu(clientX, clientY, rowCount)
      onTrigger()
    }, 500)
  }

  const handleAction = async (action: () => Promise<void> | void) => {
    setProjectActionTarget(null)
    await action()
  }

  const submitProjectRename = async (projectId: number) => {
    const name = renameValue.trim()
    if (name && onUpdateProjectName) await onUpdateProjectName(projectId, name)
    setRenamingProjectId(null)
  }

  return (
    <div className="fixed inset-0 z-critical isolate flex h-dvh select-none flex-col overflow-hidden bg-white pb-[max(24px,env(safe-area-inset-bottom))] pt-[max(20px,env(safe-area-inset-top))] text-[#111111]">
      <header className="flex shrink-0 items-center justify-between gap-4 px-6">
        <h1 className="text-[26px] font-bold leading-8 tracking-normal text-[#111111]">
          {t('workbench.brand', 'Wework')}
        </h1>
        <div className="flex items-center gap-5">
          <button
            type="button"
            data-testid="mobile-search-icon-button"
            onClick={() => setSearchOpen(open => !open)}
            className="flex h-11 min-w-[44px] items-center justify-center rounded-full text-[#111111] hover:bg-[#F7F7F7]"
            aria-label={t('workbench.search', '搜索')}
          >
            <Search className="h-7 w-7 stroke-[2.5]" />
          </button>
          <button
            type="button"
            data-testid="mobile-settings-button"
            onClick={() => closeAfter(onOpenSettings)}
            className="flex h-10 w-10 items-center justify-center rounded-full bg-[#8E5BBE] text-sm font-semibold text-white"
            aria-label={t('workbench.settings', '设置')}
          >
            {getUserInitials()}
          </button>
        </div>
      </header>

      {searchOpen && (
        <div className="relative mx-6 mt-6 shrink-0">
          <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-[#6B7280]" />
          <input
            data-testid="mobile-search-input"
            type="search"
            placeholder={t('workbench.search', '搜索')}
            className="h-12 w-full select-text rounded-2xl border border-[#EDEDED] bg-white pl-12 pr-4 text-base leading-5 text-[#111111] outline-none placeholder:text-[#6B7280] focus:bg-[#FAFAFA]"
            autoFocus
          />
        </div>
      )}

      <div className="mx-6 mt-7 h-px shrink-0 bg-[#EDEDED]" />

      <div
        ref={scrollRef}
        onTouchStart={pullHandlers.onTouchStart}
        onTouchMove={pullHandlers.onTouchMove}
        onTouchEnd={pullHandlers.onTouchEnd}
        className="relative min-h-0 flex-1 overflow-y-auto pb-28 pt-2 scrollbar-none"
        data-testid="mobile-drawer-scroll"
      >
        {onRefreshWorkLists && (pullDistance > 0 || refreshing) && (
          <div
            data-testid="mobile-pull-refresh-indicator"
            className="pointer-events-none absolute inset-x-0 top-0 z-10 flex items-center justify-center"
            style={{ height: refreshing ? threshold : pullDistance }}
          >
            <RotateCw
              className={cn('h-5 w-5 text-[#6B7280]', refreshing && 'animate-spin')}
              style={
                refreshing
                  ? undefined
                  : {
                      opacity: Math.min(1, pullDistance / threshold),
                      transform: `rotate(${(pullDistance / threshold) * 270}deg)`,
                    }
              }
            />
          </div>
        )}
        <div
          style={{
            transform: pullDistance ? `translateY(${pullDistance}px)` : undefined,
            transition: refreshing || pullDistance === 0 ? 'transform 0.2s ease' : undefined,
          }}
        >
          <section>
            <div className="space-y-1">
              <div className="relative">
                <button
                  type="button"
                  data-testid="mobile-new-project-button"
                  onClick={() => openProjectCreateDialog()}
                  className="mx-3 flex h-[54px] min-w-[44px] w-[calc(100%-24px)] items-center gap-[18px] rounded-[14px] px-3 text-left text-[18px] font-normal leading-6 text-[#111111] hover:bg-[#F7F7F7] disabled:cursor-not-allowed disabled:text-[#6B7280]"
                  disabled={!canOpenProjectSheet}
                >
                  <FolderPlus className="h-6 w-6 shrink-0 stroke-[2.4]" />
                  <span className="min-w-0 truncate">{t('workbench.new_project', '新建项目')}</span>
                </button>
              </div>
              <section className="mt-5" data-testid="mobile-runtime-chat-section">
                <div className="mb-2 px-6 text-[18px] font-bold leading-6 text-[#111111]">
                  {t('workbench.chats', '对话')}
                </div>
                <div className="space-y-1">
                  {chatTaskItems.length === 0 ? (
                    <div
                      data-testid="mobile-runtime-chat-empty"
                      className="mx-3 flex h-10 items-center rounded-lg px-3 text-left text-[15px] text-[#6B7280]"
                    >
                      {t('workbench.no_chats', '暂无会话')}
                    </div>
                  ) : (
                    chatTaskItems.map(({ workspace, task }) => {
                      const selectedTask = isRuntimeTaskSelected(
                        currentRuntimeTask,
                        workspace,
                        task
                      )
                      const disabled = !workspace.available || !onOpenRuntimeLocalTask
                      const workspaceTitle = getRuntimeTaskWorkspaceTitle(workspace)
                      return (
                        <button
                          key={`${workspace.deviceId}:${task.workspacePath}:${task.localTaskId}`}
                          type="button"
                          data-testid="mobile-chat-runtime-task-button"
                          disabled={disabled}
                          onClick={() => {
                            if (disabled) return
                            void onOpenRuntimeLocalTask?.(getRuntimeTaskAddress(workspace, task))
                            onClose()
                          }}
                          className={[
                            'mx-3 flex h-12 min-w-[44px] w-[calc(100%-24px)] items-center rounded-[14px] px-3 text-left text-[18px] font-normal leading-6 disabled:cursor-not-allowed disabled:opacity-50',
                            selectedTask
                              ? 'bg-[#F1F1F1] text-[#111111]'
                              : 'text-[#111111] hover:bg-[#F7F7F7]',
                          ].join(' ')}
                        >
                          <span className="min-w-0 flex-1 truncate">{task.title}</span>
                          {task.running ? (
                            renderRuntimeTaskRunningStatus(
                              `mobile-chat-runtime-task-running-${task.localTaskId}`
                            )
                          ) : (
                            <span className="ml-2 flex shrink-0 items-center gap-1 text-sm text-[#6B7280]">
                              <span
                                title={workspaceTitle}
                                aria-label={workspaceTitle}
                                role="img"
                                className="flex h-3.5 w-3.5 shrink-0 items-center justify-center"
                              >
                                <Monitor className="h-3.5 w-3.5" aria-hidden="true" />
                              </span>
                              <span>{formatRelativeTime(getRuntimeTaskTime(task))}</span>
                            </span>
                          )}
                        </button>
                      )
                    })
                  )}
                </div>
              </section>
              {projects.map(project => {
                const runtimeProjectWork = runtimeWorkByProjectId.get(project.id)
                const workspaces = runtimeProjectWork?.deviceWorkspaces ?? []
                const selected = currentProjectId === project.id
                const expanded = expandedProjectIds.has(project.id)

                return (
                  <div key={project.id}>
                    <button
                      type="button"
                      data-testid="mobile-project-item-button"
                      onClick={() => {
                        if (longPressTriggeredRef.current) {
                          longPressTriggeredRef.current = false
                          return
                        }
                        toggleProject(project.id)
                      }}
                      onPointerDown={event =>
                        startLongPress(event.clientX, event.clientY, 2, () =>
                          setProjectActionTarget(project)
                        )
                      }
                      onPointerMove={event => {
                        const { x, y } = longPressStartRef.current
                        if (Math.abs(event.clientX - x) > 10 || Math.abs(event.clientY - y) > 10) {
                          cancelLongPress()
                        }
                      }}
                      onPointerUp={cancelLongPress}
                      onPointerCancel={cancelLongPress}
                      onContextMenu={event => {
                        event.preventDefault()
                        cancelLongPress()
                        longPressTriggeredRef.current = true
                        positionActionMenu(event.clientX, event.clientY, 2)
                        setProjectActionTarget(project)
                      }}
                      aria-expanded={expanded}
                      className={[
                        'mx-3 flex h-[54px] min-w-[44px] w-[calc(100%-24px)] items-center gap-[18px] rounded-[14px] px-3 text-left text-[18px] font-normal leading-6',
                        selected
                          ? 'bg-[#F1F1F1] text-[#111111]'
                          : 'text-[#111111] hover:bg-[#F7F7F7]',
                      ].join(' ')}
                    >
                      {expanded ? (
                        <FolderOpen className="h-6 w-6 shrink-0 stroke-[2.4]" />
                      ) : (
                        <Folder className="h-6 w-6 shrink-0 stroke-[2.4]" />
                      )}
                      {renamingProjectId === project.id ? (
                        <input
                          data-testid="mobile-inline-project-name-input"
                          value={renameValue}
                          autoFocus
                          onFocus={event => event.currentTarget.select()}
                          onClick={event => event.stopPropagation()}
                          onPointerDown={event => event.stopPropagation()}
                          onChange={event => setRenameValue(event.target.value)}
                          onBlur={() => void submitProjectRename(project.id)}
                          onKeyDown={event => {
                            if (event.key === 'Enter') {
                              event.preventDefault()
                              void submitProjectRename(project.id)
                            } else if (event.key === 'Escape') {
                              event.preventDefault()
                              setRenamingProjectId(null)
                            }
                          }}
                          className="min-w-0 flex-1 select-text rounded-lg border border-[#D8D8D8] bg-white px-2 py-1 text-[18px] leading-6 outline-none focus:border-[#111111]"
                        />
                      ) : (
                        <span className="min-w-0 flex-1 truncate">{project.name}</span>
                      )}
                    </button>
                    {expanded && (
                      <div className="ml-[66px] mr-6 mt-1 space-y-1">
                        {(() => {
                          const taskItems = getRuntimeSidebarTaskItems(workspaces)
                          if (taskItems.length === 0) {
                            return (
                              <div className="flex h-10 items-center rounded-lg px-2 text-left text-[15px] text-[#6B7280]">
                                {t('workbench.no_chats', '暂无会话')}
                              </div>
                            )
                          }

                          const runtimeTaskVisibleLimit =
                            runtimeProjectTaskVisibleLimits[project.id] ??
                            RUNTIME_PROJECT_TASK_PREVIEW_LIMIT
                          const visibleTaskItems = getVisibleRuntimeSidebarTaskItems(
                            taskItems,
                            runtimeTaskVisibleLimit
                          )
                          const hasHiddenTasks = hasHiddenRuntimeSidebarTaskItems(
                            taskItems,
                            runtimeTaskVisibleLimit
                          )
                          const canCollapseTasks =
                            taskItems.length > RUNTIME_PROJECT_TASK_PREVIEW_LIMIT &&
                            visibleTaskItems.length > RUNTIME_PROJECT_TASK_PREVIEW_LIMIT

                          return (
                            <>
                              {visibleTaskItems.map(({ workspace, task }) => {
                                const selectedTask = isRuntimeTaskSelected(
                                  currentRuntimeTask,
                                  workspace,
                                  task
                                )
                                const disabled = !workspace.available || !onOpenRuntimeLocalTask
                                const workspaceTitle = getRuntimeTaskWorkspaceTitle(workspace)
                                return (
                                  <button
                                    key={`${workspace.deviceId}:${task.workspacePath}:${task.localTaskId}`}
                                    type="button"
                                    data-testid="mobile-runtime-task-button"
                                    disabled={disabled}
                                    onClick={() => {
                                      if (disabled) return
                                      void onOpenRuntimeLocalTask?.(
                                        getRuntimeTaskAddress(workspace, task)
                                      )
                                      onClose()
                                    }}
                                    className={[
                                      'flex h-12 min-w-[44px] w-full items-center rounded-[14px] px-2 text-left text-[18px] font-normal leading-6 disabled:cursor-not-allowed disabled:opacity-50',
                                      selectedTask
                                        ? 'bg-[#F1F1F1] text-[#111111]'
                                        : 'text-[#111111] hover:bg-[#F7F7F7]',
                                    ].join(' ')}
                                  >
                                    <span className="min-w-0 flex-1 truncate">{task.title}</span>
                                    {task.running ? (
                                      renderRuntimeTaskRunningStatus(
                                        `mobile-runtime-task-running-${task.localTaskId}`
                                      )
                                    ) : (
                                      <span className="ml-2 flex shrink-0 items-center gap-1 text-sm text-[#6B7280]">
                                        <span
                                          title={workspaceTitle}
                                          aria-label={workspaceTitle}
                                          role="img"
                                          className="flex h-3.5 w-3.5 shrink-0 items-center justify-center"
                                        >
                                          <Monitor className="h-3.5 w-3.5" aria-hidden="true" />
                                        </span>
                                        {isRuntimeWorktreeTask(task) && (
                                          <GitCompareArrows
                                            className="h-3.5 w-3.5 shrink-0"
                                            aria-label="Worktree"
                                          />
                                        )}
                                        <span>{formatRelativeTime(getRuntimeTaskTime(task))}</span>
                                      </span>
                                    )}
                                  </button>
                                )
                              })}
                              {(hasHiddenTasks || canCollapseTasks) && (
                                <div className="flex h-10 items-center gap-2">
                                  {hasHiddenTasks && (
                                    <button
                                      type="button"
                                      data-testid={`mobile-project-runtime-tasks-expand-${project.id}`}
                                      onClick={() =>
                                        setRuntimeProjectTaskVisibleLimits(previous => ({
                                          ...previous,
                                          [project.id]: getNextRuntimeSidebarTaskVisibleLimit(
                                            runtimeTaskVisibleLimit,
                                            taskItems.length
                                          ),
                                        }))
                                      }
                                      className="flex h-10 min-w-[44px] items-center rounded-lg px-2 text-left text-[15px] font-semibold text-[#6B7280] hover:bg-[#F7F7F7]"
                                    >
                                      {t('workbench.expand_display', '展开显示')}
                                    </button>
                                  )}
                                  {canCollapseTasks && (
                                    <button
                                      type="button"
                                      data-testid={`mobile-project-runtime-tasks-collapse-${project.id}`}
                                      onClick={() =>
                                        setRuntimeProjectTaskVisibleLimits(previous => {
                                          const next = { ...previous }
                                          delete next[project.id]
                                          return next
                                        })
                                      }
                                      className="flex h-10 min-w-[44px] items-center rounded-lg px-2 text-left text-[15px] font-semibold text-[#6B7280] hover:bg-[#F7F7F7]"
                                    >
                                      {t('workbench.collapse_display', '折叠显示')}
                                    </button>
                                  )}
                                </div>
                              )}
                            </>
                          )
                        })()}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>
        </div>
      </div>

      <button
        type="button"
        data-testid="mobile-new-chat-button"
        onClick={() => closeAfter(onNewChat ?? onStartStandaloneChat)}
        className="absolute bottom-[max(32px,env(safe-area-inset-bottom))] right-8 z-10 flex h-14 items-center gap-3 rounded-full bg-[#1F1F1F] px-6 text-[18px] font-semibold text-white shadow-[0_12px_32px_rgba(0,0,0,0.18)] hover:bg-[#111111]"
        aria-label={t('workbench.new_chat', '新对话')}
      >
        <SquarePen className="h-6 w-6" />
        <span>{t('workbench.chat', '聊天')}</span>
      </button>
      {projectCreateMode && (
        <ProjectCreateDialog
          open={projectCreateMode !== null}
          mode={projectCreateMode}
          devices={devices}
          onClose={() => setProjectCreateMode(null)}
          onOpenCloudDeviceSettings={() => {
            setProjectCreateMode(null)
            closeAfter(onOpenSettings)
          }}
          onCreateProject={onCreateProject ?? unavailableProjectAction}
          onCreateGitWorkspaceProject={onCreateGitWorkspaceProject}
          onPrepareDeviceWorkspace={onPrepareDeviceWorkspace ?? unavailableProjectAction}
          onDeleteDeviceWorkspace={onDeleteDeviceWorkspace ?? unavailableProjectAction}
          preferredDeviceId={user?.preferences?.default_execution_target}
          onGetDeviceHomeDirectory={onGetDeviceHomeDirectory ?? unavailableProjectAction}
          onGetProjectWorkspaceRoot={onGetProjectWorkspaceRoot ?? unavailableProjectAction}
          onListDeviceDirectories={onListDeviceDirectories ?? unavailableProjectAction}
          onCreateDeviceDirectory={onCreateDeviceDirectory ?? unavailableProjectAction}
          onListGitRepositories={onListGitRepositories}
          onListGitBranches={onListGitBranches}
          presentation="mobileSheet"
        />
      )}
      {projectActionTarget && (
        <div
          className="fixed inset-0 z-30"
          data-testid="mobile-project-actions-backdrop"
          onClick={() => setProjectActionTarget(null)}
        >
          <div
            data-testid="mobile-project-actions-menu"
            className="absolute w-[240px] overflow-hidden rounded-2xl border border-[#EDEDED] bg-white p-2 shadow-[0_12px_36px_rgba(0,0,0,0.18)]"
            style={actionMenuPosition}
            onClick={event => event.stopPropagation()}
          >
            <button
              type="button"
              data-testid="mobile-rename-project-button"
              onClick={() => {
                setRenameValue(projectActionTarget.name)
                setRenamingProjectId(projectActionTarget.id)
                setProjectActionTarget(null)
              }}
              className="flex h-14 min-w-[44px] w-full items-center gap-4 rounded-xl px-4 text-left text-[18px] text-[#111111] hover:bg-[#F7F7F7]"
            >
              <Edit3 className="h-6 w-6 shrink-0" />
              <span>{t('workbench.rename_project', '重命名项目')}</span>
            </button>
            <button
              type="button"
              data-testid="mobile-remove-project-button"
              onClick={() => handleAction(() => onRemoveProject?.(projectActionTarget.id))}
              className="flex h-14 min-w-[44px] w-full items-center gap-4 rounded-xl px-4 text-left text-[18px] text-[#EF4444] hover:bg-[#FFF5F5]"
            >
              <X className="h-6 w-6 shrink-0" />
              <span>{t('workbench.remove_project', '移除')}</span>
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
