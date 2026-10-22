import { useMemo } from 'react'
import { Check, Clock3, GitPullRequest, Link2, Loader2, TriangleAlert } from 'lucide-react'
import type { CollaborationIssueBadge } from '@wegent/collaboration'
import type { TaskChangeRequestTarget } from '@/api/changeRequests'
import type { DeviceCommandApi } from '@/api/environment'
import { ChangeRequestStatusIcon } from '@/components/common/ChangeRequestStatusIcon'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import {
  getChangeRequestMonitor,
  useTaskChangeRequest,
  type ChangeRequestMonitor,
} from '@/features/workbench/changeRequestMonitor'
import { changeRequestVisualStatus } from '@/features/workbench/changeRequestStatus'
import { useTranslation } from '@/hooks/useTranslation'
import { openExternalUrl } from '@/lib/external-links'
import { linkedChangeRequestTarget } from '@/api/changeRequests'
import { LOCAL_WORKBENCH_DEVICE_ALIAS } from '@/lib/workbench-device'

function IssueChangeRequest({
  target,
  monitor,
  compact,
  active,
}: {
  target: TaskChangeRequestTarget
  monitor: ChangeRequestMonitor
  compact: boolean
  active: boolean
}) {
  const { t } = useTranslation('common')
  const snapshot = useTaskChangeRequest(monitor, target, active)
  const changeRequest = snapshot?.changeRequest
  const provider = target.changeRequestUrl!.includes('/-/merge_requests/') ? 'gitlab' : 'github'
  const number = target.changeRequestUrl!.split('/').at(-1)
  const status = changeRequest ? changeRequestVisualStatus(changeRequest) : null
  const label = status
    ? t(`workbench.change_request_status_${status}`)
    : snapshot
      ? t(
          `workbench.environment_change_request_${snapshot.lookupState === 'unavailable' || snapshot.lookupState === 'unauthenticated' ? snapshot.lookupState : 'error'}_${provider}`
        )
      : t('todo.issue_pr_loading')

  if (compact) {
    const prefix = provider === 'gitlab' ? '!' : '#'
    return (
      <span className="inline-flex" data-testid={`issue-pr-${provider}-${number}`}>
        {changeRequest ? (
          <ChangeRequestStatusIcon
            snapshot={snapshot}
            testId={`issue-pr-status-${provider}-${number}`}
            showNumber
          />
        ) : (
          <button
            type="button"
            data-testid={`issue-pr-open-${provider}-${number}`}
            title={`${prefix}${number} · ${label}`}
            aria-label={`${prefix}${number} · ${label}`}
            className="inline-flex h-6 items-center gap-1.5 rounded-md bg-muted/40 px-1.5 text-xs text-text-muted hover:bg-muted"
            onClick={event => {
              event.stopPropagation()
              void openExternalUrl(target.changeRequestUrl!)
            }}
          >
            {snapshot ? (
              <GitPullRequest className="h-3.5 w-3.5" />
            ) : (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            )}
            <span>
              {prefix}
              {number}
            </span>
          </button>
        )}
      </span>
    )
  }

  return (
    <div
      className="flex min-w-0 items-center gap-2 text-xs"
      data-testid={`issue-pr-${provider}-${number}`}
    >
      <ChangeRequestStatusIcon
        snapshot={snapshot}
        testId={`issue-pr-status-${provider}-${number}`}
      />
      <button
        type="button"
        data-testid={`issue-pr-open-${provider}-${number}`}
        title={target.changeRequestUrl}
        className="min-w-0 truncate text-blue-500 hover:underline"
        onClick={event => {
          event.stopPropagation()
          void openExternalUrl(target.changeRequestUrl!)
        }}
      >
        {new URL(target.remoteUrl).pathname.slice(1)}
        {provider === 'gitlab' ? ' !' : ' #'}
        {number}
      </button>
      <span className="text-text-secondary">{label}</span>
      {snapshot?.stale ? (
        <span className="text-amber-600">{t('workbench.change_request_status_stale')}</span>
      ) : null}
    </div>
  )
}

export function IssueBadges({
  badges,
  api,
  monitor: suppliedMonitor,
  compact = false,
  testId = 'issue-badges',
  active = true,
}: {
  badges: CollaborationIssueBadge[]
  api?: DeviceCommandApi
  monitor?: ChangeRequestMonitor | null
  compact?: boolean
  testId?: string
  active?: boolean
}) {
  const { t } = useTranslation('common')
  const preferences = useAppPreferencesState()
  const monitor = useMemo(
    () => suppliedMonitor ?? (api ? getChangeRequestMonitor(api) : null),
    [api, suppliedMonitor]
  )
  if (!badges.length) return null
  return (
    <section
      className={
        compact ? 'mb-2 mt-1 flex flex-wrap items-center gap-1' : 'flex flex-col gap-2 px-4 py-3'
      }
      data-testid={testId}
      aria-label={t('todo.issue_badges_title')}
    >
      {compact ? null : (
        <span className="text-xs text-text-muted">{t('todo.issue_badges_title')}</span>
      )}
      {badges.map(badge => {
        const target = badge.url
          ? linkedChangeRequestTarget(LOCAL_WORKBENCH_DEVICE_ALIAS, badge.url)
          : null
        return target &&
          monitor &&
          preferences?.preferences.changeRequestStatusEnabled !== false ? (
          <IssueChangeRequest
            key={badge.id}
            target={target}
            monitor={monitor}
            compact={compact}
            active={active}
          />
        ) : (
          <IssueBadgeView key={badge.id} badge={badge} />
        )
      })}
    </section>
  )
}

const badgeIcons = {
  check: Check,
  clock: Clock3,
  link: Link2,
  warning: TriangleAlert,
  'git-pull-request': GitPullRequest,
}
const badgeTones = {
  neutral: 'text-text-secondary',
  success: 'text-green-600',
  warning: 'text-amber-600',
  danger: 'text-red-600',
}

function IssueBadgeView({ badge }: { badge: CollaborationIssueBadge }) {
  const Icon = badgeIcons[badge.icon as keyof typeof badgeIcons]
  const content = (
    <>
      {Icon ? <Icon className="h-3.5 w-3.5" /> : null}
      <span>{badge.label}</span>
    </>
  )
  const className = `inline-flex h-6 items-center gap-1.5 rounded-md bg-muted/40 px-1.5 text-xs ${badgeTones[badge.tone ?? 'neutral']}`
  return badge.url ? (
    <button
      type="button"
      className={`${className} hover:bg-muted`}
      data-testid={`issue-badge-${badge.id}`}
      title={badge.tooltip || badge.label}
      onClick={event => {
        event.stopPropagation()
        void openExternalUrl(badge.url!)
      }}
    >
      {content}
    </button>
  ) : (
    <span
      className={className}
      data-testid={`issue-badge-${badge.id}`}
      title={badge.tooltip || badge.label}
    >
      {content}
    </span>
  )
}
