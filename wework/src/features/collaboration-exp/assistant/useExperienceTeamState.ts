import { useEffect, useRef, useState } from 'react'
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
  const { runtimeTaskReminders, state, refreshWorkLists } = useWorkbench()
  const { t } = useTranslation('collaborationExp')
  const source = useAssistantSources(active)
  const [refreshFailure, setRefreshFailure] = useState<{
    scope: string
    api: typeof source.api
    error: unknown
  }>()
  const refreshGeneration = useRef(0)
  useEffect(() => {
    refreshGeneration.current += 1
    return () => {
      refreshGeneration.current += 1
    }
  }, [active, source.scope, source.api])
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
    setRefreshFailure(undefined)
    void refreshWorkLists().catch(cause => {
      if (generation === refreshGeneration.current)
        setRefreshFailure({ scope: source.scope, api: source.api, error: cause })
    })
  }
  return { source, ownerId, work, summary, snapshot, ready, error, refresh }
}
