import { useLayoutEffect } from 'react'
import {
  consumeWorkspaceTabTransfer,
  publishWorkspaceTabTransferState,
  WORKSPACE_TAB_TRANSFER_ACCEPTED_EVENT,
} from '@/features/workspace-tabs/workspaceTabTransfer'
import { useScopedDraftInput } from './useScopedDraftInput'

export function useWorkspaceTabDraftInput(workspaceTabId?: string) {
  const draft = useScopedDraftInput(() => ({}))
  const { inputs, replaceInputs } = draft
  useLayoutEffect(() => {
    if (!workspaceTabId) return
    const restore = () => {
      const transfer = consumeWorkspaceTabTransfer(workspaceTabId)
      if (transfer) replaceInputs(transfer.draftInputByScope)
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
    publishWorkspaceTabTransferState(workspaceTabId, { draftInputByScope: inputs })
  }, [inputs, workspaceTabId])
  return draft
}
