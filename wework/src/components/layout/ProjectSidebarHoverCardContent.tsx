import { ChevronRight, FolderOpen, Pin, Server } from 'lucide-react'
import type { ReactNode } from 'react'
import { ProjectFolderIcon } from '@/components/projects/ProjectFolderIcon'
import { useTranslation } from '@/hooks/useTranslation'
import { cn } from '@/lib/utils'
import type { ProjectWithTasks } from '@/types/api'

export interface ProjectHoverSource {
  id: string
  kind: 'host' | 'path'
  value: string
  actionLabel?: string
  onOpen?: () => void
}

interface ProjectSidebarHoverCardContentProps {
  project: ProjectWithTasks
  remote: boolean
  marker?: ReactNode
  markerColor?: string
  taskCount: number
  activeCount: number
  waitingCount: number
  unreadCount: number
  pinned: boolean
  canPin: boolean
  sources: ProjectHoverSource[]
  onTogglePin: () => void
  onRename: () => void
}

function SourceIcon({ kind }: { kind: ProjectHoverSource['kind'] }) {
  if (kind === 'host') return <Server className="h-4 w-4" />
  return <FolderOpen className="h-4 w-4" />
}

export function ProjectSidebarHoverCardContent({
  project,
  remote,
  marker,
  markerColor,
  taskCount,
  activeCount,
  waitingCount,
  unreadCount,
  pinned,
  canPin,
  sources,
  onTogglePin,
  onRename,
}: ProjectSidebarHoverCardContentProps) {
  const { t } = useTranslation('common')
  const statuses = [
    t('workbench.project_hover_task_count', { count: taskCount }),
    waitingCount > 0 ? t('workbench.project_hover_waiting_count', { count: waitingCount }) : null,
    unreadCount > 0 ? t('workbench.project_hover_unread_count', { count: unreadCount }) : null,
    activeCount > 0 ? t('workbench.project_hover_active_count', { count: activeCount }) : null,
  ].filter((value): value is string => Boolean(value))

  return (
    <div data-testid={`project-hover-card-content-${project.id}`} className="space-y-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <span
          className="flex h-5 w-5 shrink-0 items-center justify-center"
          style={markerColor ? { color: markerColor } : undefined}
        >
          {marker ?? (
            <ProjectFolderIcon
              project={project}
              remote={remote}
              testId={`project-hover-folder-icon-${project.id}`}
              className="h-4 w-4"
            />
          )}
        </span>
        <button
          type="button"
          data-testid={`project-hover-rename-${project.id}`}
          onClick={onRename}
          className="min-w-0 flex-1 truncate rounded-md text-left text-[15px] font-medium leading-6 text-text-primary hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
          aria-label={t('workbench.rename_project')}
        >
          {project.name}
        </button>
        <button
          type="button"
          data-testid={`project-hover-pin-${project.id}`}
          disabled={!canPin}
          onClick={onTogglePin}
          className={cn(
            'flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-text-muted hover:bg-muted hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40',
            pinned && 'text-primary'
          )}
          title={pinned ? t('workbench.unpin_project') : t('workbench.pin_project')}
          aria-label={pinned ? t('workbench.unpin_project') : t('workbench.pin_project')}
        >
          <Pin className={cn('h-4 w-4', pinned && 'fill-current')} />
        </button>
      </div>

      <div className="flex flex-wrap items-center gap-x-1.5 text-[12px] leading-5 text-text-secondary">
        {statuses.map((status, index) => (
          <span key={status} className="inline-flex items-center gap-1.5">
            {index > 0 && <span aria-hidden="true">·</span>}
            <span>{status}</span>
          </span>
        ))}
      </div>

      {sources.length > 0 && (
        <div className="space-y-0.5 border-t border-border pt-2">
          {sources.map(source => {
            const content = (
              <>
                <span className="flex h-5 w-4 shrink-0 items-center justify-center text-text-muted">
                  <SourceIcon kind={source.kind} />
                </span>
                <span
                  className={cn(
                    'min-w-0 flex-1 text-[13px] leading-5 text-text-primary',
                    source.kind === 'path' ? 'break-all font-mono text-[11px]' : 'truncate'
                  )}
                >
                  {source.value}
                </span>
                {source.onOpen && (
                  <ChevronRight className="h-3.5 w-3.5 shrink-0 opacity-0 transition-opacity group-hover/source:opacity-100 group-focus-visible/source:opacity-100" />
                )}
              </>
            )
            return source.onOpen ? (
              <button
                key={source.id}
                type="button"
                data-testid={`project-hover-source-${project.id}-${source.kind}`}
                onClick={source.onOpen}
                aria-label={source.actionLabel}
                className="group/source flex min-h-7 w-full items-start gap-2 rounded-md px-1 py-1 text-left hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
              >
                {content}
              </button>
            ) : (
              <div
                key={source.id}
                data-testid={`project-hover-source-${project.id}-${source.kind}`}
                className="flex min-h-7 items-start gap-2 rounded-md px-1 py-1"
              >
                {content}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
