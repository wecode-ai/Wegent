type PluginActivityKind = 'catalog' | 'refresh' | 'enrichment'
interface PluginActivityCounters {
  started: number
  completed: number
  failed: number
  pending: number
}
interface PluginActivityState {
  total: PluginActivityCounters
  byKind: Record<PluginActivityKind, PluginActivityCounters>
}

const emptyCounters = (): PluginActivityCounters => ({
  started: 0,
  completed: 0,
  failed: 0,
  pending: 0,
})

/** Observe scheduled operations without changing product scheduling or retaining payloads. */
export function beginPluginRefreshDiagnostics(
  kind: PluginActivityKind
): ((phase?: 'completed' | 'failed') => void) | undefined {
  if (
    !(import.meta.env.MODE === 'e2e' || import.meta.env.VITE_WEWORK_E2E === 'true') ||
    typeof performance.mark !== 'function'
  )
    return undefined
  const namespace =
    kind === 'catalog' ? 'wework:plugin-local-catalog' : `wework:plugin-composer-${kind}`
  const host = globalThis as typeof globalThis & { [key: symbol]: PluginActivityState | undefined }
  const key = Symbol.for('wework:e2e:plugin-activity')
  const state = (host[key] ??= {
    total: emptyCounters(),
    byKind: { catalog: emptyCounters(), refresh: emptyCounters(), enrichment: emptyCounters() },
  })
  const counters = state.byKind[kind]
  const startedAt = performance.mark(`${namespace}:started`).startTime
  state.total.started++
  state.total.pending++
  counters.started++
  counters.pending++
  let settled = false
  return (phase = 'completed') => {
    if (settled) return
    settled = true
    performance.mark(`${namespace}:${phase}`, { detail: startedAt })
    state.total[phase]++
    state.total.pending--
    counters[phase]++
    counters.pending--
  }
}
