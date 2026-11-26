import { useWorkbenchTaskReminders } from '@/features/workbench/runtimeTaskReminders'
import { useMemo, useRef, useState } from 'react'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { standInState } from '@/features/notifications/standInNotifications'
import { mergeStandInWorkItems, standInWorkRole } from '@/features/todo/standInWork'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { useTranslation } from '@/hooks/useTranslation'
import {
  selectAssistantSummary,
  selectExperienceWorkSnapshot,
  type ExperienceProjectData,
} from '../model'
import { useAssistantSources } from './useAssistantSources'

/** Both home surfaces read the same owned work and apply the same team semantics. */
export function useExperienceTeamState(
  active: boolean,
  projects: readonly ExperienceProjectData[]
) {
  const { state, refreshWorkLists } = useWorkbench()
  const runtimeTaskReminders = useWorkbenchTaskReminders()
  const { t } = useTranslation('collaborationExp')
  const source = useAssistantSources(active)
  const scope = source.scope
  const api = source.api
  const owner = useMemo(() => ({ active, scope, api }), [active, scope, api])
  const refreshGeneration = useRef(0)
  const [refreshState, setRefreshState] = useState<{
    owner: typeof owner
    failure?: { scope: string; api: typeof api; error: unknown }
  }>({ owner })
  if (refreshState.owner !== owner)
    setRefreshState({
      owner,
      failure:
        refreshState.failure?.scope === scope && refreshState.failure.api === api
          ? refreshState.failure
          : undefined,
    })
  const refreshFailure = refreshState.failure
  const ownerId = source.ownerId ?? source.userId
  const work = mergeStandInWorkItems(
    runtimeTaskReminders.items.filter(item => {
      const origin = item.task.runtimeHandle?.origin as Record<string, unknown> | undefined
      return standInWorkRole(item) !== null && origin?.userId === ownerId
    }),
    source.inbox.items,
    source.deviceId,
    projects.map(row => row.project)
  ).sort((a, b) => standInState(b).updatedAt.localeCompare(standInState(a).updatedAt))
  const summary = selectAssistantSummary({
    viewer: [source.userId, ownerId],
    settings: source.settings,
    proposals: source.proposals,
    inbox: source.inbox.items,
  })
  const snapshot = selectExperienceWorkSnapshot({
    roles: summary.roles,
    work,
    pendingDecisions: summary.pendingDecisions,
  })
  const ready =
    state.runtimeWork != null &&
    (state.runtimeWorkLoad.phase === 'ready' || state.runtimeWorkLoad.phase === 'refreshing') &&
    summary.state === 'ready' &&
    source.inboxReady &&
    source.inbox.sourceErrors.length === 0 &&
    source.proposalsReady === true
  const error =
    source.error ??
    (source.inbox.sourceErrors.length
      ? getStandInErrorMessage(source.inbox.sourceErrors[0].error)
      : null) ??
    (state.runtimeWorkLoad.phase === 'error'
      ? state.runtimeWorkLoad.error || t('assistant.runtimeWorkUnavailable')
      : refreshFailure?.scope === source.scope && refreshFailure.api === source.api
        ? getStandInErrorMessage(refreshFailure.error)
        : null)
  const refresh = () => {
    if (!active) return
    const generation = ++refreshGeneration.current
    source.refresh()
    source.inbox.refresh()
    setRefreshState(current => (current.owner === owner ? { owner } : current))
    void refreshWorkLists().catch(cause => {
      setRefreshState(current =>
        current.owner === owner && generation === refreshGeneration.current
          ? { owner, failure: { scope, api, error: cause } }
          : current
      )
    })
  }
  return { source, ownerId, work, summary, snapshot, ready, error, refresh }
}
