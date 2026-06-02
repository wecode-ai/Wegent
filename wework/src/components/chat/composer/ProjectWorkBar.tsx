import { Check, ChevronDown, Cloud, FolderOpen, FolderPlus, FolderX, HardDrive } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from '@/hooks/useTranslation'
import {
  getPreferredStandaloneDeviceId,
  isCloudDevice,
  isOnlineDevice,
  sortStandaloneDevices,
} from '@/lib/device-selection'
import { cn } from '@/lib/utils'
import type { DeviceInfo, ProjectWithTasks } from '@/types/api'
import { useOutsideClick } from './useOutsideClick'

interface ProjectWorkBarProps {
  projects: ProjectWithTasks[]
  devices: DeviceInfo[]
  currentProjectId?: number
  currentStandaloneDeviceId?: string | null
  onSelectProject: (projectId: number | null) => void
  onSelectStandaloneDevice: (deviceId: string | null) => void
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
  className,
  buttonClassName,
  menuClassName,
  emptyLabel,
}: ProjectWorkBarProps) {
  const { t } = useTranslation('common')
  const containerRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const closeMenu = useCallback(() => setOpen(false), [])

  useOutsideClick(containerRef, open, closeMenu)

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
  const standaloneDevices = useMemo(() => sortStandaloneDevices(devices), [devices])
  const isStandaloneMode = currentProjectId == null
  const defaultStandaloneDeviceId = useMemo(
    () => getPreferredStandaloneDeviceId(devices, currentStandaloneDeviceId),
    [currentStandaloneDeviceId, devices]
  )
  const selectedStandaloneDeviceId = defaultStandaloneDeviceId

  const handleSelectProject = (projectId: number) => {
    onSelectProject(projectId)
    setOpen(false)
  }

  const handleUseNoProject = () => {
    onSelectStandaloneDevice(defaultStandaloneDeviceId)
    setOpen(false)
  }

  const handleSelectStandaloneDevice = (deviceId: string) => {
    onSelectStandaloneDevice(deviceId)
    setOpen(false)
  }

  const getDeviceStatusLabel = (device: DeviceInfo) => {
    if (device.status === 'online') {
      return t('workbench.project_device_online', '（在线）')
    }
    if (device.status === 'busy') {
      return t('workbench.project_device_busy', '（忙碌）')
    }
    return t('workbench.project_device_offline', '（离线）')
  }

  return (
    <div className={cn('flex min-h-[56px] items-center px-6', className)}>
      <div ref={containerRef} className="relative">
        {open && (
          <div
            data-testid="project-work-menu"
            className={cn(
              'absolute bottom-[52px] left-0 z-40 max-h-72 w-80 overflow-y-auto rounded-2xl border border-border bg-base p-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]',
              menuClassName,
            )}
          >
            <div className="px-4 pb-2 pt-1 text-[13px] font-semibold leading-[18px] text-text-muted">
              {t('workbench.projects', '项目')}
            </div>
            {projects.length === 0 ? (
              <div className="px-4 py-3 text-[13px] leading-[18px] text-text-muted">
                {t('workbench.no_projects', '暂无项目')}
              </div>
            ) : (
              <div className="space-y-1">
                {sortedProjects.map(project => {
                  const device = getDeviceForProject(project)
                  const isUnavailable = Boolean(device && device.status !== 'online')
                  const selected = project.id === currentProjectId
                  const ProjectIcon = isUnavailable ? FolderX : FolderOpen
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
                      className={`flex w-full flex-col rounded-xl px-4 py-2 text-left hover:bg-muted disabled:cursor-not-allowed disabled:hover:bg-transparent ${projectTextClass}`}
                    >
                      <div className="flex min-h-7 items-center gap-3">
                        <ProjectIcon
                          data-testid={
                            isUnavailable
                              ? `project-unavailable-icon-${project.id}`
                              : `project-available-icon-${project.id}`
                          }
                          className={`h-4 w-4 shrink-0 ${
                            isUnavailable ? 'text-text-muted' : 'text-text-secondary'
                          }`}
                        />
                        <span className="min-w-0 flex-1 truncate text-[13px] font-medium leading-[18px]">{project.name}</span>
                        {selected && (
                          <Check
                            data-testid={`project-selected-icon-${project.id}`}
                            className={`h-3.5 w-3.5 shrink-0 ${
                              isUnavailable ? 'text-text-muted' : 'text-text-primary'
                            }`}
                          />
                        )}
                      </div>
                      {device && (
                        <span className={`ml-7 text-xs ${device.status === 'online' ? 'text-text-secondary' : 'text-text-muted'}`}>
                          {device.name}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
            <div className="my-2 border-t border-border" />
            <button
              type="button"
              data-testid="no-project-option"
              onClick={handleUseNoProject}
              className="flex min-h-9 w-full items-center gap-3 rounded-xl px-4 py-2 text-left text-[13px] font-medium leading-[18px] text-text-secondary hover:bg-muted"
            >
              <FolderX className="h-4 w-4 shrink-0" />
              <span>{t('workbench.no_project', '不使用项目')}</span>
            </button>
            <div data-testid="standalone-device-list" className="mt-1 space-y-1 pl-6">
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
                        'flex min-h-9 w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs',
                        online
                          ? 'text-text-secondary hover:bg-muted'
                          : 'cursor-not-allowed text-text-muted opacity-60',
                        selected ? 'bg-muted text-text-primary' : '',
                      ].join(' ')}
                    >
                      <DeviceIcon className="h-3.5 w-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">
                        {device.name || device.device_id}
                      </span>
                      <span className={online ? 'text-primary' : 'text-text-muted'}>
                        {getDeviceStatusLabel(device)}
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
        <button
          type="button"
          data-testid="project-work-button"
          onClick={() => setOpen(current => !current)}
          className={cn(
            'flex h-9 min-w-[44px] items-center gap-2 rounded-full px-1 text-[13px] font-medium leading-[18px] text-text-secondary hover:bg-muted',
            buttonClassName,
          )}
          aria-expanded={open}
          aria-label={t('workbench.enter_project_work', '进入项目工作')}
        >
          {currentProject ? (
            <>
              <FolderOpen className="h-4 w-4" />
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
