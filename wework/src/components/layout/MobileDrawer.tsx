import {
  Edit3,
  Folder,
  FolderGit2,
  FolderOpen,
  FolderPlus,
  Loader2,
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
import type {
  CreateGitWorkspaceProjectRequest,
  CreateProjectRequest,
  DeviceInfo,
  GitBranch,
  GitRepoInfo,
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
  RuntimeTaskAddress,
  RuntimeWorkListResponse,
  User,
} from '@/types/api'
import {
  getRuntimeTaskRuntimeLabel,
  getRuntimeTaskTime,
  isRuntimeTaskSelected,
  sortRuntimeTasks,
} from './runtimeTaskSidebarHelpers'

const MOBILE_RUNNING_SPINNER_CLASS = 'ml-2 h-3.5 w-3.5 shrink-0 animate-spin text-[#6B7280]'
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

function formatRelativeTime(value?: string) {
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

function getRuntimeWorkspaceLabel(workspace: RuntimeDeviceWorkspace) {
  const pathLabel = workspace.label || workspace.workspacePath
  return `${workspace.deviceName} · ${pathLabel}`
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
  const [projectCreateMenuOpen, setProjectCreateMenuOpen] = useState(false)
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
  const runtimeWorkByProjectId = useMemo(() => {
    const items = runtimeWork?.projects ?? []
    return new Map(items.map(item => [item.project.id, item]))
  }, [runtimeWork])
  const unmappedWorkspaces = useMemo(
    () => runtimeWork?.unmappedDeviceWorkspaces ?? [],
    [runtimeWork]
  )

  if (!open) return null

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

  const openProjectCreateDialog = (mode: ProjectCreateMode) => {
    setProjectCreateMenuOpen(false)
    setProjectCreateMode(mode)
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
                  onClick={() => setProjectCreateMenuOpen(open => !open)}
                  aria-expanded={projectCreateMenuOpen}
                  className="mx-3 flex h-[54px] min-w-[44px] w-[calc(100%-24px)] items-center gap-[18px] rounded-[14px] px-3 text-left text-[18px] font-normal leading-6 text-[#111111] hover:bg-[#F7F7F7] disabled:cursor-not-allowed disabled:text-[#6B7280]"
                  disabled={!canOpenProjectSheet}
                >
                  <FolderPlus className="h-6 w-6 shrink-0 stroke-[2.4]" />
                  <span className="min-w-0 truncate">{t('workbench.new_project', '新建项目')}</span>
                </button>
                {projectCreateMenuOpen && (
                  <>
                    <button
                      type="button"
                      data-testid="mobile-project-create-menu-backdrop"
                      aria-label={t('workbench.close_menu', '关闭菜单')}
                      onClick={() => setProjectCreateMenuOpen(false)}
                      className="fixed inset-0 z-10 cursor-default"
                    />
                    <div
                      data-testid="mobile-project-create-menu"
                      className="absolute left-4 top-[58px] z-20 w-[min(350px,calc(100vw-32px))] rounded-[18px] border border-[#E0E0E0] bg-white p-2 shadow-[0_12px_32px_rgba(0,0,0,0.14)]"
                    >
                      {[
                        {
                          mode: 'scratch' as const,
                          label: t('workbench.start_from_scratch', '新建空白项目'),
                          icon: FolderPlus,
                          testId: 'mobile-project-start-from-scratch-button',
                        },
                        {
                          mode: 'existing' as const,
                          label: t('workbench.using_existing_folder', '使用现有目录'),
                          icon: Folder,
                          testId: 'mobile-project-existing-folder-button',
                        },
                        {
                          mode: 'git' as const,
                          label: t('workbench.clone_from_git', '从 Git 克隆'),
                          icon: FolderGit2,
                          testId: 'mobile-project-clone-from-git-button',
                        },
                      ].map(item => {
                        const Icon = item.icon
                        return (
                          <button
                            key={item.mode}
                            type="button"
                            data-testid={item.testId}
                            onClick={() => openProjectCreateDialog(item.mode)}
                            className="flex h-14 min-w-[44px] w-full items-center gap-4 rounded-xl px-4 text-left text-[18px] font-normal text-[#111111] hover:bg-[#F7F7F7]"
                          >
                            <Icon className="h-6 w-6 shrink-0 stroke-[2.2]" />
                            <span>{item.label}</span>
                          </button>
                        )
                      })}
                    </div>
                  </>
                )}
              </div>
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
                        {workspaces.length === 0 && (
                          <div className="flex h-10 items-center rounded-lg px-2 text-left text-[15px] text-[#6B7280]">
                            {t('workbench.no_chats', '暂无会话')}
                          </div>
                        )}
                        {workspaces.map(workspace => {
                          const tasks = sortRuntimeTasks(workspace.localTasks)
                          return (
                            <div key={`${workspace.deviceId}:${workspace.workspacePath}`}>
                              <div className="flex h-8 items-center rounded-lg px-2 text-left text-[13px] font-medium text-[#6B7280]">
                                <span className="min-w-0 flex-1 truncate">
                                  {getRuntimeWorkspaceLabel(workspace)}
                                </span>
                                {!workspace.available && (
                                  <span className="ml-2 shrink-0">
                                    {t('workbench.device_offline', '离线')}
                                  </span>
                                )}
                              </div>
                              {tasks.length === 0 ? (
                                <div className="flex h-10 items-center rounded-lg px-2 text-left text-[15px] text-[#6B7280]">
                                  {t('workbench.no_chats', '暂无会话')}
                                </div>
                              ) : (
                                tasks.map(task => {
                                  const selectedTask = isRuntimeTaskSelected(
                                    currentRuntimeTask,
                                    workspace,
                                    task
                                  )
                                  const disabled = !workspace.available || !onOpenRuntimeLocalTask
                                  return (
                                    <button
                                      key={task.localTaskId}
                                      type="button"
                                      data-testid="mobile-runtime-task-button"
                                      disabled={disabled}
                                      onClick={() => {
                                        if (disabled) return
                                        void onOpenRuntimeLocalTask?.({
                                          deviceId: workspace.deviceId,
                                          workspacePath: workspace.workspacePath,
                                          localTaskId: task.localTaskId,
                                        })
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
                                        <Loader2 className={MOBILE_RUNNING_SPINNER_CLASS} />
                                      ) : (
                                        <span className="ml-2 flex shrink-0 items-center gap-1 text-sm text-[#6B7280]">
                                          <span>{getRuntimeTaskRuntimeLabel(task.runtime)}</span>
                                          <span>
                                            {formatRelativeTime(getRuntimeTaskTime(task))}
                                          </span>
                                        </span>
                                      )}
                                    </button>
                                  )
                                })
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          </section>

          <section className="mt-8">
            <div className="mb-3 flex items-center justify-between px-6">
              <h2 className="text-[18px] font-bold leading-6 text-[#111111]">
                {t('workbench.unmapped_device_workspaces', '未映射工作区')}
              </h2>
            </div>
            <div className="space-y-2">
              {unmappedWorkspaces.length === 0 ? (
                <div className="mx-3 flex h-10 items-center rounded-lg px-3 text-left text-[15px] text-[#6B7280]">
                  {t('workbench.no_unmapped_device_workspaces', '暂无未映射工作区')}
                </div>
              ) : (
                unmappedWorkspaces.map(workspace => (
                  <div
                    key={`${workspace.deviceId}:${workspace.workspacePath}`}
                    className="mx-3 rounded-[14px]"
                  >
                    <div className="flex h-9 items-center rounded-lg px-3 text-left text-[13px] font-medium text-[#6B7280]">
                      <span className="min-w-0 flex-1 truncate">
                        {getRuntimeWorkspaceLabel(workspace)}
                      </span>
                    </div>
                    {sortRuntimeTasks(workspace.localTasks).map(task => {
                      const selectedTask = isRuntimeTaskSelected(
                        currentRuntimeTask,
                        workspace,
                        task
                      )
                      const disabled = !workspace.available || !onOpenRuntimeLocalTask
                      return (
                        <button
                          key={task.localTaskId}
                          type="button"
                          data-testid="mobile-unmapped-runtime-task-button"
                          disabled={disabled}
                          onClick={() => {
                            if (disabled) return
                            void onOpenRuntimeLocalTask?.({
                              deviceId: workspace.deviceId,
                              workspacePath: workspace.workspacePath,
                              localTaskId: task.localTaskId,
                            })
                            onClose()
                          }}
                          className={[
                            'flex h-12 min-w-[44px] w-full items-center rounded-[14px] px-3 text-left text-[18px] font-normal leading-6 disabled:cursor-not-allowed disabled:opacity-50',
                            selectedTask
                              ? 'bg-[#F1F1F1] text-[#111111]'
                              : 'text-[#111111] hover:bg-[#F7F7F7]',
                          ].join(' ')}
                        >
                          <span className="min-w-0 flex-1 truncate">{task.title}</span>
                          {task.running ? (
                            <Loader2 className={MOBILE_RUNNING_SPINNER_CLASS} />
                          ) : (
                            <span className="ml-2 shrink-0 text-sm text-[#6B7280]">
                              {formatRelativeTime(getRuntimeTaskTime(task))}
                            </span>
                          )}
                        </button>
                      )
                    })}
                  </div>
                ))
              )}
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
