import { useEffect, useSyncExternalStore } from 'react'
import { diagnosticPreferences } from '@/services/diagnosticPreferences'

export function useMobileDiagnostics() {
  const state = useSyncExternalStore(
    diagnosticPreferences.subscribe,
    diagnosticPreferences.snapshot
  )
  useEffect(() => {
    void diagnosticPreferences.load()
  }, [])
  return { ...state, change: diagnosticPreferences.change, retry: diagnosticPreferences.retry }
}
