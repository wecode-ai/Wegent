import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { CollaborationIssueBadge } from '@wegent/collaboration'
import { linkedChangeRequestTarget } from '@/api/changeRequests'
import type { DeviceCommandApi } from '@/api/environment'
import { isRuntimeFeatureEnabled } from '@/config/runtime'
import { useAppPreferencesState } from '@/features/app-preferences/useAppPreferencesState'
import { IssueBadges } from '@/features/todo/IssueBadges'
import {
  getChangeRequestMonitor,
  type ChangeRequestMonitor,
} from '@/features/workbench/changeRequestMonitor'
import {
  changeRequestVisualStatus,
  type ChangeRequestVisualStatus,
} from '@/features/workbench/changeRequestStatus'
import { useTranslation } from '@/hooks/useTranslation'
import { LOCAL_WORKBENCH_DEVICE_ALIAS } from '@/lib/workbench-device'
import { observationLabelKey } from '@/features/workbench/resourceObservation'

export const CHANGE_REQUEST_LIFECYCLE_BADGE_FLAG = 'collab.changeRequestLifecycleBadge.v1'

const visuals: Record<ChangeRequestVisualStatus, Pick<CollaborationIssueBadge, 'icon' | 'tone'>> = {
  draft: { icon: 'git-pull-request', tone: 'neutral' },
  open: { icon: 'git-pull-request', tone: 'info' },
  checks_pending: { icon: 'clock', tone: 'warning' },
  checks_passed: { icon: 'circle-check', tone: 'success' },
  checks_failed: { icon: 'circle-x', tone: 'danger' },
  merge_conflict: { icon: 'warning', tone: 'danger' },
  blocked: { icon: 'ban', tone: 'danger' },
  behind: { icon: 'refresh', tone: 'warning' },
  unstable: { icon: 'warning', tone: 'warning' },
  has_hooks: { icon: 'hooks', tone: 'warning' },
  merge_queue_queued: { icon: 'clock', tone: 'warning' },
  merge_queue_checking: { icon: 'loader', tone: 'warning' },
  merge_queue_failed: { icon: 'circle-x', tone: 'danger' },
  merge_queue_timed_out: { icon: 'clock', tone: 'danger' },
  merge_queue_unmergeable: { icon: 'warning', tone: 'danger' },
  merge_queue_locked: { icon: 'lock', tone: 'warning' },
  merge_queue_removed: { icon: 'git-pull-request', tone: 'neutral' },
  closed: { icon: 'git-pull-request-closed', tone: 'danger' },
  merged: { icon: 'git-merge', tone: 'merged' },
  unknown: { icon: 'git-pull-request', tone: 'neutral' },
}

const legacyVisuals: Record<
  ChangeRequestVisualStatus,
  Pick<CollaborationIssueBadge, 'icon' | 'tone'>
> = {
  ...visuals,
  open: { icon: 'git-pull-request', tone: 'success' },
  blocked: { icon: 'warning', tone: 'danger' },
  behind: { icon: 'clock', tone: 'warning' },
  unstable: { icon: 'clock', tone: 'warning' },
  has_hooks: { icon: 'clock', tone: 'warning' },
  merge_queue_locked: { icon: 'clock', tone: 'warning' },
  closed: { icon: 'git-pull-request-closed', tone: 'neutral' },
  merged: { icon: 'git-merge', tone: 'success' },
}

/** Adapts live PR state into generic badge data without writing it back to the Issue. */
export function IssueChangeRequestBadges({
  badges,
  api,
  monitor: suppliedMonitor,
  compact = false,
  testId,
}: {
  badges: CollaborationIssueBadge[]
  api?: DeviceCommandApi
  monitor?: ChangeRequestMonitor | null
  compact?: boolean
  testId?: string
}) {
  const { t } = useTranslation('common')
  const preferences = useAppPreferencesState()
  const lookupEnabled = preferences?.preferences.changeRequestStatusEnabled !== false
  const lifecycleBadgeEnabled = isRuntimeFeatureEnabled(CHANGE_REQUEST_LIFECYCLE_BADGE_FLAG)
  const monitor = suppliedMonitor ?? (api ? getChangeRequestMonitor(api) : null)
  const root = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const urls = [
    ...new Set(
      badges.flatMap(badge => {
        const target = badge.url
          ? linkedChangeRequestTarget(LOCAL_WORKBENCH_DEVICE_ALIAS, badge.url)
          : null
        return target?.changeRequestUrl ? [target.changeRequestUrl] : []
      })
    ),
  ]
    .sort()
    .join('\n')

  useEffect(() => {
    if (!monitor || !lookupEnabled || !urls || !root.current) return
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting))
    observer.observe(root.current)
    return () => observer.disconnect()
  }, [lookupEnabled, monitor, urls])

  const active = lookupEnabled && visible
  useEffect(() => {
    if (!active || !monitor || !urls) return
    const release = urls
      .split('\n')
      .map(url => monitor.register(linkedChangeRequestTarget(LOCAL_WORKBENCH_DEVICE_ALIAS, url)!))
    return () => release.forEach(stop => stop())
  }, [active, monitor, urls])

  const subscribe = useCallback(
    (listener: () => void) => monitor?.subscribe(listener) ?? (() => undefined),
    [monitor]
  )
  const getRevision = useCallback(() => monitor?.getRevision() ?? 0, [monitor])
  useSyncExternalStore(subscribe, getRevision, () => 0)
  const liveBadges = badges.map(badge => {
    if (!lookupEnabled || !monitor || !badge.url) return badge
    const target = linkedChangeRequestTarget(LOCAL_WORKBENCH_DEVICE_ALIAS, badge.url)
    if (!target) return badge
    const snapshot = monitor.getSnapshot(target)
    const request = snapshot?.changeRequest
    if (!request) {
      const provider = target.changeRequestUrl!.includes('/-/merge_requests/') ? 'gitlab' : 'github'
      const state =
        snapshot?.observation?.state === 'auth_required' ? 'unauthenticated' : snapshot?.lookupState
      const loading = !snapshot || snapshot.observation?.state === 'refreshing'
      const tooltip = loading
        ? t('todo.issue_pr_loading')
        : t(
            `workbench.environment_change_request_${state === 'unavailable' || state === 'unauthenticated' ? state : 'error'}_${provider}`
          )
      if (!snapshot || !lifecycleBadgeEnabled) {
        return { ...badge, tooltip, icon: loading ? 'loader' : badge.icon }
      }
      return {
        ...badge,
        ...visuals.unknown,
        label: `${badge.label} · ${t('workbench.change_request_badge_unknown')}`,
        tooltip,
      }
    }
    const status = changeRequestVisualStatus(request)
    const statusLabel = t(`workbench.change_request_status_${status}`)
    const reviewDecision = request.reviewDecision ?? 'none'
    const mergeStateStatus = request.mergeStateStatus ?? 'unknown'
    const updatedAt = request.updatedAt ? new Date(request.updatedAt) : null
    const updatedLabel =
      updatedAt && !Number.isNaN(updatedAt.getTime()) ? updatedAt.toLocaleString() : null
    const tooltip = lifecycleBadgeEnabled
      ? [
          request.title,
          statusLabel,
          `${t('workbench.change_request_detail_review')}: ${t(`workbench.change_request_review_${reviewDecision}`)}`,
          `${t('workbench.change_request_detail_merge_state')}: ${t(`workbench.change_request_merge_state_${mergeStateStatus}`)}`,
          request.mergeQueueReason
            ? `${t('workbench.change_request_detail_queue_reason')}: ${request.mergeQueueReason}`
            : null,
          request.headSha
            ? `${t('workbench.change_request_detail_head_sha')}: ${request.headSha.slice(0, 12)}`
            : null,
          updatedLabel ? `${t('workbench.change_request_detail_updated')}: ${updatedLabel}` : null,
          snapshot?.stale ? t('workbench.change_request_status_stale') : null,
          snapshot?.observation ? t(observationLabelKey(snapshot.observation)) : null,
        ]
      : [
          request.title,
          statusLabel,
          snapshot?.stale ? t('workbench.change_request_status_stale') : null,
          snapshot?.observation ? t(observationLabelKey(snapshot.observation)) : null,
        ]
    const shortStatus = lifecycleBadgeEnabled ? t(`workbench.change_request_badge_${status}`) : null
    const staleLabel =
      lifecycleBadgeEnabled && snapshot?.stale
        ? ` · ${t('workbench.change_request_badge_stale')}`
        : ''
    return {
      ...badge,
      ...(lifecycleBadgeEnabled ? visuals[status] : legacyVisuals[status]),
      label: shortStatus ? `${badge.label} · ${shortStatus}${staleLabel}` : badge.label,
      tooltip: tooltip.filter(Boolean).join(' · '),
    }
  })

  if (!badges.length) return null
  return (
    <div ref={root} className="min-w-0">
      <IssueBadges badges={liveBadges} compact={compact} testId={testId} />
    </div>
  )
}
