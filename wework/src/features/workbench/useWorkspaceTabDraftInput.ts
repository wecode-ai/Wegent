import { useCallback, useLayoutEffect, useState } from 'react'
import { useDocumentEvent, useWindowEvent } from '@wegent/collaboration/dom-events'
import {
  consumeWorkspaceTabTransfer,
  publishWorkspaceTabTransferState,
  WORKSPACE_TAB_TRANSFER_ACCEPTED_EVENT,
} from '@/features/workspace-tabs/workspaceTabTransfer'
import { createScopedDraftStore } from './scopedDraftStore'

const STANDALONE_CHAT_KEY_STORAGE_PREFIX = 'wework.composerStandaloneChatKey.v1'

function standaloneChatKeyStorageKey(storageScope?: string): string | undefined {
  return storageScope
    ? `${STANDALONE_CHAT_KEY_STORAGE_PREFIX}:${encodeURIComponent(storageScope)}`
    : undefined
}

function readStandaloneChatKey(storageScope?: string): number {
  const key = standaloneChatKeyStorageKey(storageScope)
  if (!key) return 0
  try {
    const value = Number(localStorage.getItem(key))
    return Number.isSafeInteger(value) && value >= 0 ? value : 0
  } catch {
    return 0
  }
}

function persistStandaloneChatKey(storageScope: string | undefined, value: number): void {
  const key = standaloneChatKeyStorageKey(storageScope)
  if (!key) return
  try {
    localStorage.setItem(key, String(value))
  } catch {
    // Draft persistence still works for the current session when storage is unavailable.
  }
}

export function useWorkspaceTabDraftInput(workspaceTabId?: string, accountScope?: string) {
  const [draftSession] = useState(() => {
    const storageScope = accountScope
      ? JSON.stringify([accountScope, workspaceTabId ?? 'main'])
      : undefined
    return {
      storageScope,
      draftStore: createScopedDraftStore({ storageScope }),
      initialStandaloneChatKey: readStandaloneChatKey(storageScope),
    }
  })
  const { draftStore, storageScope, initialStandaloneChatKey } = draftSession
  const [goalDraftActiveByScope, setGoalDraftActiveByScope] = useState<Record<string, boolean>>({})
  const persistCurrentStandaloneChatKey = useCallback(
    (value: number) => persistStandaloneChatKey(storageScope, value),
    [storageScope]
  )
  useLayoutEffect(() => () => draftStore.flush(), [draftStore])
  useWindowEvent('pagehide', () => draftStore.flush())
  useDocumentEvent('visibilitychange', () => {
    if (document.visibilityState === 'hidden') draftStore.flush()
  })
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
  return {
    draftStore,
    goalDraftActiveByScope,
    setGoalDraftActiveForScope,
    initialStandaloneChatKey,
    persistStandaloneChatKey: persistCurrentStandaloneChatKey,
  }
}
