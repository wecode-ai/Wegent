const MAX_NETWORK_TIMINGS = 200

type NetworkTiming = Pick<
  PerformanceResourceTiming,
  | 'initiatorType'
  | 'startTime'
  | 'duration'
  | 'fetchStart'
  | 'connectStart'
  | 'connectEnd'
  | 'requestStart'
  | 'responseStart'
  | 'responseEnd'
  | 'nextHopProtocol'
> & { path: string }

function readNetworkTiming(
  resource: PerformanceEntry,
  baseUrl: string,
  controlOrigin: string
): NetworkTiming | null {
  let url: URL
  try {
    url = new URL(resource.name, baseUrl)
  } catch {
    return null
  }
  const timing = resource as PerformanceResourceTiming
  const eventStream = /^\/wework\/(executor|terminal)\/v1\/events$/.test(url.pathname)
  if (
    resource.entryType !== 'resource' ||
    !['http:', 'https:'].includes(url.protocol) ||
    url.origin === controlOrigin ||
    (!['fetch', 'xmlhttprequest', 'eventsource'].includes(timing.initiatorType) && !eventStream)
  ) {
    return null
  }
  return {
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
}

export function createNetworkTimingCapture(baseUrl: string, controlUrl: string) {
  const entries: NetworkTiming[] = []
  const controlOrigin = new URL(controlUrl).origin
  let observer: PerformanceObserver | null = null
  let observerStatus: 'observing' | 'unavailable' | 'stopped' = 'unavailable'
  const append = (resources: PerformanceEntry[]) => {
    for (const resource of resources) {
      const timing = readNetworkTiming(resource, baseUrl, controlOrigin)
      if (timing) entries.push(timing)
    }
    entries.splice(0, Math.max(0, entries.length - MAX_NETWORK_TIMINGS))
  }
  try {
    observer = new PerformanceObserver(list => append(list.getEntries()))
    observer.observe({ type: 'resource', buffered: true })
    observerStatus = 'observing'
  } catch {
    observer?.disconnect()
    observer = null
  }
  return {
    snapshot() {
      if (observer) append(observer.takeRecords())
      return {
        entries: entries.map(entry => ({ ...entry })),
        timeOrigin: performance.timeOrigin,
        observerStatus,
        limit: MAX_NETWORK_TIMINGS,
        completedResourcesOnly: true,
      }
    },
    stop() {
      if (!observer) return
      append(observer.takeRecords())
      observer.disconnect()
      observer = null
      observerStatus = 'stopped'
    },
  }
}

export type NetworkTimingCapture = ReturnType<typeof createNetworkTimingCapture>
