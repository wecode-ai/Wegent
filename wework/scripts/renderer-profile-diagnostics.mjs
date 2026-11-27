const nativeCpuFrameCategories = new Map([
  ['(root)', 'root'],
  ['(program)', 'program'],
  ['(idle)', 'idle'],
  ['(garbage collector)', 'gc'],
])

function rendererCpuFrame(frame = {}, rendererOrigin) {
  let asset
  try {
    const url = new URL(frame?.url)
    if (['http:', 'https:'].includes(url.protocol) && url.origin === rendererOrigin)
      asset = /^\/wework\/app\/assets\/([A-Za-z0-9_.-]+-[A-Za-z0-9_-]{8}\.js)$/.exec(
        url.pathname
      )?.[1]
  } catch {}
  if (!asset) {
    return { category: nativeCpuFrameCategories.get(frame?.functionName) ?? 'non-application' }
  }
  return {
    category: 'application',
    asset,
    lineNumber: Number.isInteger(frame.lineNumber) ? frame.lineNumber : -1,
    columnNumber: Number.isInteger(frame.columnNumber) ? frame.columnNumber : -1,
  }
}

export function sanitizeRendererCpuProfile(profile, rendererOrigin) {
  const numbers = values => (Array.isArray(values) ? values.filter(Number.isSafeInteger) : [])
  return {
    startTime: Number.isFinite(profile.startTime) ? profile.startTime : null,
    endTime: Number.isFinite(profile.endTime) ? profile.endTime : null,
    nodes: profile.nodes
      .filter(node => Number.isSafeInteger(node.id))
      .map(node => ({
        id: node.id,
        callFrame: rendererCpuFrame(node.callFrame, rendererOrigin),
        children: numbers(node.children),
        ...(Number.isSafeInteger(node.hitCount) && { hitCount: node.hitCount }),
      })),
    samples: numbers(profile.samples),
    timeDeltas: numbers(profile.timeDeltas),
  }
}

// This function runs in the renderer; return only counters from existing marks.
export function readRendererCatalogActivity() {
  const namespaces = [
    'wework:plugin-local-catalog',
    'wework:plugin-composer-refresh',
    'wework:plugin-composer-enrichment',
  ]
  const entries = Object.fromEntries(
    ['started', 'completed', 'failed'].map(phase => [
      phase,
      namespaces.flatMap(namespace =>
        performance.getEntriesByName(namespace + ':' + phase, 'mark')
      ),
    ])
  )
  const pending = new Map()
  for (const entry of entries.started) {
    const key = `${entry.name.slice(0, entry.name.lastIndexOf(':'))}:${entry.startTime}`
    pending.set(key, (pending.get(key) ?? 0) + 1)
  }
  for (const entry of [...entries.completed, ...entries.failed]) {
    const key = `${entry.name.slice(0, entry.name.lastIndexOf(':'))}:${entry.detail}`
    const count = pending.get(key)
    if (count) pending.set(key, count - 1)
  }
  return {
    started: entries.started.length,
    completed: entries.completed.length,
    failed: entries.failed.length,
    pending: [...pending.values()].reduce((sum, count) => sum + count, 0),
  }
}
