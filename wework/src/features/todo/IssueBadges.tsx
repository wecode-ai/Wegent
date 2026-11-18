import {
  Ban,
  Check,
  CircleCheck,
  CircleX,
  Clock3,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  ListChecks,
  Link2,
  Loader2,
  LockKeyhole,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react'
import type { CollaborationIssueBadge } from '@wegent/collaboration'
import { Tooltip } from '@/components/ui/tooltip'
import { useTranslation } from '@/hooks/useTranslation'
import { openExternalUrl } from '@/lib/external-links'

export function IssueBadges({
  badges,
  compact = false,
  testId = 'issue-badges',
}: {
  badges: CollaborationIssueBadge[]
  compact?: boolean
  testId?: string
}) {
  const { t } = useTranslation('common')
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
      {badges.map(badge => (
        <IssueBadgeView key={badge.id} badge={badge} />
      ))}
    </section>
  )
}

const badgeIcons = {
  ban: Ban,
  check: Check,
  'circle-check': CircleCheck,
  'circle-x': CircleX,
  'git-merge': GitMerge,
  'git-pull-request-closed': GitPullRequestClosed,
  loader: Loader2,
  lock: LockKeyhole,
  refresh: RefreshCw,
  clock: Clock3,
  hooks: ListChecks,
  link: Link2,
  warning: TriangleAlert,
  'git-pull-request': GitPullRequest,
}
const badgeTones = {
  neutral: 'text-text-secondary',
  info: 'text-info',
  success: 'text-success-foreground',
  warning: 'text-warning-foreground',
  danger: 'text-destructive',
  merged: 'text-merged',
}

function IssueBadgeView({ badge }: { badge: CollaborationIssueBadge }) {
  const Icon = badgeIcons[badge.icon as keyof typeof badgeIcons]
  const content = (
    <>
      {Icon ? (
        <Icon
          aria-hidden="true"
          className={badge.icon === 'loader' ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'}
        />
      ) : null}
      <span className="max-w-48 truncate">{badge.label}</span>
    </>
  )
  const className = `inline-flex h-6 items-center gap-1.5 rounded-md bg-muted/40 px-1.5 text-xs ${badgeTones[badge.tone ?? 'neutral']}`
  const view = badge.url ? (
    <button
      type="button"
      className={`${className} hover:bg-muted`}
      data-testid={`issue-badge-${badge.id}`}
      title={badge.tooltip || badge.label}
      aria-label={badge.tooltip ? badge.label + ' · ' + badge.tooltip : badge.label}
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
  return badge.tooltip ? <Tooltip label={badge.tooltip}>{view}</Tooltip> : view
}
