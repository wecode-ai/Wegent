import { useCallback, useMemo, useState, useSyncExternalStore } from 'react'
import { useDOMEvent } from '@wegent/collaboration/dom-events'
import { useTranslation } from '@/hooks/useTranslation'
import type { WorkbenchMessage } from '@/types/workbench'
import { WORKBENCH_NEW_CHAT_STARTED_EVENT } from '@/lib/workbenchComposerFocus'
import { createLocalConnectorAuthRecoverySource } from './localConnectorAuthRecoverySource'
export type { PendingConnectorAuth } from './localConnectorAuthRecoverySource'

export function useLocalConnectorAuthRecovery(options: {
  messages: WorkbenchMessage[]
  onResumeSend: (input: string) => Promise<void> | void
  onError?: (message: string) => void
  active?: boolean
  cloudConnection?: { apiBaseUrl?: string | null; token?: string | null }
}) {
  const { t } = useTranslation('common')
  const [source] = useState(createLocalConnectorAuthRecoverySource)
  const view = source.observe({ ...options, t })
  const pending = useSyncExternalStore(view.subscribe, view.getSnapshot, view.getSnapshot)
  useDOMEvent('window', WORKBENCH_NEW_CHAT_STARTED_EVENT, source.clearPending)
  const completePending = useCallback(() => source.completePending(pending), [pending, source])
  return useMemo(
    () => ({ pending, clearPending: source.clearPending, completePending }),
    [pending, source, completePending]
  )
}
