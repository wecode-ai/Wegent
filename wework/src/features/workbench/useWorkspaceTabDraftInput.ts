import { useCallback, useLayoutEffect, useState } from 'react'
import {
  consumeWorkspaceTabTransfer,
  publishWorkspaceTabTransferState,
  WORKSPACE_TAB_TRANSFER_ACCEPTED_EVENT,
} from '@/features/workspace-tabs/workspaceTabTransfer'
import { createScopedDraftStore } from './scopedDraftStore'

export function useWorkspaceTabDraftInput(workspaceTabId?: string) {
  const [draftStore] = useState(createScopedDraftStore)
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
        draftStore.restore(transfer.draftInputByScope)
        setGoalDraftActiveByScope(transfer.goalDraftActiveByScope ?? {})
      }
    }
    const accept = (event: Event) => {
      if ((event as CustomEvent<string>).detail === workspaceTabId) restore()
    }
    restore()
    window.addEventListener(WORKSPACE_TAB_TRANSFER_ACCEPTED_EVENT, accept)
    return () => window.removeEventListener(WORKSPACE_TAB_TRANSFER_ACCEPTED_EVENT, accept)
  }, [draftStore, workspaceTabId])
  useLayoutEffect(() => {
    if (!workspaceTabId) return
    // A hidden tab can still be popped out from the tab strip.
    publishWorkspaceTabTransferState(workspaceTabId, {
      get draftInputByScope() {
        return draftStore.exportInputs()
      },
      goalDraftActiveByScope,
    })
  }, [draftStore, goalDraftActiveByScope, workspaceTabId])
  return { draftStore, goalDraftActiveByScope, setGoalDraftActiveForScope }
}
