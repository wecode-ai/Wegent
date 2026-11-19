import { useCallback, useContext, useMemo, useSyncExternalStore } from 'react'
import { subscribeIdleResource } from '@wegent/chat-core/async-resource'
import { LOCAL_USER } from '@/api/local/localSession'
import { CloudConnectionContext } from '@/features/cloud-connection/CloudConnectionContext'
import { useWorkbench } from '@/features/workbench/useWorkbench'
import { useStandInInbox } from '@/features/todo/useStandInInbox'
import { getStandInErrorMessage } from '@/lib/stand-in-error-message'
import { createAssistantSourcesModel } from './assistantSourcesModel'

export function useAssistantSources(active: boolean, includeProposals = true) {
  const { services, state } = useWorkbench()
  const cloud = useContext(CloudConnectionContext)
  const userId = Number(state.user?.id ?? LOCAL_USER.id)
  const backendUrl = cloud?.apiBaseUrl ?? ''
  const scope = JSON.stringify([userId, backendUrl])
  const api = services.standInApi
  const model = useMemo(
    () => createAssistantSourcesModel(services, api, userId, scope),
    [services, api, userId, scope]
  )
  const subscribe = useCallback(
    (listener: () => void) => model.subscribe(listener, includeProposals),
    [model, includeProposals]
  )
  const snapshot = useSyncExternalStore(
    active ? subscribe : subscribeIdleResource,
    model.getSnapshot,
    model.getSnapshot
  )
  const source = snapshot.source
  const ownerId = source?.ownerId ?? userId
  const deviceId = source?.deviceId
  const inbox = useStandInInbox(api, ownerId, deviceId, active, scope)
  const failure = snapshot.failure ?? snapshot.proposalFailure
  return {
    ...source,
    scope,
    userId,
    loading: active && Boolean(api) && !source && !snapshot.failure,
    error: !api
      ? getStandInErrorMessage({ code: 'executor_unavailable' })
      : failure
        ? getStandInErrorMessage(failure.cause)
        : inbox.error,
    inbox,
    inboxReady: Boolean(deviceId && inbox.scope === `${ownerId}:${deviceId}`),
    refresh: model.refresh,
  }
}
