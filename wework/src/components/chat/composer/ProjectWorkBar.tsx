import { ChevronDown, FolderOpen, FolderPlus } from 'lucide-react'
import { useCallback, useMemo, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { DeviceInfo, ProjectWithTasks } from '@/types/api'
import { useOutsideClick } from './useOutsideClick'

interface ProjectWorkBarProps {
  projects: ProjectWithTasks[]
  devices: DeviceInfo[]
  currentProjectId?: number
  onSelectProject: (projectId: number) => void
}

export function ProjectWorkBar({ projects, devices, currentProjectId, onSelectProject }: ProjectWorkBarProps) {
  const { t } = useTranslation('common')
  const containerRef = useRef<HTMLDivElement>(null)
  const [open, setOpen] = useState(false)
  const closeMenu = useCallback(() => setOpen(false), [])

  useOutsideClick(containerRef, open, closeMenu)

  const currentProject = useMemo(
    () => projects.find(p => p.id === currentProjectId),
    [projects, currentProjectId]
  )

  const getDeviceForProject = (project: ProjectWithTasks): DeviceInfo | undefined => {
    const deviceId = project.config?.execution?.deviceId
    if (!deviceId) return undefined
    return devices.find(d => d.device_id === deviceId)
  }

  const sortedProjects = useMemo(() => {
    return [...projects].sort((a, b) => {
      const deviceA = getDeviceForProject(a)
      const deviceB = getDeviceForProject(b)
      const onlineA = deviceA?.status === 'online' ? 1 : 0
      const onlineB = deviceB?.status === 'online' ? 1 : 0
      return onlineB - onlineA
    })
  }, [projects, devices])

  const handleSelectProject = (projectId: number) => {
    onSelectProject(projectId)
    setOpen(false)
  }

  return (
    <div className="flex min-h-[56px] items-center px-6">
      <div ref={containerRef} className="relative">
        {open && (
          <div
            data-testid="project-work-menu"
            className="absolute bottom-[52px] left-0 z-40 max-h-72 w-80 overflow-y-auto rounded-2xl border border-border bg-base p-2 shadow-[0_16px_44px_rgba(0,0,0,0.16)]"
          >
            <div className="px-4 pb-2 pt-1 text-sm font-semibold text-text-muted">
              {t('workbench.projects', '项目')}
            </div>
            {projects.length === 0 ? (
              <div className="px-4 py-3 text-sm text-text-muted">
                {t('workbench.no_projects', '暂无项目')}
              </div>
            ) : (
              <div className="space-y-1">
                {sortedProjects.map(project => {
                  const device = getDeviceForProject(project)
                  return (
                    <button
                      key={project.id}
                      type="button"
                      data-testid={`project-option-${project.id}`}
                      onClick={() => handleSelectProject(project.id)}
                      className={`flex w-full flex-col rounded-xl px-4 py-2 text-left hover:bg-muted ${
                        project.id === currentProjectId ? 'text-text-primary' : 'text-text-secondary'
                      }`}
                    >
                      <div className="flex min-h-7 items-center gap-3">
                        <FolderOpen className="h-4 w-4 shrink-0 text-text-secondary" />
                        <span className="min-w-0 flex-1 truncate text-sm font-medium">{project.name}</span>
                      </div>
                      {device && (
                        <span className={`ml-7 text-xs ${device.status === 'online' ? 'text-primary' : 'text-text-muted'}`}>
                          {device.name}
                        </span>
                      )}
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}
        <button
          type="button"
          data-testid="project-work-button"
          onClick={() => setOpen(current => !current)}
          className="flex h-11 min-w-[44px] items-center gap-2 rounded-full px-1 text-sm font-medium text-text-secondary hover:bg-muted"
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
              <span>{t('workbench.enter_project_work', '进入项目工作')}</span>
            </>
          )}
          <ChevronDown className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
