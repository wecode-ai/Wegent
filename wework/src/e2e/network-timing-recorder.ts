const MAX_ENTRIES = 250

function snapshot(entry: PerformanceEntry) {
  const timing = entry as PerformanceResourceTiming
  return {
    path: new URL(timing.name, location.href).pathname,
    initiatorType: timing.initiatorType,
    startTime: timing.startTime,
    duration: timing.duration,
    fetchStart: timing.fetchStart,
    connectStart: timing.connectStart,
    connectEnd: timing.connectEnd,
    requestStart: timing.requestStart,
    responseStart: timing.responseStart,
    responseEnd: timing.responseEnd,
    nextHopProtocol: timing.nextHopProtocol,
  }
}

// The browser's resource timeline stops retaining entries when its buffer fills.
// Observe deliveries so long checkpoints retain their most recent requests.
export function createNetworkTimingRecorder() {
  const entries: ReturnType<typeof snapshot>[] = []
  const append = (batch: PerformanceEntry[]) => {
    entries.push(...batch.map(snapshot))
    entries.splice(0, Math.max(0, entries.length - MAX_ENTRIES))
  }
  const observer = new PerformanceObserver(list => append(list.getEntries()))
  observer.observe({ type: 'resource', buffered: true })
  return () => {
    append(observer.takeRecords())
    return entries.slice()
  }
}
