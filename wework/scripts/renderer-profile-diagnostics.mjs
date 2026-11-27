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

// This function is serialized into the renderer; keep the static E2E key self-contained.
export function readRendererCatalogActivity() {
  const counters = globalThis[Symbol.for('wework:e2e:plugin-activity')]?.total
  return {
    started: counters?.started ?? 0,
    completed: counters?.completed ?? 0,
    failed: counters?.failed ?? 0,
    pending: counters?.pending ?? 0,
  }
}
