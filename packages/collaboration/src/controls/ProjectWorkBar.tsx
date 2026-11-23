import { isWeWorkExecutorVersionCompatible } from '@wegent/chat-core/device-capabilities'
import { isCloudDevice } from '@wegent/chat-core/device-selection'
import type { DeviceInfo, ProjectWithTasks } from '@wegent/chat-core/execution-project'
import {
  buildProjectWorkspaceOptions,
  isSelectableProjectWorkspace,
} from '@wegent/chat-core/project-workspace-selection'
import { resolveRuntimeTaskProjects, runtimeProjectUiId } from '@wegent/chat-core/runtime-project'
import type {
  RuntimeDeviceWorkspace,
  RuntimeWorkListResponse,
} from '@wegent/chat-core/runtime-task-api-types'
import {
  Check,
  ChevronDown,
  Cloud,
  Folder,
  FolderPlus,
  FolderX,
  HardDrive,
  Search,
  X,
} from 'lucide-react'
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type ReactElement,
} from 'react'
import { ComposerContextButton } from '../composer/ComposerContextButton'
import { useFocusRequest } from '../dom-events'
import type { CollaborationTranslate } from '../i18n'
import { activityClassNames as cn } from '../issue-detail/activityClassNames'
import { Button as ControlButton } from '../markdown/Button'
import { useCollaborationPortalTheme } from '../theme'
import {
  getProjectDeviceId,
  getProjectMenuDeviceLabel,
  isLocalProjectWorkspaceDevice,
} from './project-work-bar-utils'
import { ProjectFolderIcon } from './ProjectFolderIcon'
import { DialogSurface } from './DialogSurface'
import { Popover, PopoverContent, PopoverTrigger } from './Popover'
import { TextField as ControlInput } from './TextField'
export type ProjectCreateMode = 'scratch' | 'existing' | 'git'

const PROJECT_MENU_MAX_HEIGHT = 480
const PROJECT_MENU_LIST_MAX_HEIGHT = 230
function workspaceFolderName(path: string): string {
  const normalized = path.trim().replace(/[\\/]+$/, '')
  return normalized.split(/[\\/]/).filter(Boolean).at(-1) || normalized || path
}

function workspacePathSummary(path: string): string {
  const parts = path
    .trim()
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .filter(Boolean)
  if (parts.length <= 2) return path
  return `…/${parts.slice(-2).join('/')}`
}

export interface ProjectWorkBarProps {
  translate: CollaborationTranslate
  isMobile: boolean
  renderCreateSection?(closeMenu: () => void): ReactNode
  renderWorkSection?(project: ProjectWithTasks | null | undefined): ReactNode
  projects: ProjectWithTasks[]
  devices: DeviceInfo[]
  runtimeWork?: RuntimeWorkListResponse | null
  currentProject?: ProjectWithTasks | null
  currentProjectId?: number
  currentStandaloneDeviceId?: string | null
  selectedDeviceWorkspaceId?: number | null
  pendingProjectWorkspaceProjectId?: number | null
  onSelectProject: (projectId: number | null) => void
  onSelectStandaloneDevice: (deviceId: string | null) => void
  onSelectProjectWorkspace?: (
    projectId: number,
    deviceWorkspaceId: number | null,
    workspace?: RuntimeDeviceWorkspace
  ) => void
  onBindProjectWorkspace?: (projectId: number) => void
  onCreateProjectMode?: (mode: ProjectCreateMode) => void
  className?: string
  buttonClassName?: string
  menuClassName?: string
  emptyLabel?: string
  selectorLabel?: string
  menuLabels?: Partial<
    Record<'search' | 'empty' | 'emptyHint' | 'noResults' | 'clear' | 'addLocal', string>
  >
  showProjectSelector?: boolean
  // When false, the desktop trigger shows a static folder icon instead of the
  // hover-to-clear button (used when the current project is a default the user
  // cannot clear from here).
  showClearButton?: boolean
  projectMenuOpenSignal?: number
  externalMenuOpenSignal?: number
  projectMenuAnchorElement?: HTMLElement | null
  middleContext?: ReactNode
  trailingContext?: ReactNode
  endContext?: ReactNode
}

export function ProjectWorkBar({
  translate: t,
  isMobile,
  renderCreateSection,
  renderWorkSection,
  projects = [],
  devices,
  runtimeWork = null,
  currentProject: currentProjectProp = null,
  currentProjectId,
  selectedDeviceWorkspaceId = null,
  pendingProjectWorkspaceProjectId = null,
  onSelectProject,
  onSelectProjectWorkspace,
  onBindProjectWorkspace,
  onCreateProjectMode,
  className,
  buttonClassName,
  menuClassName,
  emptyLabel,
  selectorLabel,
  menuLabels,
  showProjectSelector = true,
  showClearButton = true,
  projectMenuOpenSignal,
  externalMenuOpenSignal,
  projectMenuAnchorElement = null,
  middleContext,
  trailingContext,
  endContext,
}: ProjectWorkBarProps) {
  const portalTheme = useCollaborationPortalTheme()
  const [containerElement, setContainerElement] = useState<HTMLDivElement | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [triggerElement, setTriggerElement] = useState<HTMLButtonElement | null>(null)
  const [handledOpenSignals, setHandledOpenSignals] = useState<{project?: number; external?: number}>({})

  const searchInputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [projectQuery, setProjectQuery] = useState('')
  const [expandedMultiProjectId, setExpandedMultiProjectId] = useState<number | null>(null)
  const [externalMenuAnchorElement, setExternalMenuAnchorElement] = useState<HTMLElement | null>(
    null
  )
  const closeMenu = useCallback(() => {
    setOpen(false)
    setProjectQuery('')
  }, [])

  const availableProjectChoices = useMemo(
    () => resolveRuntimeTaskProjects(projects, runtimeWork),
    [projects, runtimeWork]
  )
  const runtimeProjectWorkById = useMemo(
    () =>
      new Map((runtimeWork?.projects ?? []).map(item => [runtimeProjectUiId(item.project), item])),
    [runtimeWork?.projects]
  )
  const currentProject = useMemo(
    () =>
      currentProjectProp?.id === currentProjectId
        ? currentProjectProp
        : availableProjectChoices.find(project => project.id === currentProjectId),
    [availableProjectChoices, currentProjectId, currentProjectProp]
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
  const handleSelectDeviceWorkspace = useCallback(
    (projectId: number, workspace: RuntimeDeviceWorkspace) => {
      if (!isSelectableProjectWorkspace(workspace, devices)) return
      onSelectProjectWorkspace?.(projectId, workspace.id ?? null, workspace)
      setExpandedMultiProjectId(null)
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
      const runtimeProject = runtimeProjectWorkById.get(project.id)
      const searchableText = [
        project.name,
        project.description ?? '',
        device?.name ?? '',
        device?.device_id ?? '',
        ...(runtimeProject?.project.roots?.map(root => root.path) ?? []),
        ...(runtimeProject?.deviceWorkspaces.map(workspace => workspace.workspacePath) ?? []),
      ]
        .join(' ')
        .toLowerCase()

      return searchableText.includes(normalizedProjectQuery)
    })
  }, [getDeviceForProject, normalizedProjectQuery, runtimeProjectWorkById, sortedProjects])
  const projectWorkTriggerLabel =
    emptyLabel ??
    selectorLabel ??
    (isMobile
      ? t('workbench.enter_project_work', '进入项目工作')
      : t('workbench.project_select_placeholder', '请选择项目'))
  const unboundWorkspaceLabel = t('workbench.project_workspace_unbound', '未绑定设备工作区')
  const pendingWorkspaceSelection =
    currentProject &&
    pendingProjectWorkspaceProjectId === currentProject.id &&
    !selectedDeviceWorkspace
  const selectedProjectLabel = currentProject?.name ?? projectWorkTriggerLabel
  const projectWorkTriggerAriaLabel = selectedProjectLabel

  const projectOpenRequested =
    Boolean(projectMenuOpenSignal) && handledOpenSignals.project !== projectMenuOpenSignal
  const externalOpenRequested =
    Boolean(externalMenuOpenSignal) && handledOpenSignals.external !== externalMenuOpenSignal
  if (projectOpenRequested || externalOpenRequested) {
    setHandledOpenSignals({
      project: projectOpenRequested ? projectMenuOpenSignal : handledOpenSignals.project,
      external: externalOpenRequested ? externalMenuOpenSignal : handledOpenSignals.external,
    })
    setExternalMenuAnchorElement(externalOpenRequested || isMobile ? null : projectMenuAnchorElement)
    setOpen(true)
  }

  useFocusRequest(searchInputRef, projectMenuOpenSignal ?? externalMenuOpenSignal, {
    enabled: open && !isMobile && Boolean(handledOpenSignals.project || handledOpenSignals.external),
  })

  const handleSelectProject = (projectId: number) => {
    const option = projectWorkspaceOptionByProjectId.get(projectId)
    if (hasRuntimeWork && option?.kind === 'multi') {
      const localMultiRoot = option.workspaces.every(workspace => {
        const workspaceDevice = devices.find(item => item.device_id === workspace.deviceId)
        return Boolean(workspaceDevice && isLocalProjectWorkspaceDevice(workspaceDevice))
      })
      if (localMultiRoot) {
        const workspace =
          (projectId === currentProjectId
            ? option.workspaces.find(item => item.id === selectedDeviceWorkspaceId)
            : null) ?? option.workspaces.find(item => isSelectableProjectWorkspace(item, devices))
        if (workspace) {
          onSelectProjectWorkspace?.(projectId, workspace.id ?? null, workspace)
        }
        closeMenu()
        return
      }
      setExpandedMultiProjectId(projectId)
      if (projectId !== currentProjectId) {
        onSelectProjectWorkspace?.(projectId, null)
      }
      return
    }
    if (hasRuntimeWork && option?.kind === 'single' && option.workspace?.id && option.selectable) {
      onSelectProjectWorkspace?.(projectId, option.workspace.id, option.workspace)
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

  const handleClearProject = () => {
    onSelectProject(null)
    closeMenu()
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
    setExternalMenuAnchorElement(null)
    setOpen(true)
  }

  const renderMobileSheetHeader = (title: string, subtitle: string, onClose: () => void) => (
    <>
      <div className="mx-auto mt-3 h-1 w-11 shrink-0 rounded-full bg-border" />
      <div className="flex shrink-0 items-center justify-between px-5 pb-3 pt-4">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-text-primary">{title}</h2>
          <p className="mt-1 truncate text-xs text-text-secondary">{subtitle}</p>
        </div>
        <ControlButton
          variant="unstyled"
          type="button"
          data-testid="project-work-mobile-close-button"
          aria-label={t('workbench.close_menu', '关闭菜单')}
          onClick={onClose}
          className="flex h-11 w-11 items-center justify-center rounded-full bg-surface text-text-primary"
        >
          <X className="h-5 w-5" />
        </ControlButton>
      </div>
    </>
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

  const renderTrigger = (button: ReactElement) =>
    isMobile ? button : <PopoverTrigger render={button} />
  const menuContent = (
    <>
      {isMobile &&
        renderMobileSheetHeader(
          selectorLabel ?? t('workbench.project_sheet_title', '选择项目'),
          selectedProjectLabel,
          closeMenu
        )}
      <div className={cn('flex min-h-0 flex-1 flex-col', isMobile && 'px-5 pb-5')}>
        <label
          className={cn(
            'relative mb-1.5 flex shrink-0 items-center',
            !isMobile && 'border-b border-border'
          )}
        >
          <Search
            className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-text-secondary"
            aria-hidden="true"
          />
          <span className="sr-only">{t('workbench.search_projects', '搜索项目')}</span>
          <ControlInput
            ref={searchInputRef}
            data-testid="project-search-input"
            type="search"
            value={projectQuery}
            onChange={event => setProjectQuery(event.target.value)}
            placeholder={menuLabels?.search ?? t('workbench.search_projects', '搜索项目')}
            appearance={isMobile ? 'outline' : 'plain'}
            className="w-full pl-9"
          />
        </label>
        {availableProjects.length === 0 ? (
          <div data-testid="project-empty-state" className="px-4 py-3 text-sm leading-[18px]">
            <div className="text-text-secondary">
              {menuLabels?.empty ?? t('workbench.no_projects', '暂无项目')}
            </div>
            <div className="mt-1 text-xs leading-4 text-text-secondary">
              {menuLabels?.emptyHint ??
                t('workbench.no_projects_action', '请添加本地项目或远程项目后重试。')}
            </div>
          </div>
        ) : filteredProjects.length === 0 ? (
          <div
            data-testid="project-search-empty"
            className="px-4 py-3 text-sm leading-[18px] text-text-secondary"
          >
            {menuLabels?.noResults ?? t('workbench.project_search_no_results', '没有匹配的项目')}
          </div>
        ) : (
          <div
            data-testid="project-options-list"
            className={cn(
              'min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1',
              isMobile && 'scrollbar-none max-h-[calc(45dvh-168px)] space-y-2 py-2'
            )}
            style={{
              maxHeight: isMobile ? undefined : PROJECT_MENU_LIST_MAX_HEIGHT,
            }}
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
              const localMultiRootWorkspace =
                option?.kind === 'multi' &&
                option.workspaces.every(workspace => {
                  const workspaceDevice = devices.find(
                    item => item.device_id === workspace.deviceId
                  )
                  return Boolean(workspaceDevice && isLocalProjectWorkspaceDevice(workspaceDevice))
                })
                  ? ((project.id === currentProjectId
                      ? option.workspaces.find(
                          workspace => workspace.id === selectedDeviceWorkspaceId
                        )
                      : null) ?? option.workspaces[0])
                  : null
              const selected = project.id === currentProjectId
              const expanded =
                option?.kind === 'multi' &&
                !localMultiRootWorkspace &&
                (expandedMultiProjectId === project.id ||
                  pendingProjectWorkspaceProjectId === project.id)
              const bindRequired =
                hasRuntimeWork && option?.kind === 'empty' && Boolean(onBindProjectWorkspace)
              const runtimeProject = runtimeProjectWorkById.get(project.id)?.project
              const workspacePath =
                summaryWorkspace?.workspacePath?.trim() ||
                runtimeProject?.roots?.find(root => root.path.trim())?.path.trim() ||
                null
              const projectDescription = project.description?.trim() || null
              const projectDetail =
                (workspacePath && workspacePathSummary(workspacePath)) ||
                projectDescription ||
                unboundWorkspaceLabel
              return (
                <div key={project.id} className="space-y-0.5">
                  <ControlButton
                    variant="ghost"
                    size="sm"
                    type="button"
                    data-testid={`project-option-${project.id}`}
                    onClick={() => handleSelectProject(project.id)}
                    className="flex min-h-14 w-full rounded-lg px-4 py-2 text-left text-text-primary hover:bg-muted"
                  >
                    <div className="flex min-w-0 w-full items-center gap-3">
                      <ProjectFolderIcon
                        project={project}
                        testId={`project-available-icon-${project.id}`}
                        className="h-4 w-4 shrink-0 text-text-secondary"
                      />
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate text-sm font-normal leading-[18px] text-text-primary">
                          {project.name}
                        </span>
                        <span className="flex min-w-0 items-center gap-1.5 text-xs leading-4 text-text-secondary">
                          <span
                            data-testid={`project-option-detail-${project.id}`}
                            className="min-w-0 flex-1 truncate"
                            title={workspacePath ?? projectDetail}
                          >
                            {projectDetail}
                          </span>
                          {bindRequired && (workspacePath || projectDescription) && (
                            <span className="shrink-0">{unboundWorkspaceLabel}</span>
                          )}
                          {!bindRequired && deviceLabel && (
                            <span className="flex min-w-0 items-center gap-1">
                              <DeviceIcon className="h-3.5 w-3.5 shrink-0" />
                              <span
                                className={`h-1.5 w-1.5 shrink-0 rounded-full ${getWorkspaceStatusDotClass(deviceStatus)}`}
                              />
                              <span className="min-w-0 max-w-16 truncate text-text-secondary">
                                {deviceLabel}
                              </span>
                              <span className="shrink-0">
                                {getCompactWorkspaceStatusLabel(deviceStatus, versionCompatible)}
                              </span>
                            </span>
                          )}
                        </span>
                      </div>
                      {selected && (
                        <Check
                          data-testid={`project-selected-icon-${project.id}`}
                          className="h-3.5 w-3.5 shrink-0 text-text-primary"
                        />
                      )}
                    </div>
                  </ControlButton>
                  {bindRequired && (
                    <ControlButton
                      variant="ghost"
                      size="sm"
                      type="button"
                      data-testid={`project-bind-workspace-${project.id}`}
                      onClick={() => {
                        onBindProjectWorkspace?.(project.id)
                        closeMenu()
                      }}
                      className={cn(
                        'ml-7 flex h-9 max-md:min-h-11 w-[calc(100%-1.75rem)] items-center gap-2 rounded-lg px-3 text-left text-sm font-medium leading-[18px] text-text-secondary hover:bg-muted',
                        isMobile && 'h-11'
                      )}
                    >
                      <FolderPlus className="h-3.5 w-3.5 shrink-0" />
                      <span>{t('workbench.bind_project_workspace', '绑定设备工作区')}</span>
                    </ControlButton>
                  )}
                  {expanded &&
                    option?.workspaces.map((workspace, workspaceIndex) => {
                      const workspaceSelected =
                        selectedDeviceWorkspaceId != null &&
                        workspace.id === selectedDeviceWorkspaceId
                      const selectable = isSelectableProjectWorkspace(workspace, devices)
                      const workspaceDevice = devices.find(
                        item => item.device_id === workspace.deviceId
                      )
                      const WorkspaceDeviceIcon =
                        workspaceDevice && isCloudDevice(workspaceDevice) ? Cloud : HardDrive
                      const localWorkspace = Boolean(
                        workspaceDevice && isLocalProjectWorkspaceDevice(workspaceDevice)
                      )
                      return (
                        <ControlButton
                          variant="ghost"
                          size="sm"
                          key={`${workspace.deviceId}:${workspace.workspacePath}`}
                          type="button"
                          data-testid={`project-workspace-option-${workspace.id ?? `${workspace.deviceId}-${workspaceIndex}`}`}
                          disabled={!selectable}
                          onClick={() => handleSelectDeviceWorkspace(project.id, workspace)}
                          className={cn(
                            'ml-7 flex h-9 max-md:min-h-11 w-[calc(100%-1.75rem)] items-center gap-2 rounded-lg px-3 text-left text-sm leading-[18px]',
                            selectable
                              ? 'text-text-secondary hover:bg-muted'
                              : 'cursor-not-allowed text-text-muted opacity-60',
                            workspaceSelected && 'bg-muted text-text-primary'
                          )}
                        >
                          {localWorkspace ? (
                            <Folder className="h-4 w-4 shrink-0" />
                          ) : (
                            <WorkspaceDeviceIcon className="h-3.5 w-3.5 shrink-0" />
                          )}
                          {!localWorkspace && (
                            <span
                              className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                workspace.deviceStatus === 'online'
                                  ? 'bg-primary'
                                  : workspace.deviceStatus === 'busy'
                                    ? 'bg-amber-500'
                                    : 'bg-text-muted'
                              }`}
                            />
                          )}
                          <span className="min-w-0 flex-1 truncate" title={workspace.workspacePath}>
                            {localWorkspace
                              ? workspaceFolderName(workspace.workspacePath)
                              : workspace.deviceName?.trim() ||
                                t('workbench.environment_device_unknown', '未知设备')}
                          </span>
                          {!localWorkspace && (
                            <span className="min-w-0 max-w-[7rem] truncate text-xs text-text-secondary">
                              {workspace.workspacePath}
                            </span>
                          )}
                          {workspaceSelected && <Check className="h-3.5 w-3.5 shrink-0" />}
                        </ControlButton>
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
            <div>
              <ControlButton
                variant="ghost"
                size="sm"
                type="button"
                data-testid="add-local-project-option"
                onClick={() => handleCreateProject('existing')}
                className="flex h-8 max-md:min-h-11 w-full items-center gap-3 rounded-lg px-4 text-left text-sm font-medium leading-[18px] text-text-secondary hover:bg-muted"
              >
                <FolderPlus className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  {menuLabels?.addLocal ?? t('workbench.add_local_project', '添加本地项目')}
                </span>
              </ControlButton>
            </div>
          )}
          {renderCreateSection?.(closeMenu)}
          {showClearButton ? (
            <div>
              <ControlButton
                variant="ghost"
                size="sm"
                type="button"
                data-testid="no-project-option"
                onClick={handleClearProject}
                className="flex h-8 max-md:min-h-11 w-full items-center gap-3 rounded-lg px-4 text-left text-sm font-medium leading-[18px] text-text-secondary hover:bg-muted"
              >
                <FolderX className="h-4 w-4 shrink-0" />
                <span className="min-w-0 flex-1">
                  {menuLabels?.clear ?? t('workbench.no_project', '不使用项目')}
                </span>
              </ControlButton>
            </div>
          ) : null}
        </div>
      </div>
    </>
  )

  return (
    <Popover
      open={open && !isMobile}
      onOpenChange={next => {
        if (next) {
          setExternalMenuAnchorElement(null)
          setOpen(true)
        } else closeMenu()
      }}
    >
      <div
        data-testid="project-work-bar"
        className={cn(
          'project-work-bar flex min-h-[56px] w-full min-w-0 flex-wrap items-center gap-2 px-6',
          className
        )}
      >
        {showProjectSelector ? (
          <div
            ref={setContainerElement}
            className={cn('relative min-w-0 max-w-full', !isMobile && 'max-w-[18rem] shrink')}
          >
            {isMobile ? (
              open && (
                <DialogSurface
                  inline={false}
                  onClose={closeMenu}
                  initialFocus={() => menuRef.current}
                  finalFocus={() => externalMenuAnchorElement ?? triggerElement}
                  render={
                    <div
                      {...portalTheme}
                      aria-label={selectorLabel ?? t('workbench.project_sheet_title', '选择项目')}
                      data-testid="project-work-mobile-sheet"
                      className={cn(
                        portalTheme.className,
                        'fixed inset-0 m-0 flex h-full max-h-none items-end bg-black/25'
                      )}
                      onClick={event => {
                        if (event.target === event.currentTarget) closeMenu()
                      }}
                    />
                  }
                >
                  <div
                    ref={menuRef}
                    tabIndex={-1}
                    data-testid="project-work-menu"
                    data-mobile="true"
                    className="flex max-h-[45dvh] w-full flex-col rounded-t-xl border border-border bg-popover text-text-primary shadow-lg outline-none"
                  >
                    {menuContent}
                  </div>
                </DialogSurface>
              )
            ) : (
              <PopoverContent
                ref={menuRef}
                data-testid="project-work-menu"
                aria-label={selectorLabel ?? t('workbench.project_sheet_title', '选择项目')}
                anchor={externalMenuAnchorElement ?? containerElement}
                align={externalMenuAnchorElement ? 'center' : 'start'}
                side="top"
                sideOffset={8}
                collisionPadding={16}
                initialFocus={() => searchInputRef.current}
                finalFocus={() => externalMenuAnchorElement ?? triggerElement}
                className={cn('flex w-80 flex-col overflow-hidden p-1.5', menuClassName)}
                style={{
                  maxHeight: `min(${PROJECT_MENU_MAX_HEIGHT}px, var(--available-height))`,
                }}
              >
                {menuContent}
              </PopoverContent>
            )}
            {isMobile ? (
              renderTrigger(
                <ControlButton
                  variant="unstyled"
                  ref={setTriggerElement}
                  type="button"
                  data-testid="project-work-button"
                  onClick={isMobile ? handleToggleMenu : undefined}
                  className={cn(
                    'flex h-11 min-w-[44px] items-center gap-2 rounded-full px-2 text-base font-medium leading-5 text-text-secondary transition-[background-color,color,box-shadow] hover:bg-background/70 hover:text-text-primary hover:shadow-[0_8px_22px_rgba(0,0,0,0.10)] focus-visible:outline-none keyboard:focus-visible:ring-2 keyboard:focus-visible:ring-[color-mix(in_srgb,rgb(var(--color-focus-ring))_80%,rgb(var(--color-text-primary))_20%)]',
                    open &&
                      'bg-background/70 text-text-primary shadow-[0_8px_22px_rgba(0,0,0,0.10)]',
                    buttonClassName
                  )}
                  aria-expanded={open}
                  aria-label={projectWorkTriggerAriaLabel}
                >
                  {currentProject ? (
                    <>
                      <ProjectFolderIcon project={currentProject} className="h-4 w-4" />
                      <span className="max-w-[12rem] truncate">{selectedProjectLabel}</span>
                    </>
                  ) : (
                    <>
                      <FolderPlus className="h-5 w-5" />
                      <span className="min-w-0 truncate">{projectWorkTriggerLabel}</span>
                    </>
                  )}
                  <ChevronDown className="h-4 w-4" />
                </ControlButton>
              )
            ) : currentProject ? (
              <div className="flex h-11 w-full min-w-0 items-center rounded-full md:h-7">
                {showClearButton ? (
                  <ComposerContextButton
                    data-testid="clear-project-button"
                    onClick={handleClearProject}
                    title={menuLabels?.clear ?? t('workbench.no_project', '不使用项目')}
                    aria-label={menuLabels?.clear ?? t('workbench.no_project', '不使用项目')}
                    className="group w-11 shrink-0 justify-center px-0 md:w-7"
                  >
                    <ProjectFolderIcon
                      project={currentProject}
                      className="h-4 w-4 group-hover:hidden group-focus-visible:hidden"
                    />
                    <X className="hidden h-4 w-4 group-hover:block group-focus-visible:block" />
                  </ComposerContextButton>
                ) : (
                  <span className="flex h-11 w-11 shrink-0 items-center justify-center text-text-secondary md:h-7 md:w-7">
                    <ProjectFolderIcon project={currentProject} className="h-4 w-4" />
                  </span>
                )}
                {renderTrigger(
                  <ComposerContextButton
                    ref={setTriggerElement}
                    type="button"
                    data-testid="project-work-button"
                    onClick={isMobile ? handleToggleMenu : undefined}
                    title={t('workbench.change_project', '更改项目')}
                    className="w-full px-1.5"
                    aria-expanded={open}
                    aria-label={projectWorkTriggerAriaLabel}
                  >
                    <span className="min-w-0 truncate">{selectedProjectLabel}</span>
                    {pendingWorkspaceSelection ? (
                      <>
                        <span className="text-text-muted">·</span>
                        <span className="shrink-0 text-text-secondary">
                          {t('workbench.select_workspace', '选择工作区')}
                        </span>
                      </>
                    ) : null}
                    <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
                  </ComposerContextButton>
                )}
              </div>
            ) : (
              renderTrigger(
                <ComposerContextButton
                  ref={setTriggerElement}
                  data-testid="project-work-button"
                  className="w-full"
                  aria-expanded={open}
                  aria-label={projectWorkTriggerAriaLabel}
                >
                  <FolderPlus className="h-4 w-4 shrink-0" aria-hidden="true" />
                  <span className="min-w-0 truncate">{projectWorkTriggerLabel}</span>
                  <ChevronDown className="h-4 w-4 shrink-0" aria-hidden="true" />
                </ComposerContextButton>
              )
            )}
          </div>
        ) : null}
        {middleContext}
        {trailingContext}
        {renderWorkSection?.(currentProject)}
        {endContext}
        {selectedWorkspaceIsRemote && selectedWorkspaceDeviceIp && (
          <div
            data-testid="project-work-remote-status"
            className="ml-auto flex min-w-0 items-center gap-2 text-sm font-medium leading-[18px] text-text-primary"
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
    </Popover>
  )
}
