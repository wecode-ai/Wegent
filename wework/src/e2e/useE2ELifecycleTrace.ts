import { useEffect, useId } from 'react'

/** Capture ownership transitions without logging drafts, configuration, or credentials. */
export function useE2ELifecycleTrace(component: string, state: object): void {
  const traceId = useId()
  const payload = import.meta.env.VITE_WEWORK_E2E === 'true' ? JSON.stringify(state) : ''
  useEffect(() => {
    if (import.meta.env.VITE_WEWORK_E2E !== 'true') return
    console.debug('[Wework] E2E lifecycle', { component, traceId, event: 'mounted' })
    return () => {
      console.debug('[Wework] E2E lifecycle', { component, traceId, event: 'unmounted' })
    }
  }, [component, traceId])
  useEffect(() => {
    if (!payload) return
    console.debug('[Wework] E2E lifecycle', { component, traceId, event: 'state', payload })
  }, [component, traceId, payload])
}
