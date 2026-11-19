import { Tooltip } from '@/components/ui/tooltip'
import {
  changeRequestVisualStatus,
  type ChangeRequestVisualStatus,
} from '@/features/workbench/changeRequestStatus'
import type { ResourceObservation } from '@/features/workbench/resourceObservation'
import { useTranslation } from '@/hooks/useTranslation'
import { openExternalUrl } from '@/lib/external-links'
import { cn } from '@/lib/utils'
import type { ChangeRequest } from '@/types/environment'
import { Popover, PopoverContent, PopoverTrigger } from '@wegent/collaboration/controls/Popover'
import { controlPopup } from '@wegent/collaboration/controls/recipes'
import { Button as ControlButton } from '@wegent/collaboration/markdown/Button'
import { useCollaborationPortalTheme } from '@wegent/collaboration/theme'
import {
  CircleCheck,
  CircleDot,
  CircleX,
  Clock3,
  GitMerge,
  GitPullRequest,
  Loader2,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { useState } from 'react'
import { ResourceObservationStatus } from './ResourceObservationStatus'

interface ChangeRequestStatusGlyphConfig {
  mainClassName: string
  badgeIcon?: LucideIcon
  badgeClassName?: string
  badgeIconClassName?: string
}

interface ChangeRequestStatusSnapshot {
  changeRequest: ChangeRequest | null
  stale?: boolean
  observation?: ResourceObservation
}

const statusGlyphs: Record<ChangeRequestVisualStatus, ChangeRequestStatusGlyphConfig> = {
  draft: { mainClassName: 'text-text-muted' },
  open: { mainClassName: 'text-success wework:text-green-500' },
  checks_pending: {
    mainClassName: 'text-success wework:text-green-500',
    badgeIcon: Clock3,
    badgeClassName: 'text-text-muted',
  },
  checks_passed: {
    mainClassName: 'text-success wework:text-green-500',
    badgeIcon: CircleCheck,
    badgeClassName: 'text-success wework:text-green-500',
  },
  checks_failed: {
    mainClassName: 'text-success wework:text-green-500',
    badgeIcon: CircleX,
    badgeClassName: 'text-destructive wework:text-red-500',
  },
  merge_conflict: {
    mainClassName: 'text-destructive wework:text-red-500',
    badgeIcon: TriangleAlert,
    badgeClassName: 'text-destructive wework:text-red-500',
  },
  merge_queue_queued: {
    mainClassName: 'text-warning wework:text-amber-500',
    badgeIcon: Clock3,
    badgeClassName: 'text-warning wework:text-amber-500',
  },
  merge_queue_checking: {
    mainClassName: 'text-warning wework:text-amber-500',
    badgeIcon: Loader2,
    badgeClassName: 'text-warning wework:text-amber-500',
    badgeIconClassName: 'animate-spin',
  },
  merge_queue_failed: {
    mainClassName: 'text-destructive wework:text-red-500',
    badgeIcon: CircleX,
    badgeClassName: 'text-destructive wework:text-red-500',
  },
  merge_queue_timed_out: {
    mainClassName: 'text-destructive wework:text-red-500',
    badgeIcon: Clock3,
    badgeClassName: 'text-destructive wework:text-red-500',
  },
  merge_queue_conflicting: {
    mainClassName: 'text-destructive wework:text-red-500',
    badgeIcon: TriangleAlert,
    badgeClassName: 'text-destructive wework:text-red-500',
  },
  merge_queue_removed: {
    mainClassName: 'text-text-muted',
    badgeIcon: CircleDot,
    badgeClassName: 'text-text-muted',
  },
  closed: { mainClassName: 'text-destructive wework:text-red-500' },
  merged: { mainClassName: 'text-success wework:text-violet-500' },
}

export function ChangeRequestStatusGlyph({
  changeRequest,
  size = 'compact',
  className,
  mainIconTestId,
}: {
  changeRequest: ChangeRequest
  size?: 'compact' | 'environment'
  className?: string
  mainIconTestId?: string
}) {
  const status = changeRequestVisualStatus(changeRequest)
  const config = statusGlyphs[status]
  const MainIcon = status === 'merged' ? GitMerge : GitPullRequest
  const BadgeIcon = config.badgeIcon
  const environmentSize = size === 'environment'

  return (
    <span
      className={cn(
        'relative flex shrink-0 items-center justify-center',
        environmentSize ? 'h-[18px] w-[18px]' : 'h-4 w-4',
        config.mainClassName,
        className
      )}
      aria-hidden="true"
    >
      <MainIcon
        data-testid={mainIconTestId}
        className={cn(environmentSize ? 'h-[18px] w-[18px]' : 'h-3.5 w-3.5', config.mainClassName)}
      />
      {BadgeIcon ? (
        <span
          className={cn(
            'absolute -bottom-1 -right-1 flex items-center justify-center rounded-full bg-background',
            environmentSize ? 'h-3.5 w-3.5' : 'h-3 w-3',
            config.badgeClassName
          )}
        >
          <BadgeIcon
            className={cn(
              environmentSize ? 'h-3.5 w-3.5' : 'h-3 w-3',
              'fill-background',
              config.badgeIconClassName
            )}
          />
        </span>
      ) : null}
    </span>
  )
}

export function ChangeRequestStatusIcon({
  snapshot,
  testId,
  repairing = false,
  onContinueRepair,
  className,
  popoverAlign = 'right',
  glyphSize = 'compact',
  mainIconTestId,
}: {
  snapshot: ChangeRequestStatusSnapshot | null
  testId: string
  repairing?: boolean
  onContinueRepair?: () => Promise<void> | void
  className?: string
  popoverAlign?: 'left' | 'right'
  glyphSize?: 'compact' | 'environment'
  mainIconTestId?: string
}) {
  const { t } = useTranslation('common')
  const [open, setOpen] = useState(false)
  const changeRequest = snapshot?.changeRequest
  const theme = useCollaborationPortalTheme()

  if (!changeRequest) return null
  const status = changeRequestVisualStatus(changeRequest)
  const label = t(`workbench.change_request_status_${status}`, status)
  const prefix = changeRequest.provider === 'gitlab' ? '!' : '#'

  return (
    <span
      className={cn('inline-flex shrink-0', className)}
      onClick={event => event.stopPropagation()}
    >
      <Popover open={open} onOpenChange={setOpen}>
        <Tooltip label={`${prefix}${changeRequest.number} · ${label}`}>
          <PopoverTrigger
            render={<button type="button" />}
            data-testid={testId}
            aria-label={`${prefix}${changeRequest.number} · ${label}`}
            aria-expanded={open}
            className="flex h-6 w-6 items-center justify-center rounded-md hover:bg-muted"
          >
            <ChangeRequestStatusGlyph
              changeRequest={changeRequest}
              size={glyphSize}
              mainIconTestId={mainIconTestId}
            />
          </PopoverTrigger>
        </Tooltip>
        <PopoverContent
          {...theme}
          aria-label={changeRequest.title}
          align={popoverAlign === 'left' ? 'start' : 'end'}
          sideOffset={4}
          collisionPadding={8}
          data-testid={testId + '-popover'}
          className={cn(theme.className, controlPopup, 'w-64 p-3')}
        >
          <span className="block truncate text-sm font-medium text-text-primary">
            {prefix}
            {changeRequest.number} · {changeRequest.title}
          </span>
          <span className="mt-1 block text-xs text-text-secondary">{label}</span>
          {snapshot?.observation && (
            <span className="mt-1 block">
              <ResourceObservationStatus observation={snapshot.observation} />
            </span>
          )}
          {changeRequest.mergeQueueReason ? (
            <span className="mt-1 line-clamp-3 block text-xs text-text-muted">
              {changeRequest.mergeQueueReason}
            </span>
          ) : null}
          {snapshot?.stale ? (
            <span className="mt-1 block text-xs text-warning wework:text-amber-600">
              {t('workbench.change_request_status_stale', '状态可能已过期')}
            </span>
          ) : null}
          <span className="mt-3 flex items-center justify-end gap-2">
            <ControlButton
              variant="unstyled"
              type="button"
              data-testid={`${testId}-open`}
              onClick={() => {
                setOpen(false)
                void openExternalUrl(changeRequest.url)
              }}
              className="h-7 rounded-md px-2 text-xs text-text-secondary hover:bg-muted"
            >
              {t('workbench.change_request_open', '打开 PR')}
            </ControlButton>
            {onContinueRepair ? (
              <ControlButton
                variant="primary"
                size="sm"
                type="button"
                data-testid={`${testId}-repair`}
                disabled={repairing}
                onClick={() => {
                  setOpen(false)
                  void onContinueRepair()
                }}
                className="h-7 rounded-md bg-text-primary px-2 text-xs text-background disabled:opacity-50"
              >
                {repairing
                  ? t('workbench.change_request_repairing', 'AI 修复中')
                  : t('workbench.change_request_continue_repair', '让 AI 继续修复')}
              </ControlButton>
            ) : null}
          </span>
        </PopoverContent>
      </Popover>
    </span>
  )
}
