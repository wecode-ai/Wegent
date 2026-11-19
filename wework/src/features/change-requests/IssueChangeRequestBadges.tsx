import { useIntersectionEvent } from '@wegent/collaboration/dom-events'
import { useCallback, useRef, useState, useSyncExternalStore } from 'react'
import type { CollaborationIssueBadge } from '@wegent/collaboration'
import { linkedChangeRequestTarget } from '@/api/changeRequests'
import type { DeviceCommandApi } from '@/api/environment'
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

const visuals: Record<ChangeRequestVisualStatus, Pick<CollaborationIssueBadge, 'icon' | 'tone'>> = {
  draft: { icon: 'git-pull-request', tone: 'neutral' },
  open: { icon: 'git-pull-request', tone: 'success' },
  checks_pending: { icon: 'clock', tone: 'warning' },
  checks_passed: { icon: 'circle-check', tone: 'success' },
  checks_failed: { icon: 'circle-x', tone: 'danger' },
  merge_conflict: { icon: 'warning', tone: 'danger' },
  merge_queue_queued: { icon: 'clock', tone: 'warning' },
  merge_queue_checking: { icon: 'loader', tone: 'warning' },
  merge_queue_failed: { icon: 'circle-x', tone: 'danger' },
  merge_queue_timed_out: { icon: 'clock', tone: 'danger' },
  merge_queue_conflicting: { icon: 'warning', tone: 'danger' },
  merge_queue_removed: { icon: 'git-pull-request', tone: 'neutral' },
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

  const observeVisibility = useCallback(
    ([entry]: IntersectionObserverEntry[]) => {
      if (monitor && lookupEnabled && urls) setVisible(entry.isIntersecting)
    },
    [monitor, lookupEnabled, urls]
  )
  useIntersectionEvent(root, observeVisibility, {
    enabled: Boolean(monitor && lookupEnabled && urls),
  })

  const active = lookupEnabled && visible
  const subscribe = useCallback(
    (listener: () => void) => {
      const unsubscribe = monitor?.subscribe(listener)
      const releases =
        active && monitor && urls
          ? urls
              .split('\n')
              .map(url =>
                monitor.register(linkedChangeRequestTarget(LOCAL_WORKBENCH_DEVICE_ALIAS, url)!)
              )
          : []
      return () => {
        unsubscribe?.()
        releases.forEach(stop => stop())
      }
    },
    [monitor, active, urls]
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
      return { ...badge, tooltip, icon: loading ? 'loader' : badge.icon }
    }
    const status = changeRequestVisualStatus(request)
    const tooltip = [
      request.title,
      t(`workbench.change_request_status_${status}`),
      snapshot?.stale ? t('workbench.change_request_status_stale') : null,
      snapshot?.observation ? t(observationLabelKey(snapshot.observation)) : null,
    ]
      .filter(Boolean)
      .join(' · ')
    return { ...badge, ...visuals[status], tooltip }
  })

  if (!badges.length) return null
  return (
    <div ref={root} className="min-w-0">
      <IssueBadges badges={liveBadges} compact={compact} testId={testId} />
    </div>
  )
}
