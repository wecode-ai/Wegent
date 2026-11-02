import { useEffect } from 'react'
import {
  consumeWorkspaceTabTransfer,
  publishWorkspaceTabTransferState,
  WORKSPACE_TAB_RECEIVED_EVENT,
} from '@/features/workspace-tabs/workspaceTabTransfer'
import { useScopedDraftInput } from './useScopedDraftInput'

export function useWorkspaceTabDraftInput(tabId?: string) {
  const draft = useScopedDraftInput(() =>
    tabId ? (consumeWorkspaceTabTransfer(tabId)?.draftInputByScope ?? {}) : {}
  )
  const { replaceInputs } = draft
  useEffect(() => {
    if (!tabId) return
    const receive = (event: Event) => {
      if ((event as CustomEvent<{ tabId: string }>).detail?.tabId !== tabId) return
      const transfer = consumeWorkspaceTabTransfer(tabId)
      if (transfer) replaceInputs(transfer.draftInputByScope)
    }
    window.addEventListener(WORKSPACE_TAB_RECEIVED_EVENT, receive)
    return () => window.removeEventListener(WORKSPACE_TAB_RECEIVED_EVENT, receive)
  }, [replaceInputs, tabId])
  useEffect(() => {
    if (tabId) publishWorkspaceTabTransferState(tabId, { draftInputByScope: draft.inputs })
  }, [draft.inputs, tabId])
  return draft
}
