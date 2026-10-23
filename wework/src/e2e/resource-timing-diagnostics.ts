export function recentResourceTimings(limit = 250, controlOnly = false) {
  return performance
    .getEntriesByType('resource')
    .filter(
      entry =>
        !controlOnly ||
        /\/(electron-host\/v1\/invoke|started|commands|results)$/.test(
          new URL(entry.name, location.href).pathname
        )
    )
    .slice(-limit)
    .map(entry => {
      const timing = entry as PerformanceResourceTiming
      const url = new URL(timing.name, location.href)
      return {
        origin: url.origin,
        path: url.pathname,
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
    })
}
