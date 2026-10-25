import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
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
      const state = snapshot?.lookupState
      const tooltip = snapshot
        ? t(
            `workbench.environment_change_request_${state === 'unavailable' || state === 'unauthenticated' ? state : 'error'}_${provider}`
          )
        : t('todo.issue_pr_loading')
      return { ...badge, tooltip, icon: snapshot ? badge.icon : 'loader' }
    }
    const status = changeRequestVisualStatus(request)
    const tooltip = [
      request.title,
      t(`workbench.change_request_status_${status}`),
      snapshot?.stale ? t('workbench.change_request_status_stale') : null,
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
