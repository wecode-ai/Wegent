import { useRuntimeTaskLifecycleStore } from '@/features/workbench/runtimeTaskLifecycle'
import { useScopedComposerAttachments } from '@/features/workbench/useScopedComposerAttachments'
import { useWorkbenchPaneContext } from '@/features/workbench/useWorkbench'
import { WorkbenchOwnerLeaseContext } from '@/features/workbench/workbenchContexts'
import { getRuntimeTaskChatScopeKey } from '@/features/workbench/workbenchProviderHelpers'
import { useTranslation } from '@/hooks/useTranslation'
import { useContext, useId, useState, useSyncExternalStore } from 'react'
import { createWorkbenchPaneSessionSource } from './workbenchPaneSessionSource'
import type { WorkbenchPaneSessionOptions } from './workbenchPaneSessionTypes'

export { runtimeTurnNavigationLoadOptions } from '@wegent/chat-core/runtime-transcript-page'
export { RUNTIME_RETRY_CONTINUATION_PROMPT } from './runtimeRetry'
export {
  resolveRuntimeTranscriptPageSize,
  rollbackRejectedRuntimeConversationTurn,
  runtimeTranscriptHasMoreBefore,
  scheduleRuntimeTurnNavigationLoad,
} from './workbenchPaneSessionHelpers'

export function useWorkbenchPaneSession({
  currentRuntimeTask,
  debugSnapshotEnabled = true,
}: WorkbenchPaneSessionOptions) {
  const queueDiagnosticSessionId = useId()
  const { t } = useTranslation('common')
  const [draftEditVersions] = useState(() => new Map<string, number>())
  const workbench = useWorkbenchPaneContext()
  const retainOwner = useContext(WorkbenchOwnerLeaseContext)
  const lifecycleStore = useRuntimeTaskLifecycleStore()
  const inputScopeKey = currentRuntimeTask
    ? getRuntimeTaskChatScopeKey(currentRuntimeTask)
    : workbench.projectChat.scopeKey
  const attachmentState = useScopedComposerAttachments(workbench.projectChat, inputScopeKey)
  const external = {
    t,
    draftEditVersions,
    currentRuntimeTask,
    debugSnapshotEnabled,
    queueDiagnosticSessionId,
    workbench,
    lifecycleStore,
    attachmentState,
  }
  const [owner, setOwner] = useState(() => createWorkbenchPaneSessionSource(external))
  let source = owner
  if (!source.matches(external)) {
    source = createWorkbenchPaneSessionSource(external)
    setOwner(source)
  }
  return useSyncExternalStore(
    listener => {
      const releaseOwner = retainOwner?.()
      const unsubscribe = source.subscribe(external, listener)
      return () => {
        unsubscribe()
        releaseOwner?.()
      }
    },
    source.getSnapshot,
    source.getSnapshot
  )
}
export type WorkbenchPaneSession = ReturnType<typeof useWorkbenchPaneSession>
