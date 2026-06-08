import {
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Folder,
  FolderGit2,
  FolderPlus,
  FolderX,
  HardDrive,
  Plus,
  Search,
} from 'lucide-react'
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { ProjectFolderIcon } from '@/components/projects/ProjectFolderIcon'
import { useTranslation } from '@/hooks/useTranslation'
import {
  getPreferredStandaloneDeviceId,
  isCloudDevice,
  isOnlineDevice,
  sortStandaloneDevices,
} from '@/lib/device-selection'
import { cn } from '@/lib/utils'
import type { DeviceInfo, ProjectWithTasks } from '@/types/api'
import type { ProjectCreateMode } from '../ChatInput'
import { useOutsideClick } from './useOutsideClick'

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
const CREATE_PROJECT_SUBMENU_HEIGHT = 128
const STANDALONE_DEVICE_SUBMENU_MAX_HEIGHT = 280
const CLIPPING_OVERFLOW_RE = /(auto|hidden|scroll|clip)/

function getMenuVisibleBounds(element: HTMLElement | null) {
  let top = PROJECT_MENU_VIEWPORT_MARGIN
  let bottom = window.innerHeight - PROJECT_MENU_VIEWPORT_MARGIN
  let current = element?.parentElement ?? null

  while (current && current !== document.body) {
    const style = window.getComputedStyle(current)
    const clipsVertically =
      CLIPPING_OVERFLOW_RE.test(style.overflowY) ||
      CLIPPING_OVERFLOW_RE.test(style.overflow)

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
  const actionCount = hasCreateProjectOption ? 2 : 1
  const actionHeight = getStackHeight(
    actionCount,
    PROJECT_MENU_ACTION_HEIGHT,
    PROJECT_MENU_ACTION_GAP,
  )

  return (
    PROJECT_MENU_VERTICAL_PADDING +
    PROJECT_MENU_SEARCH_BLOCK_HEIGHT +
    projectListHeight +
    PROJECT_MENU_DIVIDER_BLOCK_HEIGHT +
    actionHeight
  )
}

interface ProjectWorkBarProps {
  projects: ProjectWithTasks[]
  devices: DeviceInfo[]
  currentProjectId?: number
  currentStandaloneDeviceId?: string | null
  onSelectProject: (projectId: number | null) => void
  onSelectStandaloneDevice: (deviceId: string | null) => void
  onCreateProjectMode?: (mode: ProjectCreateMode) => void
  className?: string
  buttonClassName?: string
  menuClassName?: string
  emptyLabel?: string
}

export function ProjectWorkBar({
  projects,
  devices,
  currentProjectId,
  currentStandaloneDeviceId,
  onSelectProject,
  onSelectStandaloneDevice,
  onCreateProjectMode,
  className,
  buttonClassName,
  menuClassName,
  emptyLabel,
}: ProjectWorkBarProps) {
  const { t } = useTranslation('common')
  const containerRef = useRef<HTMLDivElement>(null)
  const triggerButtonRef = useRef<HTMLButtonElement>(null)
  const createOptionButtonRef = useRef<HTMLButtonElement>(null)
  const standaloneOptionButtonRef = useRef<HTMLButtonElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [activeSubmenu, setActiveSubmenu] = useState<'create' | 'standalone' | null>(null)
  const [projectQuery, setProjectQuery] = useState('')
  const [menuLayout, setMenuLayout] = useState<{
    placement: 'below' | 'above'
    maxHeight: number
  }>({ placement: 'below', maxHeight: PROJECT_MENU_MAX_HEIGHT })
  const [sideSubmenuPlacement, setSideSubmenuPlacement] = useState<
    Record<'create' | 'standalone', 'below' | 'above'>
  >({
    create: 'below',
    standalone: 'below',
  })
  const closeMenu = useCallback(() => {
    setOpen(false)
    setActiveSubmenu(null)
    setProjectQuery('')
  }, [])

  useOutsideClick(containerRef, open, closeMenu)
  const standaloneDevices = useMemo(() => sortStandaloneDevices(devices), [devices])

  const updateMenuLayout = useCallback(() => {
    if (!open || typeof window === 'undefined') return

    const triggerRect = triggerButtonRef.current?.getBoundingClientRect()
    if (!triggerRect) return

    const visibleBounds = getMenuVisibleBounds(containerRef.current)
    const spaceBelow = visibleBounds.bottom - triggerRect.bottom
    const spaceAbove = triggerRect.top - visibleBounds.top
    const targetHeight = getProjectMenuFitHeight(projects.length, Boolean(onCreateProjectMode))
    const placement =
      spaceBelow >= targetHeight || spaceBelow >= spaceAbove
        ? 'below'
        : 'above'
    const availableSpace = Math.max(placement === 'below' ? spaceBelow : spaceAbove, 0)
    const maxHeight = Math.min(PROJECT_MENU_MAX_HEIGHT, availableSpace)

    setMenuLayout(current => {
      if (current.placement === placement && current.maxHeight === maxHeight) {
        return current
      }
      return { placement, maxHeight }
    })
  }, [onCreateProjectMode, open, projects.length])

  const updateSideSubmenuPlacement = useCallback(
    (submenu: 'create' | 'standalone') => {
      if (typeof window === 'undefined') return

      const trigger =
        submenu === 'create'
          ? createOptionButtonRef.current
          : standaloneOptionButtonRef.current
      if (!trigger) return

      const triggerRect = trigger.getBoundingClientRect()
      const submenuHeight =
        submenu === 'create'
          ? CREATE_PROJECT_SUBMENU_HEIGHT
          : Math.min(
              Math.max(standaloneDevices.length, 1) * 40 + 16,
              STANDALONE_DEVICE_SUBMENU_MAX_HEIGHT,
            )
      const visibleBounds = getMenuVisibleBounds(containerRef.current)
      const spaceBelow = visibleBounds.bottom - triggerRect.top
      const placement = spaceBelow >= submenuHeight ? 'below' : 'above'

      setSideSubmenuPlacement(current => {
        if (current[submenu] === placement) return current
        return { ...current, [submenu]: placement }
      })
    },
    [standaloneDevices.length],
  )

  useLayoutEffect(() => {
    updateMenuLayout()
  }, [updateMenuLayout])

  useEffect(() => {
    if (!open) return

    const handleResize = () => {
      updateMenuLayout()
      if (activeSubmenu) {
        updateSideSubmenuPlacement(activeSubmenu)
      }
    }

    window.addEventListener('resize', handleResize)
    return () => window.removeEventListener('resize', handleResize)
  }, [activeSubmenu, open, updateMenuLayout, updateSideSubmenuPlacement])

  useLayoutEffect(() => {
    if (!activeSubmenu) return

    updateSideSubmenuPlacement(activeSubmenu)
  }, [activeSubmenu, updateSideSubmenuPlacement])

  useEffect(() => {
    if (!open) return

    searchInputRef.current?.focus()
  }, [open])

  const currentProject = useMemo(
    () => projects.find(p => p.id === currentProjectId),
    [projects, currentProjectId]
  )

  const getDeviceForProject = useCallback((project: ProjectWithTasks): DeviceInfo | undefined => {
    const deviceId = project.config?.execution?.deviceId
    if (!deviceId) return undefined
    return devices.find(d => d.device_id === deviceId)
  }, [devices])

  const sortedProjects = useMemo(() => {
    return [...projects].sort((a, b) => {
      const deviceA = getDeviceForProject(a)
      const deviceB = getDeviceForProject(b)
      const onlineA = deviceA?.status === 'online' ? 1 : 0
      const onlineB = deviceB?.status === 'online' ? 1 : 0
      return onlineB - onlineA
    })
  }, [projects, getDeviceForProject])
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
  const isStandaloneMode = currentProjectId == null
  const defaultStandaloneDeviceId = useMemo(
    () => getPreferredStandaloneDeviceId(devices, currentStandaloneDeviceId),
    [currentStandaloneDeviceId, devices]
  )
  const selectedStandaloneDeviceId = defaultStandaloneDeviceId

  const handleSelectProject = (projectId: number) => {
    onSelectProject(projectId)
    closeMenu()
  }

  const handleSelectStandaloneDevice = (deviceId: string) => {
    onSelectStandaloneDevice(deviceId)
    closeMenu()
  }

  const handleCreateProjectMode = (mode: ProjectCreateMode) => {
    onCreateProjectMode?.(mode)
    closeMenu()
  }

  const handleActivateSubmenu = (submenu: 'create' | 'standalone') => {
    updateSideSubmenuPlacement(submenu)
    setActiveSubmenu(submenu)
  }

  const handleToggleMenu = () => {
    if (open) {
      closeMenu()
      return
    }
    setActiveSubmenu(null)
    setOpen(true)
  }

  const getCompactDeviceStatusLabel = (device: DeviceInfo) => {
    if (device.status === 'online') {
      return t('workbench.project_device_status_online', '在线')
    }
    if (device.status === 'busy') {
      return t('workbench.project_device_status_busy', '忙碌')
    }
    return t('workbench.project_device_status_offline', '离线')
  }

  const getDeviceStatusDotClass = (device: DeviceInfo) => {
    if (device.status === 'online') return 'bg-primary'
    if (device.status === 'busy') return 'bg-amber-500'
    return 'bg-text-muted'
  }

  return (
    <div className={cn('flex min-h-[56px] items-center px-6', className)}>
      <div ref={containerRef} className="relative">
        {open && (
          <div
            data-testid="project-work-menu"
            className={cn(
              'absolute left-0 z-popover flex w-80 flex-col rounded-2xl border border-border bg-background p-1.5 shadow-[0_16px_44px_rgba(0,0,0,0.16)]',
              menuLayout.placement === 'below' ? 'top-11' : 'bottom-11',
              menuClassName,
            )}
            style={{ maxHeight: menuLayout.maxHeight }}
          >
            <label className="mb-1.5 flex h-9 shrink-0 items-center gap-2 rounded-xl border border-border bg-surface px-3 text-text-secondary">
              <Search className="h-4 w-4 shrink-0" />
              <input
                ref={searchInputRef}
                data-testid="project-search-input"
                type="search"
                value={projectQuery}
                onChange={event => setProjectQuery(event.target.value)}
                onFocus={() => setActiveSubmenu(null)}
                placeholder={t('workbench.search_projects', '搜索项目')}
                className="min-w-0 flex-1 bg-transparent text-[13px] leading-[18px] text-text-primary outline-none placeholder:text-text-muted"
              />
            </label>
            {projects.length === 0 ? (
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
                className="min-h-0 flex-1 space-y-0.5 overflow-y-auto pr-1"
                style={{ maxHeight: PROJECT_MENU_LIST_MAX_HEIGHT }}
              >
                {filteredProjects.map(project => {
                  const device = getDeviceForProject(project)
                  const DeviceIcon = device && isCloudDevice(device) ? Cloud : HardDrive
                  const isUnavailable = Boolean(device && device.status !== 'online')
                  const selected = project.id === currentProjectId
                  const projectTextClass = isUnavailable
                    ? 'text-text-muted'
                    : selected
                      ? 'text-text-primary'
                      : 'text-text-secondary'
                  return (
                    <button
                      key={project.id}
                      type="button"
                      data-testid={`project-option-${project.id}`}
                      disabled={isUnavailable}
                      aria-disabled={isUnavailable}
                      onClick={() => {
                        if (!isUnavailable) handleSelectProject(project.id)
                      }}
                      className={`flex h-9 w-full rounded-lg px-4 text-left hover:bg-muted disabled:cursor-not-allowed disabled:hover:bg-transparent ${projectTextClass}`}
                    >
                      <div className="flex min-h-0 w-full items-center gap-3">
                        <ProjectFolderIcon
                          project={project}
                          testId={
                            isUnavailable
                              ? `project-unavailable-icon-${project.id}`
                              : `project-available-icon-${project.id}`
                          }
                          className={`h-4 w-4 shrink-0 ${
                            isUnavailable ? 'text-text-muted' : 'text-text-secondary'
                          }`}
                        />
                        <div className="flex min-w-0 flex-1 items-center gap-2">
                          <span
                            className={cn(
                              'min-w-0 truncate text-[13px] font-semibold leading-[18px]',
                              device ? 'max-w-[9rem] shrink' : 'flex-1',
                              isUnavailable ? 'text-text-muted' : 'text-text-primary',
                            )}
                          >
                            {project.name}
                          </span>
                          {device && (
                            <span
                              className={`flex min-w-0 flex-1 items-center gap-1.5 text-xs leading-4 ${
                                device.status === 'online' ? 'text-text-secondary' : 'text-text-muted'
                              }`}
                            >
                              <DeviceIcon className="h-3.5 w-3.5 shrink-0" />
                              <span
                                className={`h-1.5 w-1.5 shrink-0 rounded-full ${getDeviceStatusDotClass(device)}`}
                              />
                              <span
                                className={`min-w-0 truncate ${
                                  device.status === 'online'
                                    ? 'text-text-secondary'
                                    : 'text-text-muted'
                                }`}
                              >
                                {device.name}
                              </span>
                              <span className="shrink-0">{getCompactDeviceStatusLabel(device)}</span>
                            </span>
                          )}
                        </div>
                        {selected && (
                          <Check
                            data-testid={`project-selected-icon-${project.id}`}
                            className={`h-3.5 w-3.5 shrink-0 ${
                              isUnavailable ? 'text-text-muted' : 'text-text-primary'
                            }`}
                          />
                        )}
                      </div>
                    </button>
                  )
                })}
              </div>
            )}
            <div className="my-1.5 shrink-0 border-t border-border" />
            <div className="shrink-0 space-y-0.5">
              {onCreateProjectMode && (
                <div
                  className="relative"
                  onMouseEnter={() => handleActivateSubmenu('create')}
                  onFocus={() => handleActivateSubmenu('create')}
                >
                  <button
                    ref={createOptionButtonRef}
                    type="button"
                    data-testid="add-project-option"
                    onClick={() => handleActivateSubmenu('create')}
                    className={cn(
                      'flex h-8 w-full items-center gap-3 rounded-lg px-4 text-left text-[13px] font-medium leading-[18px] text-text-secondary hover:bg-muted',
                      activeSubmenu === 'create' && 'bg-muted text-text-primary',
                    )}
                  >
                    <FolderPlus className="h-4 w-4 shrink-0" />
                    <span className="min-w-0 flex-1">{t('workbench.add_new_project', '添加新项目')}</span>
                    <ChevronRight className="h-4 w-4 shrink-0" />
                  </button>
                  {activeSubmenu === 'create' && (
                    <div
                      className={cn(
                        'absolute left-full z-popover pl-2',
                        sideSubmenuPlacement.create === 'below' ? 'top-0' : 'bottom-0',
                      )}
                    >
                      <div
                        data-testid="create-project-submenu"
                        className="w-56 rounded-2xl border border-border bg-background p-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
                      >
                        <button
                          type="button"
                          data-testid="project-start-from-scratch-option"
                          onClick={() => handleCreateProjectMode('scratch')}
                          className="flex min-h-9 w-full items-center gap-3 rounded-xl px-4 py-2 text-left text-[13px] font-medium leading-[18px] text-text-secondary hover:bg-muted"
                        >
                          <Plus className="h-4 w-4 shrink-0" />
                          <span>{t('workbench.start_from_scratch', '新建空白项目')}</span>
                        </button>
                        <button
                          type="button"
                          data-testid="project-existing-folder-option"
                          onClick={() => handleCreateProjectMode('existing')}
                          className="flex min-h-9 w-full items-center gap-3 rounded-xl px-4 py-2 text-left text-[13px] font-medium leading-[18px] text-text-secondary hover:bg-muted"
                        >
                          <Folder className="h-4 w-4 shrink-0" />
                          <span>{t('workbench.using_existing_folder', '使用现有目录')}</span>
                        </button>
                        <button
                          type="button"
                          data-testid="project-clone-from-git-option"
                          onClick={() => handleCreateProjectMode('git')}
                          className="flex min-h-9 w-full items-center gap-3 rounded-xl px-4 py-2 text-left text-[13px] font-medium leading-[18px] text-text-secondary hover:bg-muted"
                        >
                          <FolderGit2 className="h-4 w-4 shrink-0" />
                          <span>{t('workbench.clone_from_git', '从 Git 克隆')}</span>
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              )}
              <div
                className="relative"
                onMouseEnter={() => handleActivateSubmenu('standalone')}
                onFocus={() => handleActivateSubmenu('standalone')}
              >
                <button
                  ref={standaloneOptionButtonRef}
                  type="button"
                  data-testid="no-project-option"
                  onClick={() => handleActivateSubmenu('standalone')}
                  className={cn(
                    'flex h-8 w-full items-center gap-3 rounded-lg px-4 text-left text-[13px] font-medium leading-[18px] text-text-secondary hover:bg-muted',
                    activeSubmenu === 'standalone' && 'bg-muted text-text-primary',
                  )}
                >
                  <FolderX className="h-4 w-4 shrink-0" />
                  <span className="min-w-0 flex-1">{t('workbench.no_project', '不使用项目')}</span>
                  <ChevronRight className="h-4 w-4 shrink-0" />
                </button>
                {activeSubmenu === 'standalone' && (
                  <div
                    className={cn(
                      'absolute left-full z-popover pl-2',
                      sideSubmenuPlacement.standalone === 'below' ? 'top-0' : 'bottom-0',
                    )}
                  >
                    <div
                      data-testid="standalone-device-submenu"
                      className="w-72 rounded-2xl border border-border bg-background p-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
                    >
                      {standaloneDevices.length === 0 ? (
                        <div className="px-4 py-2 text-xs text-text-muted">
                          {t('workbench.project_no_available_devices', '暂无可用设备')}
                        </div>
                      ) : (
                        standaloneDevices.map(device => {
                          const online = isOnlineDevice(device)
                          const selected = isStandaloneMode && device.device_id === selectedStandaloneDeviceId
                          const DeviceIcon = isCloudDevice(device) ? Cloud : HardDrive
                          return (
                            <button
                              key={device.device_id}
                              type="button"
                              data-testid={`standalone-device-option-${device.device_id}`}
                              disabled={!online}
                              onClick={() => handleSelectStandaloneDevice(device.device_id)}
                              className={[
                                'flex min-h-10 w-full items-center gap-2 rounded-xl px-3 py-2 text-left text-xs',
                                online
                                  ? 'text-text-secondary hover:bg-muted'
                                  : 'cursor-not-allowed text-text-muted opacity-60',
                                selected ? 'bg-muted text-text-primary' : '',
                              ].join(' ')}
                            >
                              <DeviceIcon className="h-3.5 w-3.5 shrink-0" />
                              <span
                                className={`h-1.5 w-1.5 shrink-0 rounded-full ${getDeviceStatusDotClass(device)}`}
                              />
                              <span className="min-w-0 flex-1 truncate">
                                {device.name || device.device_id}
                              </span>
                              <span className={online ? 'text-text-secondary' : 'text-text-muted'}>
                                {getCompactDeviceStatusLabel(device)}
                              </span>
                              {selected && online && (
                                <Check
                                  data-testid={`standalone-device-selected-icon-${device.device_id}`}
                                  className="h-3.5 w-3.5 shrink-0"
                                />
                              )}
                            </button>
                          )
                        })
                      )}
                    </div>
                  </div>
                )}
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
            'flex h-9 min-w-[44px] items-center gap-2 rounded-full px-1 text-[13px] font-medium leading-[18px] text-text-secondary hover:bg-muted',
            buttonClassName,
          )}
          aria-expanded={open}
          aria-label={t('workbench.enter_project_work', '进入项目工作')}
        >
          {currentProject ? (
            <>
              <ProjectFolderIcon project={currentProject} className="h-4 w-4" />
              <span>{currentProject.name}</span>
            </>
          ) : (
            <>
              <FolderPlus className="h-5 w-5" />
              <span>{emptyLabel ?? t('workbench.enter_project_work', '进入项目工作')}</span>
            </>
          )}
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
