import { useLayoutEffect, useMemo, useSyncExternalStore } from 'react'
import type { AssistantRequestAction, AssistantRequestsApi } from '@wegent/collaboration'
import {
  assistantRequestScopeStore,
  type AssistantRequestScope,
} from './assistantRequestScopeStore'

interface Input extends AssistantRequestScope {
  api: AssistantRequestsApi
  active: boolean
  revision: number
}

export function useAssistantRequests(input: Input) {
  const { api, projectId, issueId, userId, accountKey, active, revision } = input
  const store = useMemo(
    () => assistantRequestScopeStore({ accountKey, userId, projectId, issueId }),
    [accountKey, userId, projectId, issueId]
  )
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)
  useLayoutEffect(() => {
    if (active) return store.attach(api)
  }, [store, api, active, revision])
  return {
    ...snapshot,
    message: store.draft().text,
    start: (composer: Parameters<typeof store.openComposer>[0]) => store.openComposer(composer),
    close: () => store.closeComposer(),
    setMessage: (text: string) => store.setMessage(text),
    admit: () => active && store.admit(),
    retrySubmission: (clientId: string) => {
      if (active) store.retry(clientId)
    },
    busy: (requestId: string) => store.busy(requestId),
    submissionBusy: (clientId: string) => store.isInFlight(clientId),
    refresh: () => void store.refresh(),
    submit: (action: AssistantRequestAction) => active && store.submitControl(action),
    confirmMerge: (requestId: string, targetRevision: string, candidateRevision: string) =>
      active &&
      store.submitControl({
        action: 'confirm_merge',
        requestId,
        targetRevision,
        candidateRevision,
      }),
  }
}
