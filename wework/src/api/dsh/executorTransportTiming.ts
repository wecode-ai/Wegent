interface ExecutorResourceTiming {
  duration: number
  fetchStart: number
  domainLookupStart: number
  domainLookupEnd: number
  connectStart: number
  connectEnd: number
  requestStart: number
  responseStart: number
  responseEnd: number
  serverTiming?: ReadonlyArray<{ name: string; description: string }>
}

function elapsed(start: number, end: number): number | null {
  return Number.isFinite(start) && Number.isFinite(end) && start > 0 && end >= start
    ? Math.round(end - start)
    : null
}

export function executorResourceTiming(
  entries: ReadonlyArray<ExecutorResourceTiming>,
  requestId: string
): Record<string, number | null> | null {
  // Concurrent RPCs share one URL; only the server's request id identifies this fetch.
  const entry = entries.find(candidate =>
    candidate.serverTiming?.some(
      timing => timing.name === 'wework-rpc' && timing.description === encodeURIComponent(requestId)
    )
  )
  if (!entry) return null
  return {
    durationMs:
      Number.isFinite(entry.duration) && entry.duration >= 0 ? Math.round(entry.duration) : null,
    beforeRequestMs: elapsed(entry.fetchStart, entry.requestStart),
    dnsMs: elapsed(entry.domainLookupStart, entry.domainLookupEnd),
    connectMs: elapsed(entry.connectStart, entry.connectEnd),
    responseWaitMs: elapsed(entry.requestStart, entry.responseStart),
    responseReadMs: elapsed(entry.responseStart, entry.responseEnd),
  }
}
