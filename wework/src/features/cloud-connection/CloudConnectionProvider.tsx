import { useCallback, useState, useSyncExternalStore, type ReactNode } from 'react'
import { useDOMEvent, useWindowEvent } from '@wegent/collaboration/dom-events'
import { DESKTOP_E2E_CLOUD_SESSION_CHANGED_EVENT } from '@/e2e/runtime-config'
import { useTranslation } from '@/hooks/useTranslation'
import { CloudConnectionContext } from './CloudConnectionContext'
import { createCloudConnectionSession } from './cloudConnectionSession'

export function CloudConnectionProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation('common')
  const [source] = useState(() => createCloudConnectionSession(t))
  const subscribe = useCallback((notify: () => void) => source.subscribe(notify, t), [source, t])
  const value = useSyncExternalStore(subscribe, source.getSnapshot, source.getSnapshot)
  useWindowEvent('online', source.resume)
  useDOMEvent('window', DESKTOP_E2E_CLOUD_SESSION_CHANGED_EVENT, source.restoreSelectedSession, {
    enabled: import.meta.env.VITE_WEWORK_E2E === 'true',
  })
  return <CloudConnectionContext.Provider value={value}>{children}</CloudConnectionContext.Provider>
}
