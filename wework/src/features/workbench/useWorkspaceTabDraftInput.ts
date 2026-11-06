import { useCallback, useLayoutEffect, useState } from 'react'
import {
  consumeWorkspaceTabTransfer,
  publishWorkspaceTabTransferState,
  WORKSPACE_TAB_TRANSFER_ACCEPTED_EVENT,
} from '@/features/workspace-tabs/workspaceTabTransfer'
import { useScopedDraftInput } from './useScopedDraftInput'

export function useWorkspaceTabDraftInput(workspaceTabId?: string) {
  const draft = useScopedDraftInput(() => ({}))
  const { inputs, replaceInputs } = draft
  const [goalDraftActiveByScope, setGoalDraftActiveByScope] = useState<Record<string, boolean>>({})
  const setGoalDraftActiveForScope = useCallback((scopeKey: string, active: boolean) => {
    setGoalDraftActiveByScope(current => {
      if (Boolean(current[scopeKey]) === active) return current
      const next = { ...current }
      if (active) next[scopeKey] = true
      else delete next[scopeKey]
      return next
    })
  }, [])
  useLayoutEffect(() => {
    if (!workspaceTabId) return
    const restore = () => {
      const transfer = consumeWorkspaceTabTransfer(workspaceTabId)
      if (transfer) {
        replaceInputs(transfer.draftInputByScope)
        setGoalDraftActiveByScope(transfer.goalDraftActiveByScope ?? {})
      }
    }
    const accept = (event: Event) => {
      if ((event as CustomEvent<string>).detail === workspaceTabId) restore()
    }
    restore()
    window.addEventListener(WORKSPACE_TAB_TRANSFER_ACCEPTED_EVENT, accept)
    return () => window.removeEventListener(WORKSPACE_TAB_TRANSFER_ACCEPTED_EVENT, accept)
  }, [replaceInputs, workspaceTabId])
  useLayoutEffect(() => {
    if (!workspaceTabId) return
    publishWorkspaceTabTransferState(workspaceTabId, {
      draftInputByScope: inputs,
      goalDraftActiveByScope,
    })
  }, [goalDraftActiveByScope, inputs, workspaceTabId])
  return { ...draft, goalDraftActiveByScope, setGoalDraftActiveForScope }
}
