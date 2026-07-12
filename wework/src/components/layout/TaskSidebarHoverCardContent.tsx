import { CircleAlert, FolderOpen, GitBranch, Server } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from '@/hooks/useTranslation'

interface TaskSidebarHoverCardContentProps {
  taskId: string
  title: string
  projectLabel: string
  repositoryLabel?: string | null
  branchLabel?: string | null
  workspacePath?: string | null
  hostLabel?: string | null
  updatedLabel?: string | null
  branchWarning?: boolean
}

function HoverRow({
  icon,
  value,
  mono = false,
}: {
  icon: ReactNode
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex min-w-0 items-start gap-2 rounded-md px-1 py-0.5">
      <span className="flex h-5 w-4 shrink-0 items-center justify-center text-text-muted">
        {icon}
      </span>
      <span
        className={
          mono
            ? 'min-w-0 flex-1 break-all font-mono text-[11px] leading-5 text-text-primary'
            : 'min-w-0 flex-1 truncate text-[13px] leading-5 text-text-primary'
        }
      >
        {value}
      </span>
    </div>
  )
}

export function TaskSidebarHoverCardContent({
  taskId,
  title,
  projectLabel,
  repositoryLabel,
  branchLabel,
  workspacePath,
  hostLabel,
  updatedLabel,
  branchWarning = false,
}: TaskSidebarHoverCardContentProps) {
  const { t } = useTranslation('common')
  return (
    <div data-testid={`runtime-local-task-hover-content-${taskId}`} className="space-y-2.5">
      <div className="flex min-w-0 items-start gap-3">
        <div className="line-clamp-2 min-w-0 flex-1 text-[15px] font-medium leading-5 text-text-primary">
          {title}
        </div>
        {updatedLabel && (
          <span className="shrink-0 text-[13px] leading-5 text-text-muted">{updatedLabel}</span>
        )}
      </div>
      <div className="space-y-1">
        <HoverRow icon={<FolderOpen className="h-4 w-4" />} value={projectLabel} />
        {repositoryLabel && repositoryLabel !== projectLabel && (
          <HoverRow icon={<GitBranch className="h-4 w-4" />} value={repositoryLabel} />
        )}
        {branchLabel ? (
          <HoverRow icon={<GitBranch className="h-4 w-4" />} value={branchLabel} />
        ) : workspacePath ? (
          <HoverRow icon={<FolderOpen className="h-4 w-4" />} value={workspacePath} mono />
        ) : null}
        {hostLabel && <HoverRow icon={<Server className="h-4 w-4" />} value={hostLabel} />}
      </div>
      {branchWarning && (
        <div className="flex items-start gap-2 text-[13px] leading-5 text-orange-500">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t('workbench.runtime_task_branch_warning')}</span>
        </div>
      )}
    </div>
  )
}
