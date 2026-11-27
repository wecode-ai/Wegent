/** Observe already scheduled composer refreshes without delaying the product flow. */
export function beginPluginRefreshDiagnostics(
  kind: 'refresh' | 'enrichment'
): (() => void) | undefined {
  if (
    !(import.meta.env.MODE === 'e2e' || import.meta.env.VITE_WEWORK_E2E === 'true') ||
    typeof performance.mark !== 'function'
  )
    return undefined
  const namespace = `wework:plugin-composer-${kind}`
  const startedAt = performance.mark(`${namespace}:started`).startTime
  let settled = false
  return () => {
    if (settled) return
    settled = true
    performance.mark(`${namespace}:completed`, { detail: startedAt })
  }
}
