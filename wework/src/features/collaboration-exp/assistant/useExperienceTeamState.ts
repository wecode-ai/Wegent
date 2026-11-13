import { useState } from 'react'
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
  const [refreshFailure, setRefreshFailure] = useState<{ scope: string; error: unknown }>()
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
    (state.runtimeWorkLoad.phase === 'error'
      ? state.runtimeWorkLoad.error || t('assistant.runtimeWorkUnavailable')
      : refreshFailure?.scope === source.scope && refreshFailure
        ? getStandInErrorMessage(refreshFailure.error)
        : null)
  const refresh = () => {
    source.refresh()
    source.inbox.refresh()
    setRefreshFailure(undefined)
    void refreshWorkLists().catch(cause => setRefreshFailure({ scope: source.scope, error: cause }))
  }
  return { source, ownerId, work, summary, snapshot, ready, error, refresh }
}
