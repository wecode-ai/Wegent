import { Check, ChevronDown, Cloud, FolderX, HardDrive, Search, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  getProjectDeviceId,
  getProjectMenuDeviceLabel,
} from '@/components/chat/composer/project-work-bar-utils'
import { useOutsideClick } from '@/components/chat/composer/useOutsideClick'
import { ProjectFolderIcon } from '@/components/projects/ProjectFolderIcon'
import { useTranslation } from '@/hooks/useTranslation'
import { isCloudDevice } from '@/lib/device-selection'
import { cn } from '@/lib/utils'
import type {
  DeviceInfo,
  ProjectWithTasks,
  RuntimeDeviceWorkspace,
  RuntimeWorkListResponse,
} from '@/types/api'

interface ExecutionProjectPickerProps {
  projects: ProjectWithTasks[]
  devices: DeviceInfo[]
  runtimeWork?: RuntimeWorkListResponse | null
  // Explicit user override; '' means falling back to the default project.
  selectedProjectId: number | ''
  // Default execution project: the repository bound to the assigned robot.
  defaultProject?: ProjectWithTasks | null
  // The code project bound to the board task's runtime task, shown as a hint.
  taskPageProject?: ProjectWithTasks | null
  onSelectProject: (projectId: number | '') => void
}

// Execution repository picker for the board task comment composer. Mirrors the
// homepage ProjectWorkBar interaction (searchable menu, device status,
// hover-to-clear) but drives the per-comment execution project instead of the
// workbench pane project.
export function ExecutionProjectPicker({
  projects,
  devices,
  runtimeWork = null,
  selectedProjectId,
  defaultProject = null,
  taskPageProject = null,
  onSelectProject,
}: ExecutionProjectPickerProps) {
  const { t } = useTranslation('common')
  const containerRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')

  const closeMenu = useCallback(() => {
    setOpen(false)
    setQuery('')
  }, [])
  useOutsideClick(containerRef, open, closeMenu)

  useEffect(() => {
    if (open) searchInputRef.current?.focus()
  }, [open])

  const effectiveProject =
    selectedProjectId !== ''
      ? (projects.find(project => project.id === selectedProjectId) ?? null)
      : defaultProject

  const firstWorkspaceByProjectId = useMemo(() => {
    const map = new Map<number, RuntimeDeviceWorkspace>()
    for (const projectWork of runtimeWork?.projects ?? []) {
      for (const workspace of projectWork.deviceWorkspaces) {
        if (workspace.projectId != null && !map.has(workspace.projectId)) {
          map.set(workspace.projectId, workspace)
        }
      }
    }
    return map
  }, [runtimeWork?.projects])

  const getDeviceForProject = useCallback(
    (project: ProjectWithTasks): DeviceInfo | undefined => {
      const deviceId =
        getProjectDeviceId(project) ?? firstWorkspaceByProjectId.get(project.id)?.deviceId
      if (!deviceId) return undefined
      return devices.find(device => device.device_id === deviceId)
    },
    [devices, firstWorkspaceByProjectId]
  )

  // Online devices first, same ordering as the homepage project menu.
  const sortedProjects = useMemo(
    () =>
      [...projects].sort((left, right) => {
        const onlineLeft = getDeviceForProject(left)?.status === 'online' ? 1 : 0
        const onlineRight = getDeviceForProject(right)?.status === 'online' ? 1 : 0
        return onlineRight - onlineLeft
      }),
    [getDeviceForProject, projects]
  )

  const normalizedQuery = query.trim().toLowerCase()
  const filteredProjects = useMemo(() => {
    if (!normalizedQuery) return sortedProjects
    return sortedProjects.filter(project => {
      const device = getDeviceForProject(project)
      const searchable = [
        project.name,
        project.description ?? '',
        device?.name ?? '',
        device?.device_id ?? '',
      ]
        .join(' ')
        .toLowerCase()
      return searchable.includes(normalizedQuery)
    })
  }, [getDeviceForProject, normalizedQuery, sortedProjects])

  const unboundLabel = t('workbench.task_activity_execution_project_unbound', '未绑定仓库')
  const resetLabel = t('workbench.task_activity_execution_project_reset', '恢复默认')

  const handleSelect = (projectId: number) => {
    // Picking the robot-bound repository explicitly is the same as the default.
    onSelectProject(projectId === defaultProject?.id ? '' : projectId)
    closeMenu()
  }

  const getStatusLabel = (status: DeviceInfo['status'] | string | null | undefined) =>
    status === 'online'
      ? t('workbench.project_device_status_online', '在线')
      : status === 'busy'
        ? t('workbench.project_device_status_busy', '忙碌')
        : t('workbench.project_device_status_offline', '离线')

  const getStatusDotClass = (status: DeviceInfo['status'] | string | null | undefined) =>
    status === 'online' ? 'bg-primary' : status === 'busy' ? 'bg-amber-500' : 'bg-text-muted'

  const hasOverride = selectedProjectId !== ''

  return (
    <div ref={containerRef} className="relative mb-2 flex items-center">
      {open ? (
        <div
          data-testid="cloud-task-activity-execution-project-menu"
          className="absolute bottom-full left-0 z-popover mb-2 flex w-80 flex-col rounded-xl border border-border bg-background p-1.5 shadow-lg"
        >
          <label className="mb-1.5 flex h-11 shrink-0 items-center gap-2 rounded-xl border border-border bg-surface px-3 text-text-secondary md:h-9">
            <Search className="h-4 w-4 shrink-0" />
            <input
              ref={searchInputRef}
              data-testid="cloud-task-activity-execution-project-search"
              type="search"
              value={query}
              onChange={event => setQuery(event.target.value)}
              placeholder={t('workbench.search_projects', '搜索项目')}
              className="min-w-0 flex-1 bg-transparent text-sm leading-[18px] text-text-primary outline-none placeholder:text-text-muted"
            />
          </label>
          {filteredProjects.length === 0 ? (
            <div className="px-4 py-3 text-sm leading-[18px] text-text-muted">
              {projects.length === 0
                ? t('workbench.no_projects', '暂无项目')
                : t('workbench.project_search_no_results', '没有匹配的项目')}
            </div>
          ) : (
            <div
              data-testid="cloud-task-activity-execution-project-options"
              className="max-h-[150px] space-y-0.5 overflow-y-auto pr-1"
            >
              {filteredProjects.map(project => {
                const workspace = firstWorkspaceByProjectId.get(project.id) ?? null
                const device = getDeviceForProject(project)
                const deviceLabel = getProjectMenuDeviceLabel(device, workspace)
                const deviceStatus = device?.status ?? workspace?.deviceStatus
                const DeviceIcon = device && isCloudDevice(device) ? Cloud : HardDrive
                const selected = project.id === effectiveProject?.id
                return (
                  <button
                    key={project.id}
                    type="button"
                    data-testid={`cloud-task-activity-execution-project-option-${project.id}`}
                    onClick={() => handleSelect(project.id)}
                    className="flex h-11 w-full rounded-lg px-4 text-left text-text-primary hover:bg-muted md:h-9"
                  >
                    <div className="flex min-h-0 w-full items-center gap-3">
                      <ProjectFolderIcon
                        project={project}
                        className="h-4 w-4 shrink-0 text-text-secondary"
                      />
                      <span className="min-w-0 max-w-[9rem] shrink truncate text-sm font-normal leading-[18px] text-text-primary">
                        {project.name}
                      </span>
                      {project.id === taskPageProject?.id ? (
                        <span className="shrink-0 rounded-md bg-muted px-1.5 py-0.5 text-xs text-text-secondary">
                          {t('workbench.task_activity_execution_project_task_badge', '任务页面')}
                        </span>
                      ) : null}
                      {project.id === defaultProject?.id ? (
                        <span className="shrink-0 rounded-md bg-violet-500/10 px-1.5 py-0.5 text-xs font-medium text-violet-700">
                          {t('workbench.task_activity_execution_project_robot_badge', '机器人绑定')}
                        </span>
                      ) : null}
                      {deviceLabel || deviceStatus ? (
                        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs leading-4 text-text-secondary">
                          <DeviceIcon className="h-3.5 w-3.5 shrink-0" />
                          <span
                            className={cn(
                              'h-1.5 w-1.5 shrink-0 rounded-full',
                              getStatusDotClass(deviceStatus)
                            )}
                          />
                          {deviceLabel ? (
                            <span className="min-w-0 truncate text-text-secondary">
                              {deviceLabel}
                            </span>
                          ) : null}
                          <span className="shrink-0">{getStatusLabel(deviceStatus)}</span>
                        </span>
                      ) : (
                        <span className="flex-1" />
                      )}
                      {selected ? (
                        <Check className="h-3.5 w-3.5 shrink-0 text-text-primary" />
                      ) : null}
                    </div>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      ) : null}
      {effectiveProject ? (
        <div className="flex h-11 min-w-0 items-center rounded-lg md:h-8">
          {hasOverride ? (
            <button
              type="button"
              data-testid="cloud-task-activity-execution-project-clear"
              onClick={() => onSelectProject('')}
              title={resetLabel}
              aria-label={resetLabel}
              className="group flex h-11 w-11 shrink-0 items-center justify-center rounded-lg text-text-secondary transition-colors hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 md:h-8 md:w-8"
            >
              <ProjectFolderIcon
                project={effectiveProject}
                className="h-4 w-4 group-hover:hidden"
              />
              <X className="hidden h-4 w-4 group-hover:block" />
            </button>
          ) : (
            <span className="flex h-11 w-11 shrink-0 items-center justify-center text-text-secondary md:h-8 md:w-8">
              <ProjectFolderIcon project={effectiveProject} className="h-4 w-4" />
            </span>
          )}
          <button
            type="button"
            data-testid="cloud-task-activity-execution-project"
            onClick={() => (open ? closeMenu() : setOpen(true))}
            title={t('workbench.change_project', '更改项目')}
            className={cn(
              'flex h-11 min-w-0 items-center gap-1.5 rounded-lg px-1.5 text-sm font-normal leading-[18px] text-text-secondary transition-colors hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 md:h-8',
              open && 'bg-muted text-text-primary'
            )}
            aria-expanded={open}
            aria-label={effectiveProject.name}
          >
            <span className="max-w-[12rem] truncate">{effectiveProject.name}</span>
            <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" />
          </button>
        </div>
      ) : (
        <button
          type="button"
          data-testid="cloud-task-activity-execution-project"
          onClick={() => (open ? closeMenu() : setOpen(true))}
          className={cn(
            'flex h-11 min-w-0 items-center gap-1.5 rounded-lg px-2 text-sm font-normal leading-[18px] text-text-secondary transition-colors hover:bg-muted hover:text-text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30 md:h-8',
            open && 'bg-muted text-text-primary'
          )}
          aria-expanded={open}
          aria-label={unboundLabel}
        >
          <FolderX className="h-4 w-4 shrink-0" />
          <span className="shrink-0">{unboundLabel}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-text-muted" />
        </button>
      )}
    </div>
  )
}
