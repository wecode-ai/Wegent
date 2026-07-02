import {
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  FolderPlus,
  FolderX,
  GitBranch,
  HardDrive,
  Laptop,
  Search,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ProjectFolderIcon } from '@/components/projects/ProjectFolderIcon'
import { useIsMobile } from '@/hooks/useIsMobile'
import { useTranslation } from '@/hooks/useTranslation'
import { isCloudDevice, isOnlineDevice, sortStandaloneDevices } from '@/lib/device-selection'
import { isWeWorkExecutorVersionCompatible } from '@/lib/device-capabilities'
import {
  buildProjectWorkspaceOptions,
  isSelectableProjectWorkspace,
} from '@/lib/project-workspace-selection'
import { supportsGitWorktreeExecution } from '@/lib/projectClassification'
import { runtimeProjectToProject } from '@/lib/runtime-project'
import { cn } from '@/lib/utils'
import type {
  DeviceInfo,
  ProjectExecutionMode,
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
  RuntimeWorkListResponse,
} from '@/types/api'
import type { ProjectCreateMode } from '../ChatInput'
import { useOutsideClick } from './useOutsideClick'
import { WorktreeBranchSelector } from './WorktreeBranchSelector'

const PROJECT_MENU_VIEWPORT_MARGIN = 16
const PROJECT_MENU_MAX_HEIGHT = 480
const PROJECT_MENU_VERTICAL_PADDING = 12
const PROJECT_MENU_SEARCH_BLOCK_HEIGHT = 42
const PROJECT_MENU_ROW_HEIGHT = 36
const PROJECT_MENU_ROW_GAP = 2
const PROJECT_MENU_VISIBLE_PROJECT_ROWS = 4
const PROJECT_MENU_LIST_MAX_HEIGHT =
  PROJECT_MENU_VISIBLE_PROJECT_ROWS * PROJECT_MENU_ROW_HEIGHT +
  (PROJECT_MENU_VISIBLE_PROJECT_ROWS - 1) * PROJECT_MENU_ROW_GAP
const PROJECT_MENU_EMPTY_STATE_HEIGHT = 42
const PROJECT_MENU_DIVIDER_BLOCK_HEIGHT = 13
const PROJECT_MENU_ACTION_HEIGHT = 32
const PROJECT_MENU_ACTION_GAP = 2
const EXECUTION_MODE_MENU_HEIGHT = 126

const CLIPPING_OVERFLOW_RE = /(auto|hidden|scroll|clip)/

function getMenuVisibleBounds(element: HTMLElement | null) {
  let top = PROJECT_MENU_VIEWPORT_MARGIN
  let bottom = window.innerHeight - PROJECT_MENU_VIEWPORT_MARGIN
  let current = element?.parentElement ?? null

  while (current && current !== document.body) {
    const style = window.getComputedStyle(current)
    const clipsVertically =
      CLIPPING_OVERFLOW_RE.test(style.overflowY) || CLIPPING_OVERFLOW_RE.test(style.overflow)

    if (clipsVertically) {
      const rect = current.getBoundingClientRect()
      if (rect.height > 0) {
        top = Math.max(top, rect.top + PROJECT_MENU_VIEWPORT_MARGIN)
        bottom = Math.min(bottom, rect.bottom - PROJECT_MENU_VIEWPORT_MARGIN)
      }
    }

    current = current.parentElement
  }

  return { top, bottom }
}

function getStackHeight(itemCount: number, itemHeight: number, gap: number) {
  if (itemCount <= 0) return 0
  return itemCount * itemHeight + (itemCount - 1) * gap
}

function getProjectMenuFitHeight(projectCount: number, hasCreateProjectOption: boolean) {
  const visibleProjectCount = Math.min(projectCount, PROJECT_MENU_VISIBLE_PROJECT_ROWS)
  const projectListHeight =
    visibleProjectCount > 0
      ? getStackHeight(visibleProjectCount, PROJECT_MENU_ROW_HEIGHT, PROJECT_MENU_ROW_GAP)
      : PROJECT_MENU_EMPTY_STATE_HEIGHT
  const actionCount = hasCreateProjectOption ? 3 : 1
  const actionHeight = getStackHeight(
    actionCount,
    PROJECT_MENU_ACTION_HEIGHT,
    PROJECT_MENU_ACTION_GAP
  )

  return (
    PROJECT_MENU_VERTICAL_PADDING +
    PROJECT_MENU_SEARCH_BLOCK_HEIGHT +
    projectListHeight +
    PROJECT_MENU_DIVIDER_BLOCK_HEIGHT +
    actionHeight
  )
}

function getProjectDeviceId(project: ProjectWithTasks): string | undefined {
  return project.config?.execution?.deviceId ?? project.config?.device_id
}

function isLocalStandaloneDevice(device: DeviceInfo): boolean {
  return device.device_type !== 'cloud' && device.device_type !== 'remote'
}

function isLocalProjectWorkspaceDevice(device: DeviceInfo | undefined): boolean {
  return Boolean(device && isLocalStandaloneDevice(device))
}

function extractNetworkHost(value?: string | null): string | null {
  if (!value) return null
  const trimmedValue = value.trim()
  if (!trimmedValue) return null

  const bracketMatch = trimmedValue.match(/^\[([^\]]+)\](?::\d+)?$/)
  if (bracketMatch?.[1]) return bracketMatch[1]

  const colonParts = trimmedValue.split(':')
  if (colonParts.length === 2 && /^\d+$/.test(colonParts[1])) {
    return colonParts[0]
  }

  return trimmedValue
}

function isLoopbackNetworkHost(host: string): boolean {
  const normalized = host.trim().toLowerCase()
  return normalized === 'localhost' || normalized === '::1' || normalized.startsWith('127.')
}

function getDisplayableNetworkHost(value?: string | null): string | null {
  const host = extractNetworkHost(value)
  if (!host || isLoopbackNetworkHost(host)) return null
  return host
}

function getDisplayableIp(value?: string | null): string | null {
  const host = getDisplayableNetworkHost(value)
  if (!host) return null
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host.includes(':')) return host
  return null
}

function getProjectMenuDeviceLabel(
  device: DeviceInfo | undefined,
  workspace: RuntimeDeviceWorkspace | null
): string | null {
  if (isLocalProjectWorkspaceDevice(device)) return null

  return (
    getDisplayableIp(device?.runtime_transfer_host) ??
    getDisplayableIp(device?.client_ip) ??
    getDisplayableIp(workspace?.deviceName) ??
    getDisplayableIp(workspace?.deviceId)
  )
}

function resolveProjectExecutionUi({
  project,
  executionMode,
  executionModeLocked,
  selectedWorkspaceIsRemote,
}: {
  project: ProjectWithTasks | null | undefined
  executionMode: ProjectExecutionMode
  executionModeLocked: boolean
  selectedWorkspaceIsRemote: boolean
}) {
  const supportsWorktree = Boolean(project && supportsGitWorktreeExecution(project))
  const displayedMode: ProjectExecutionMode =
    supportsWorktree && executionMode === 'git_worktree' ? 'git_worktree' : 'current_workspace'

  return {
    displayedMode,
    canShowModeControl: Boolean(project),
    canOpenModeMenu: supportsWorktree && !selectedWorkspaceIsRemote && !executionModeLocked,
  }
}

interface ProjectWorkBarProps {
  projects: ProjectWithTasks[]
  devices: DeviceInfo[]
  runtimeWork?: RuntimeWorkListResponse | null
  currentProject?: ProjectWithTasks | null
  currentProjectId?: number
  currentStandaloneDeviceId?: string | null
  selectedDeviceWorkspaceId?: number | null
  pendingProjectWorkspaceProjectId?: number | null
  executionMode: ProjectExecutionMode
  executionModeLocked?: boolean
  onSelectProject: (projectId: number | null) => void
  onSelectStandaloneDevice: (deviceId: string | null) => void
  onSelectProjectWorkspace?: (projectId: number, deviceWorkspaceId: number | null) => void
  onBindProjectWorkspace?: (projectId: number) => void
  onExecutionModeChange: (mode: ProjectExecutionMode) => void
  onCreateProjectMode?: (mode: ProjectCreateMode) => void
  branchName?: string
  branchLoading?: boolean
  onRefreshBranch?: () => Promise<void>
  onListBranches?: () => Promise<string[]>
  onCheckoutBranch?: (branchName: string) => Promise<void>
  onCreateBranch?: (branchName: string) => Promise<void>
  worktreeBranch?: string | null
  onWorktreeBranchChange?: (branchName: string | null) => void
  className?: string
  buttonClassName?: string
  menuClassName?: string
  emptyLabel?: string
}

export function ProjectWorkBar({
  devices,
  runtimeWork = null,
  currentProject: currentProjectProp = null,
  currentProjectId,
  selectedDeviceWorkspaceId = null,
  pendingProjectWorkspaceProjectId = null,
  executionMode,
  executionModeLocked = false,
  onSelectProject,
  onSelectStandaloneDevice,
  onSelectProjectWorkspace,
  onBindProjectWorkspace,
  onExecutionModeChange,
  onCreateProjectMode,
  branchName,
  branchLoading,
  onListBranches,
  worktreeBranch,
  onWorktreeBranchChange,
  className,
  buttonClassName,
  menuClassName,
  emptyLabel,
}: ProjectWorkBarProps) {
  const { t } = useTranslation('common')
  const isMobile = useIsMobile()
  const containerRef = useRef<HTMLDivElement>(null)
  const executionModeContainerRef = useRef<HTMLDivElement>(null)
  const triggerButtonRef = useRef<HTMLButtonElement>(null)
  const executionModeButtonRef = useRef<HTMLButtonElement>(null)

  const searchInputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [localProjectSubmenuOpen, setLocalProjectSubmenuOpen] = useState(false)
  const [executionModeOpenProjectId, setExecutionModeOpenProjectId] = useState<number | null>(null)
  const [projectQuery, setProjectQuery] = useState('')
  const [menuLayout, setMenuLayout] = useState<{
    placement: 'below' | 'above'
    maxHeight: number
  }>({ placement: 'below', maxHeight: PROJECT_MENU_MAX_HEIGHT })
  const [executionModePlacement, setExecutionModePlacement] = useState<'below' | 'above'>('below')
  const closeMenu = useCallback(() => {
    setOpen(false)
    setProjectQuery('')
    setLocalProjectSubmenuOpen(false)
  }, [])
  const closeExecutionModeMenu = useCallback(() => {
    setExecutionModeOpenProjectId(null)
  }, [])

  const standaloneDevices = useMemo(() => sortStandaloneDevices(devices), [devices])
  const runtimeProjectChoices = useMemo(
    () => (runtimeWork?.projects ?? []).map(runtimeProjectToProject),
    [runtimeWork?.projects]
  )
  const currentProject = useMemo(
    () =>
      currentProjectProp?.id === currentProjectId
        ? currentProjectProp
        : runtimeProjectChoices.find(project => project.id === currentProjectId),
    [currentProjectId, currentProjectProp, runtimeProjectChoices]
  )
  const getDeviceForProject = useCallback(
    (project: ProjectWithTasks): DeviceInfo | undefined => {
      const deviceId = getProjectDeviceId(project)
      if (!deviceId) return undefined
      return devices.find(d => d.device_id === deviceId)
    },
    [devices]
  )
  const hasRuntimeWork = runtimeWork != null
  const availableProjectChoices = runtimeProjectChoices
  const availableProjects = availableProjectChoices
  const projectWorkspaceOptions = useMemo(
    () =>
      buildProjectWorkspaceOptions({
        projects: availableProjectChoices,
        devices,
        runtimeWork,
      }),
    [availableProjectChoices, devices, runtimeWork]
  )
  const projectWorkspaceOptionByProjectId = useMemo(
    () => new Map(projectWorkspaceOptions.map(option => [option.project.id, option])),
    [projectWorkspaceOptions]
  )
  const currentProjectWorkspaceOption = currentProject
    ? projectWorkspaceOptionByProjectId.get(currentProject.id)
    : undefined
  const selectedDeviceWorkspace = useMemo(() => {
    if (!currentProjectWorkspaceOption) return null
    if (selectedDeviceWorkspaceId != null) {
      const workspace = currentProjectWorkspaceOption.workspaces.find(
        item => item.id === selectedDeviceWorkspaceId
      )
      if (workspace) return workspace
    }
    if (currentProjectWorkspaceOption.kind === 'single')
      return currentProjectWorkspaceOption.workspace
    return null
  }, [currentProjectWorkspaceOption, selectedDeviceWorkspaceId])
  const selectedWorkspaceDevice = selectedDeviceWorkspace
    ? devices.find(device => device.device_id === selectedDeviceWorkspace.deviceId)
    : undefined
  const selectedWorkspaceIsRemote = Boolean(
    currentProject &&
    selectedDeviceWorkspace &&
    selectedWorkspaceDevice &&
    !isLocalProjectWorkspaceDevice(selectedWorkspaceDevice)
  )
  const selectedWorkspaceDeviceIp = selectedWorkspaceIsRemote
    ? getProjectMenuDeviceLabel(selectedWorkspaceDevice, selectedDeviceWorkspace)
    : null
  const projectExecutionUi = resolveProjectExecutionUi({
    project: currentProject,
    executionMode,
    executionModeLocked,
    selectedWorkspaceIsRemote,
  })
  const executionModeOpen =
    projectExecutionUi.canOpenModeMenu && executionModeOpenProjectId === currentProjectId

  const updateMenuLayout = useCallback(() => {
    if (!open || typeof window === 'undefined') return

    const triggerRect = triggerButtonRef.current?.getBoundingClientRect()
    if (!triggerRect) return

    const visibleBounds = getMenuVisibleBounds(containerRef.current)
    const spaceBelow = visibleBounds.bottom - triggerRect.bottom
    const spaceAbove = triggerRect.top - visibleBounds.top
    const targetHeight = getProjectMenuFitHeight(
      runtimeProjectChoices.length,
      Boolean(onCreateProjectMode)
    )
    const placement = spaceBelow >= targetHeight || spaceBelow >= spaceAbove ? 'below' : 'above'
    const availableSpace = Math.max(placement === 'below' ? spaceBelow : spaceAbove, 0)
    const maxHeight = Math.min(PROJECT_MENU_MAX_HEIGHT, availableSpace)

    setMenuLayout(current => {
      if (current.placement === placement && current.maxHeight === maxHeight) {
        return current
      }
      return { placement, maxHeight }
    })
  }, [onCreateProjectMode, open, runtimeProjectChoices.length])

  const updateExecutionModeLayout = useCallback(() => {
    if (!executionModeOpen || typeof window === 'undefined') return

    const triggerRect = executionModeButtonRef.current?.getBoundingClientRect()
    if (!triggerRect) return

    const visibleBounds = getMenuVisibleBounds(executionModeContainerRef.current)
    const spaceBelow = visibleBounds.bottom - triggerRect.bottom
    const spaceAbove = triggerRect.top - visibleBounds.top
    const placement =
      spaceBelow >= EXECUTION_MODE_MENU_HEIGHT || spaceBelow >= spaceAbove ? 'below' : 'above'

    setExecutionModePlacement(current => {
      if (current === placement) return current
      return placement
    })
  }, [executionModeOpen])

  useLayoutEffect(() => {
    updateMenuLayout()
  }, [updateMenuLayout])

  useLayoutEffect(() => {
    updateExecutionModeLayout()
  }, [updateExecutionModeLayout])

  useEffect(() => {
    if (!open) return

    const handleResize = () => {
      updateMenuLayout()
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [open, updateMenuLayout])

  useEffect(() => {
    if (!executionModeOpen) return

    window.addEventListener('resize', updateExecutionModeLayout)
    return () => window.removeEventListener('resize', updateExecutionModeLayout)
  }, [executionModeOpen, updateExecutionModeLayout])

  useEffect(() => {
    if (!open) return
    if (isMobile) return

    searchInputRef.current?.focus()
  }, [isMobile, open])

  const handleSelectDeviceWorkspace = useCallback(
    (projectId: number, workspace: RuntimeDeviceWorkspace) => {
      if (!isSelectableProjectWorkspace(workspace, devices)) return
      onSelectProjectWorkspace?.(projectId, workspace.id ?? null)
      closeMenu()
    },
    [closeMenu, devices, onSelectProjectWorkspace]
  )

  const sortedProjects = useMemo(() => {
    return [...availableProjects].sort((a, b) => {
      const deviceA = getDeviceForProject(a)
      const deviceB = getDeviceForProject(b)
      const onlineA = deviceA?.status === 'online' ? 1 : 0
      const onlineB = deviceB?.status === 'online' ? 1 : 0
      return onlineB - onlineA
    })
  }, [availableProjects, getDeviceForProject])
  const normalizedProjectQuery = projectQuery.trim().toLowerCase()
  const filteredProjects = useMemo(() => {
    if (!normalizedProjectQuery) return sortedProjects

    return sortedProjects.filter(project => {
      const device = getDeviceForProject(project)
      const searchableText = [
        project.name,
        project.description ?? '',
        device?.name ?? '',
        device?.device_id ?? '',
      ]
        .join(' ')
        .toLowerCase()

      return searchableText.includes(normalizedProjectQuery)
    })
  }, [getDeviceForProject, normalizedProjectQuery, sortedProjects])
  const selectedLocalStandaloneDeviceId = useMemo(
    () =>
      standaloneDevices
        .filter(isLocalStandaloneDevice)
        .find(
          device =>
            isOnlineDevice(device) && isWeWorkExecutorVersionCompatible(device.executor_version)
        )?.device_id ?? null,
    [standaloneDevices]
  )
  const projectWorkTriggerLabel = emptyLabel ?? t('workbench.enter_project_work', '进入项目工作')
  const pendingWorkspaceSelection =
    currentProject &&
    pendingProjectWorkspaceProjectId === currentProject.id &&
    !selectedDeviceWorkspace
  const projectWorkTriggerAriaLabel = currentProject?.name ?? projectWorkTriggerLabel

  useOutsideClick(containerRef, open, closeMenu)
  useOutsideClick(executionModeContainerRef, executionModeOpen, closeExecutionModeMenu)

  const handleSelectProject = (projectId: number) => {
    const option = projectWorkspaceOptionByProjectId.get(projectId)
    if (hasRuntimeWork && option?.kind === 'multi') {
      onSelectProjectWorkspace?.(projectId, null)
      return
    }
    if (hasRuntimeWork && option?.kind === 'single' && option.workspace?.id && option.selectable) {
      onSelectProjectWorkspace?.(projectId, option.workspace.id)
      closeMenu()
      return
    }
    if (hasRuntimeWork && option?.kind === 'empty' && onBindProjectWorkspace) {
      onBindProjectWorkspace?.(projectId)
      closeMenu()
      return
    }
    onSelectProject(projectId)
    closeMenu()
  }

  const handleSelectStandaloneDevice = (deviceId: string | null) => {
    onSelectStandaloneDevice(deviceId)
    closeMenu()
  }

  const handleExecutionModeChange = (mode: ProjectExecutionMode) => {
    if (executionModeLocked) return
    if (mode !== executionMode) {
      onExecutionModeChange(mode)
    }
    closeExecutionModeMenu()
  }

  const handleCreateProject = (mode: ProjectCreateMode) => {
    onCreateProjectMode?.(mode)
    closeMenu()
  }

  const handleToggleMenu = () => {
    if (open) {
      closeMenu()
      return
    }
    closeExecutionModeMenu()
    setOpen(true)
  }

  const handleToggleExecutionModeMenu = () => {
    if (!projectExecutionUi.canOpenModeMenu) {
      closeExecutionModeMenu()
      return
    }
    if (executionModeOpen) {
      closeExecutionModeMenu()
      return
    }
    closeMenu()
    setExecutionModeOpenProjectId(currentProjectId ?? null)
  }

  const executionModeTriggerLabel = selectedWorkspaceIsRemote
    ? t('workbench.remote_short', '远程')
    : projectExecutionUi.displayedMode === 'git_worktree'
      ? t('workbench.execution_mode_git_worktree', '新工作树')
      : t('workbench.execution_mode_current_workspace_trigger', '本地模式')
  const ExecutionModeTriggerIcon = selectedWorkspaceIsRemote
    ? Cloud
    : projectExecutionUi.displayedMode === 'git_worktree'
      ? GitBranch
      : Laptop

  const renderMobileSheetHeader = (title: string, subtitle: string, onClose: () => void) => (
    <>
      <div className="mx-auto mt-3 h-1 w-11 shrink-0 rounded-full bg-border" />
      <div className="flex shrink-0 items-center justify-between px-5 pb-3 pt-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
          <p className="mt-1 truncate text-xs text-text-muted">{subtitle}</p>
        </div>
        <button
          type="button"
          data-testid="project-work-mobile-close-button"
          aria-label={t('workbench.close_menu', '关闭菜单')}
          onClick={onClose}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-surface text-text-primary"
        >
          <X className="h-5 w-5" />
        </button>
      </div>
    </>
  )

  const renderMobileBackdrop = (onClose: () => void) => (
    <div className="fixed inset-0 z-modal bg-black/25" onClick={onClose} />
  )

  const getCompactWorkspaceStatusLabel = (
    status: RuntimeDeviceWorkspace['deviceStatus'] | DeviceInfo['status'] | undefined,
    versionCompatible = true
  ) => {
    if (!versionCompatible) {
      return t('workbench.project_device_upgrade_required_short')
    }
    if (status === 'online') {
      return t('workbench.project_device_status_online', '在线')
    }
    if (status === 'busy') {
      return t('workbench.project_device_status_busy', '忙碌')
    }
    return t('workbench.project_device_status_offline', '离线')
  }

  const getWorkspaceStatusDotClass = (
    status: RuntimeDeviceWorkspace['deviceStatus'] | DeviceInfo['status'] | undefined
  ) => {
    if (status === 'online') return 'bg-primary'
    if (status === 'busy') return 'bg-amber-500'
    return 'bg-text-muted'
  }

  return (
    <div className={cn('flex min-h-[56px] w-full items-center gap-2 px-6', className)}>
      <div ref={containerRef} className="relative">
        {open && isMobile && renderMobileBackdrop(closeMenu)}
        {open && (
          <div
            data-testid="project-work-menu"
            data-mobile={isMobile ? 'true' : undefined}
            className={cn(
              isMobile
                ? 'fixed inset-x-0 bottom-0 z-modal flex max-h-[45dvh] flex-col rounded-t-[28px] border border-border bg-background shadow-[0_-18px_48px_rgba(0,0,0,0.18)]'
                : 'absolute left-0 z-popover flex w-80 flex-col rounded-2xl border border-border bg-background p-1.5 shadow-[0_16px_44px_rgba(0,0,0,0.16)]',
              !isMobile && (menuLayout.placement === 'below' ? 'top-9' : 'bottom-9'),
              !isMobile && menuClassName
            )}
            style={isMobile ? undefined : { maxHeight: menuLayout.maxHeight }}
          >
            {isMobile &&
              renderMobileSheetHeader(
                t('workbench.project_sheet_title', '选择项目'),
                currentProject?.name ??
                  emptyLabel ??
                  t('workbench.enter_project_work', '进入项目工作'),
                closeMenu
              )}
            <div className={cn(isMobile && 'flex min-h-0 flex-col px-5 pb-5')}>
              <label
                className={cn(
                  'mb-1.5 flex h-9 shrink-0 items-center gap-2 rounded-xl border border-border bg-surface px-3 text-text-secondary',
                  isMobile && 'h-11 rounded-2xl text-base'
                )}
              >
                <Search className="h-4 w-4 shrink-0" />
                <input
                  ref={searchInputRef}
                  data-testid="project-search-input"
                  type="search"
                  value={projectQuery}
                  onChange={event => setProjectQuery(event.target.value)}
                  placeholder={t('workbench.search_projects', '搜索项目')}
                  className={cn(
                    'min-w-0 flex-1 bg-transparent text-[13px] leading-[18px] text-text-primary outline-none placeholder:text-text-muted',
                    isMobile && 'text-base leading-5'
                  )}
                />
              </label>
              {availableProjects.length === 0 ? (
                <div className="px-4 py-3 text-[13px] leading-[18px] text-text-muted">
                  {t('workbench.no_projects', '暂无项目')}
                </div>
              ) : filteredProjects.length === 0 ? (
                <div
                  data-testid="project-search-empty"
                  className="px-4 py-3 text-[13px] leading-[18px] text-text-muted"
                >
                  {t('workbench.project_search_no_results', '没有匹配的项目')}
                </div>
              ) : (
                <div
                  data-testid="project-options-list"
                  className={cn(
                    'min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1',
                    isMobile && 'scrollbar-none max-h-[calc(45dvh-168px)] space-y-2 py-2'
                  )}
                  style={{ maxHeight: isMobile ? undefined : PROJECT_MENU_LIST_MAX_HEIGHT }}
                >
                  {filteredProjects.map(project => {
                    const option = projectWorkspaceOptionByProjectId.get(project.id)
                    const singleWorkspace = option?.kind === 'single' ? option.workspace : null
                    const summaryWorkspace = singleWorkspace ?? option?.workspaces[0] ?? null
                    const summaryWorkspaceDevice = summaryWorkspace
                      ? devices.find(item => item.device_id === summaryWorkspace.deviceId)
                      : undefined
                    const device = getDeviceForProject(project) ?? summaryWorkspaceDevice
                    const deviceLabel = getProjectMenuDeviceLabel(device, summaryWorkspace)
                    const deviceStatus = device?.status ?? summaryWorkspace?.deviceStatus
                    const versionCompatible = device
                      ? isWeWorkExecutorVersionCompatible(device.executor_version)
                      : true
                    const DeviceIcon = device && isCloudDevice(device) ? Cloud : HardDrive
                    const selected = project.id === currentProjectId
                    const projectTextClass = selected ? 'text-text-primary' : 'text-text-secondary'
                    const expanded =
                      option?.kind === 'multi' && pendingProjectWorkspaceProjectId === project.id
                    const bindRequired =
                      hasRuntimeWork && option?.kind === 'empty' && Boolean(onBindProjectWorkspace)
                    return (
                      <div key={project.id} className="space-y-0.5">
                        <button
                          type="button"
                          data-testid={`project-option-${project.id}`}
                          onClick={() => handleSelectProject(project.id)}
                          className={`flex h-9 w-full rounded-lg px-4 text-left hover:bg-muted ${projectTextClass}`}
                        >
                          <div className="flex min-h-0 w-full items-center gap-3">
                            <ProjectFolderIcon
                              project={project}
                              testId={`project-available-icon-${project.id}`}
                              className="h-4 w-4 shrink-0 text-text-secondary"
                            />
                            <div className="flex min-w-0 flex-1 items-center gap-2">
                              <span
                                className={cn(
                                  'min-w-0 truncate text-[13px] font-semibold leading-[18px]',
                                  deviceLabel ? 'max-w-[9rem] shrink' : 'flex-1',
                                  'text-text-primary'
                                )}
                              >
                                {project.name}
                              </span>
                              {deviceLabel && (
                                <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs leading-4 text-text-secondary">
                                  <DeviceIcon className="h-3.5 w-3.5 shrink-0" />
                                  <span
                                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${getWorkspaceStatusDotClass(deviceStatus)}`}
                                  />
                                  <span className="min-w-0 truncate text-text-secondary">
                                    {deviceLabel}
                                  </span>
                                  <span className="shrink-0">
                                    {getCompactWorkspaceStatusLabel(
                                      deviceStatus,
                                      versionCompatible
                                    )}
                                  </span>
                                </span>
                              )}
                            </div>
                            {selected && (
                              <Check
                                data-testid={`project-selected-icon-${project.id}`}
                                className="h-3.5 w-3.5 shrink-0 text-text-primary"
                              />
                            )}
                          </div>
                        </button>
                        {bindRequired && (
                          <button
                            type="button"
                            data-testid={`project-bind-workspace-${project.id}`}
                            onClick={() => {
                              onBindProjectWorkspace?.(project.id)
                              closeMenu()
                            }}
                            className="ml-7 flex h-9 w-[calc(100%-1.75rem)] items-center gap-2 rounded-lg px-3 text-left text-[13px] font-medium leading-[18px] text-text-secondary hover:bg-muted"
                          >
                            <FolderPlus className="h-3.5 w-3.5 shrink-0" />
                            <span>{t('workbench.bind_project_workspace', '绑定设备工作区')}</span>
                          </button>
                        )}
                        {expanded &&
                          option?.workspaces.map(workspace => {
                            const workspaceSelected = workspace.id === selectedDeviceWorkspaceId
                            const selectable = isSelectableProjectWorkspace(workspace, devices)
                            const workspaceDevice = devices.find(
                              item => item.device_id === workspace.deviceId
                            )
                            const WorkspaceDeviceIcon =
                              workspaceDevice && isCloudDevice(workspaceDevice) ? Cloud : HardDrive
                            return (
                              <button
                                key={`${workspace.deviceId}:${workspace.workspacePath}`}
                                type="button"
                                data-testid={`project-workspace-option-${workspace.id ?? workspace.deviceId}`}
                                disabled={!selectable}
                                onClick={() => handleSelectDeviceWorkspace(project.id, workspace)}
                                className={cn(
                                  'ml-7 flex h-9 w-[calc(100%-1.75rem)] items-center gap-2 rounded-lg px-3 text-left text-[13px] leading-[18px]',
                                  selectable
                                    ? 'text-text-secondary hover:bg-muted'
                                    : 'cursor-not-allowed text-text-muted opacity-60',
                                  workspaceSelected && 'bg-muted text-text-primary'
                                )}
                              >
                                <WorkspaceDeviceIcon className="h-3.5 w-3.5 shrink-0" />
                                <span
                                  className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                    workspace.deviceStatus === 'online'
                                      ? 'bg-primary'
                                      : workspace.deviceStatus === 'busy'
                                        ? 'bg-amber-500'
                                        : 'bg-text-muted'
                                  }`}
                                />
                                <span className="min-w-0 flex-1 truncate">
                                  {workspace.deviceName || workspace.deviceId}
                                </span>
                                <span className="min-w-0 max-w-[7rem] truncate text-xs text-text-muted">
                                  {workspace.workspacePath}
                                </span>
                                {workspaceSelected && <Check className="h-3.5 w-3.5 shrink-0" />}
                              </button>
                            )
                          })}
                      </div>
                    )
                  })}
                </div>
              )}
              <div className="my-1.5 shrink-0 border-t border-border" />
              <div className={cn('shrink-0 space-y-0.5', isMobile && 'space-y-2')}>
                {onCreateProjectMode && (
                  <div className="relative">
                    <button
                      type="button"
                      data-testid="add-local-project-option"
                      onMouseEnter={() => setLocalProjectSubmenuOpen(true)}
                      onFocus={() => setLocalProjectSubmenuOpen(true)}
                      onClick={() => setLocalProjectSubmenuOpen(value => !value)}
                      className="flex h-8 w-full items-center gap-3 rounded-lg px-4 text-left text-[13px] font-medium leading-[18px] text-text-secondary hover:bg-muted"
                    >
                      <FolderPlus className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 flex-1">
                        {t('workbench.add_local_project', '添加本地项目')}
                      </span>
                      <ChevronRight className="h-4 w-4 shrink-0" />
                    </button>
                    {localProjectSubmenuOpen && (
                      <div
                        data-testid="add-local-project-submenu"
                        onMouseEnter={() => setLocalProjectSubmenuOpen(true)}
                        className={cn(
                          isMobile
                            ? 'mt-1 space-y-0.5 rounded-xl bg-surface/70 p-1'
                            : 'absolute left-[calc(100%+0.5rem)] top-0 z-popover w-56 rounded-2xl border border-border bg-background p-1.5 shadow-[0_16px_44px_rgba(0,0,0,0.16)]'
                        )}
                      >
                        <button
                          type="button"
                          data-testid="add-local-blank-project-option"
                          onClick={() => handleCreateProject('scratch')}
                          className="flex h-9 w-full items-center gap-3 rounded-lg px-4 text-left text-[13px] font-medium leading-[18px] text-text-secondary hover:bg-muted"
                        >
                          <FolderPlus className="h-4 w-4 shrink-0" />
                          <span className="min-w-0 flex-1">
                            {t('workbench.new_blank_project', '新建空白项目')}
                          </span>
                        </button>
                        <button
                          type="button"
                          data-testid="add-local-existing-project-option"
                          onClick={() => handleCreateProject('existing')}
                          className="flex h-9 w-full items-center gap-3 rounded-lg px-4 text-left text-[13px] font-medium leading-[18px] text-text-secondary hover:bg-muted"
                        >
                          <ProjectFolderIcon
                            project={{ id: 0, name: 'folder', tasks: [] }}
                            className="h-4 w-4 shrink-0 text-text-secondary"
                          />
                          <span className="min-w-0 flex-1">
                            {t('workbench.use_existing_folder', '使用现有文件夹')}
                          </span>
                        </button>
                      </div>
                    )}
                  </div>
                )}
                {onCreateProjectMode && (
                  <div>
                    <button
                      type="button"
                      data-testid="add-remote-project-option"
                      onMouseEnter={() => setLocalProjectSubmenuOpen(false)}
                      onFocus={() => setLocalProjectSubmenuOpen(false)}
                      onClick={() => handleCreateProject('git')}
                      className="flex h-8 w-full items-center gap-3 rounded-lg px-4 text-left text-[13px] font-medium leading-[18px] text-text-secondary hover:bg-muted"
                    >
                      <Cloud className="h-4 w-4 shrink-0" />
                      <span className="min-w-0 flex-1">
                        {t('workbench.add_remote_project', '添加远程项目')}
                      </span>
                    </button>
                  </div>
                )}
                <div>
                  <button
                    type="button"
                    data-testid="no-project-option"
                    onMouseEnter={() => setLocalProjectSubmenuOpen(false)}
                    onFocus={() => setLocalProjectSubmenuOpen(false)}
                    onClick={() => handleSelectStandaloneDevice(selectedLocalStandaloneDeviceId)}
                    className="flex h-8 w-full items-center gap-3 rounded-lg px-4 text-left text-[13px] font-medium leading-[18px] text-text-secondary hover:bg-muted"
                  >
                    <FolderX className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1">
                      {t('workbench.no_project', '不使用项目')}
                    </span>
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}
        <button
          ref={triggerButtonRef}
          type="button"
          data-testid="project-work-button"
          onClick={handleToggleMenu}
          className={cn(
            'flex h-9 min-w-[44px] items-center gap-2 rounded-full px-2 text-[14px] font-medium leading-5 text-text-secondary transition-[background-color,color,box-shadow] hover:bg-background/70 hover:text-text-primary hover:shadow-[0_8px_22px_rgba(0,0,0,0.10)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
            open && 'bg-background/70 text-text-primary shadow-[0_8px_22px_rgba(0,0,0,0.10)]',
            buttonClassName
          )}
          aria-expanded={open}
          aria-label={projectWorkTriggerAriaLabel}
        >
          {currentProject ? (
            <>
              <ProjectFolderIcon project={currentProject} className="h-4 w-4" />
              <span className="max-w-[12rem] truncate">{currentProject.name}</span>
              {pendingWorkspaceSelection ? (
                <>
                  <span className="text-text-muted">·</span>
                  <span className="shrink-0 text-text-secondary">
                    {t('workbench.select_workspace', '选择工作区')}
                  </span>
                </>
              ) : null}
            </>
          ) : (
            <>
              <FolderPlus className="h-5 w-5" />
              <span className="shrink-0">{projectWorkTriggerLabel}</span>
            </>
          )}
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
      {projectExecutionUi.canShowModeControl && (
        <div ref={executionModeContainerRef} className="relative">
          {executionModeOpen && isMobile && renderMobileBackdrop(closeExecutionModeMenu)}
          {executionModeOpen && (
            <div
              data-testid="project-execution-mode-menu"
              data-mobile={isMobile ? 'true' : undefined}
              className={cn(
                isMobile
                  ? 'fixed inset-x-0 bottom-0 z-modal flex max-h-[45dvh] flex-col rounded-t-[28px] border border-border bg-background shadow-[0_-18px_48px_rgba(0,0,0,0.18)]'
                  : 'absolute left-0 z-popover w-56 rounded-2xl border border-border bg-background p-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]',
                !isMobile && (executionModePlacement === 'below' ? 'top-11' : 'bottom-11')
              )}
            >
              {isMobile &&
                renderMobileSheetHeader(
                  t('workbench.execution_mode_label', '启动模式'),
                  executionModeTriggerLabel,
                  closeExecutionModeMenu
                )}
              <div
                data-testid="project-execution-mode-menu-section"
                className={cn('space-y-0.5', isMobile && 'px-5 pb-5 pt-2')}
              >
                <div className="px-2 pb-1 text-xs font-medium leading-5 text-text-muted">
                  {t('workbench.execution_mode_label', '启动模式')}
                </div>
                <button
                  type="button"
                  data-testid="execution-mode-current-workspace-button"
                  disabled={executionModeLocked}
                  onClick={() => handleExecutionModeChange('current_workspace')}
                  className={cn(
                    'flex h-9 w-full items-center gap-3 rounded-lg px-2 text-left text-[13px] font-medium leading-[18px] disabled:cursor-not-allowed disabled:opacity-60',
                    isMobile && 'h-14 rounded-2xl bg-surface px-4 text-base leading-5',
                    executionMode === 'current_workspace'
                      ? 'text-text-primary'
                      : 'text-text-secondary hover:bg-muted'
                  )}
                >
                  <Laptop className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    {t('workbench.execution_mode_current_workspace', '在本地处理')}
                  </span>
                  {executionMode === 'current_workspace' && <Check className="h-4 w-4 shrink-0" />}
                </button>
                <button
                  type="button"
                  data-testid="execution-mode-git-worktree-button"
                  disabled={executionModeLocked}
                  onClick={() => handleExecutionModeChange('git_worktree')}
                  className={cn(
                    'flex h-9 w-full items-center gap-3 rounded-lg px-2 text-left text-[13px] font-medium leading-[18px] disabled:cursor-not-allowed disabled:opacity-60',
                    isMobile && 'h-14 rounded-2xl bg-surface px-4 text-base leading-5',
                    executionMode === 'git_worktree'
                      ? 'text-text-primary'
                      : 'text-text-secondary hover:bg-muted'
                  )}
                >
                  <GitBranch className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1">
                    {t('workbench.execution_mode_git_worktree', '新工作树')}
                  </span>
                  {executionMode === 'git_worktree' && <Check className="h-4 w-4 shrink-0" />}
                </button>
              </div>
            </div>
          )}
          <button
            ref={executionModeButtonRef}
            type="button"
            data-testid="execution-mode-button"
            onClick={handleToggleExecutionModeMenu}
            className={cn(
              'flex h-9 min-w-[44px] items-center gap-2 rounded-full px-2 text-[14px] font-medium leading-5 text-text-secondary transition-[background-color,color,box-shadow] hover:bg-background/70 hover:text-text-primary hover:shadow-[0_8px_22px_rgba(0,0,0,0.10)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30',
              executionModeOpen &&
                'bg-background/70 text-text-primary shadow-[0_8px_22px_rgba(0,0,0,0.10)]'
            )}
            aria-expanded={executionModeOpen}
            aria-label={t('workbench.execution_mode_label', '启动模式')}
          >
            <ExecutionModeTriggerIcon className="h-4 w-4 shrink-0" />
            <span className="max-w-[8rem] truncate">{executionModeTriggerLabel}</span>
            <ChevronDown className="h-4 w-4 shrink-0" />
          </button>
        </div>
      )}
      {currentProject &&
        projectExecutionUi.displayedMode === 'git_worktree' &&
        !executionModeLocked &&
        onListBranches &&
        onWorktreeBranchChange && (
          <WorktreeBranchSelector
            currentBranch={branchName}
            selectedBranch={worktreeBranch}
            loading={branchLoading}
            onListBranches={onListBranches}
            onSelectBranch={onWorktreeBranchChange}
          />
        )}
      {selectedWorkspaceIsRemote && selectedWorkspaceDeviceIp && (
        <div
          data-testid="project-work-remote-status"
          className="ml-auto flex min-w-0 items-center gap-2 text-[13px] font-medium leading-[18px] text-text-primary"
        >
          <span className="truncate">{selectedWorkspaceDeviceIp}</span>
          <span
            className={`h-1.5 w-1.5 shrink-0 rounded-full ${getWorkspaceStatusDotClass(
              selectedDeviceWorkspace?.deviceStatus ?? selectedWorkspaceDevice?.status
            )}`}
          />
        </div>
      )}
    </div>
  )
}
