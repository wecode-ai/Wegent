let nextTraceId = 0

/** Capture actual owner commits without logging drafts, configuration, or credentials. */
export function createE2ELifecycleTrace(component: string) {
  const traceId = `${component}:${++nextTraceId}`
  let mounted = false
  let payload = ''
  return {
    update(state: object) {
      if (import.meta.env.VITE_WEWORK_E2E !== 'true') return
      if (!mounted) {
        mounted = true
        console.debug('[Wework] E2E lifecycle', { component, traceId, event: 'mounted' })
      }
      const nextPayload = JSON.stringify(state)
      if (payload === nextPayload) return
      payload = nextPayload
      console.debug('[Wework] E2E lifecycle', { component, traceId, event: 'state', payload })
    },
    dispose() {
      if (!mounted) return
      mounted = false
      payload = ''
      console.debug('[Wework] E2E lifecycle', { component, traceId, event: 'unmounted' })
    },
  }
}
