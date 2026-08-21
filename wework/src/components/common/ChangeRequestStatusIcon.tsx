import {
  Check,
  CircleDot,
  CircleX,
  Clock3,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  Loader2,
  TriangleAlert,
} from 'lucide-react'
import { useState } from 'react'
import type { TaskChangeRequestSnapshot } from '@/api/changeRequests'
import { Tooltip } from '@/components/ui/tooltip'
import {
  changeRequestVisualStatus,
  type ChangeRequestVisualStatus,
} from '@/features/workbench/changeRequestStatus'
import { useTranslation } from '@/hooks/useTranslation'
import { openExternalUrl } from '@/lib/external-links'
import { cn } from '@/lib/utils'

const statusIcons: Record<
  ChangeRequestVisualStatus,
  { icon: typeof GitPullRequest; className: string }
> = {
  open: { icon: GitPullRequest, className: 'text-text-muted' },
  checks_pending: { icon: Clock3, className: 'text-amber-500' },
  checks_passed: { icon: Check, className: 'text-green-500' },
  checks_failed: { icon: CircleX, className: 'text-red-500' },
  merge_conflict: { icon: TriangleAlert, className: 'text-red-500' },
  merge_queue_queued: { icon: GitMerge, className: 'text-amber-500' },
  merge_queue_checking: { icon: Loader2, className: 'animate-spin text-amber-500' },
  merge_queue_failed: { icon: CircleX, className: 'text-red-500' },
  merge_queue_timed_out: { icon: Clock3, className: 'text-red-500' },
  merge_queue_conflicting: { icon: TriangleAlert, className: 'text-red-500' },
  merge_queue_removed: { icon: CircleDot, className: 'text-text-muted' },
  closed: { icon: GitPullRequestClosed, className: 'text-text-muted' },
  merged: { icon: GitMerge, className: 'text-violet-500' },
}

export function ChangeRequestStatusIcon({
  snapshot,
  testId,
  repairing = false,
  onContinueRepair,
  className,
  popoverAlign = 'right',
}: {
  snapshot: TaskChangeRequestSnapshot | null
  testId: string
  repairing?: boolean
  onContinueRepair?: () => Promise<void> | void
  className?: string
  popoverAlign?: 'left' | 'right'
}) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const changeRequest = snapshot?.changeRequest
  if (!changeRequest) return null
  const status = changeRequestVisualStatus(changeRequest)
  const config = statusIcons[status]
  const Icon = config.icon
  const label = t(`workbench.change_request_status_${status}`, status)
  const prefix = changeRequest.provider === 'gitlab' ? '!' : '#'

  return (
    <span
      className={cn('relative inline-flex shrink-0', className)}
      onClick={event => event.stopPropagation()}
    >
      <Tooltip label={`${prefix}${changeRequest.number} · ${label}`}>
        <button
          type="button"
          data-testid={testId}
          aria-label={`${prefix}${changeRequest.number} · ${label}`}
          aria-expanded={open}
          onClick={() => setOpen(current => !current)}
          className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-muted"
        >
          <Icon className={cn('h-3.5 w-3.5', config.className)} />
        </button>
      </Tooltip>
      {open ? (
        <span
          data-testid={`${testId}-popover`}
          className={cn(
            'absolute top-7 z-50 w-64 rounded-xl border border-border bg-popover p-3 text-left shadow-lg',
            popoverAlign === 'left' ? 'left-0' : 'right-0'
          )}
        >
          <span className="block truncate text-sm font-medium text-text-primary">
            {prefix}
            {changeRequest.number} · {changeRequest.title}
          </span>
          <span className="mt-1 block text-xs text-text-secondary">{label}</span>
          {changeRequest.mergeQueueReason ? (
            <span className="mt-1 line-clamp-3 block text-xs text-text-muted">
              {changeRequest.mergeQueueReason}
            </span>
          ) : null}
          {snapshot?.stale ? (
            <span className="mt-1 block text-xs text-amber-600">
              {t('workbench.change_request_status_stale', '状态可能已过期')}
            </span>
          ) : null}
          <span className="mt-3 flex items-center justify-end gap-2">
            <button
              type="button"
              data-testid={`${testId}-open`}
              onClick={() => void openExternalUrl(changeRequest.url)}
              className="h-7 rounded-md px-2 text-xs text-text-secondary hover:bg-muted"
            >
              {t('workbench.change_request_open', '打开 PR')}
            </button>
            {onContinueRepair ? (
              <button
                type="button"
                data-testid={`${testId}-repair`}
                disabled={repairing}
                onClick={() => void onContinueRepair()}
                className="h-7 rounded-md bg-text-primary px-2 text-xs text-background disabled:opacity-50"
              >
                {repairing
                  ? t('workbench.change_request_repairing', 'AI 修复中')
                  : t('workbench.change_request_continue_repair', '让 AI 继续修复')}
              </button>
            ) : null}
          </span>
        </span>
      ) : null}
    </span>
  )
}
