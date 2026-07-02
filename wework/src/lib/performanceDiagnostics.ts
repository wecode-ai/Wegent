const PERFORMANCE_DIAGNOSTICS_STORAGE_KEY = 'wework:perf-debug'
const PERFORMANCE_DIAGNOSTICS_QUERY_PARAM = 'weworkPerf'
const TOGGLE_SHORTCUT_KEY = 'P'
const MAX_EVENTS = 300
const SAMPLE_INTERVAL_MS = 5000
const EVENT_LOOP_SAMPLE_INTERVAL_MS = 1000
const EVENT_LOOP_LAG_WARN_MS = 120
const SLOW_REACT_COMMIT_MS = 24

type DiagnosticsEventType = 'sample' | 'longtask' | 'event-loop-lag' | 'react-commit' | 'mark'

interface DiagnosticsEvent {
  type: DiagnosticsEventType
  timestamp: number
  data: Record<string, unknown>
}

interface MemorySnapshot {
  usedJSHeapSize?: number
  totalJSHeapSize?: number
  jsHeapSizeLimit?: number
}

interface DiagnosticsSnapshot {
  timestamp: number
  url: string
  visibilityState: DocumentVisibilityState
  domNodeCount: number
  activeElement: string | null
  memory: MemorySnapshot | null
  resourceCount: number
  navigation: Record<string, number | string | null>
  recentEvents: DiagnosticsEvent[]
}

export interface PerformanceDiagnosticsController {
  enabled: boolean
  mark: (name: string, data?: Record<string, unknown>) => void
  snapshot: () => DiagnosticsSnapshot
  stop: () => void
  getEvents: () => DiagnosticsEvent[]
}

declare global {
  interface Window {
    __WEWORK_PERF__?: PerformanceDiagnosticsController
  }

  interface Performance {
    memory?: MemorySnapshot
  }
}

let controller: PerformanceDiagnosticsController | null = null

export function installPerformanceDiagnosticsToggle() {
  window.addEventListener('keydown', handlePerformanceDiagnosticsToggleKeyDown, {
    capture: true,
  })
}

export function isPerformanceDiagnosticsEnabled(): boolean {
  const queryValue = new URLSearchParams(window.location.search).get(
    PERFORMANCE_DIAGNOSTICS_QUERY_PARAM
  )
  if (queryValue === '1' || queryValue === 'true') {
    localStorage.setItem(PERFORMANCE_DIAGNOSTICS_STORAGE_KEY, '1')
    return true
  }
  if (queryValue === '0' || queryValue === 'false') {
    localStorage.removeItem(PERFORMANCE_DIAGNOSTICS_STORAGE_KEY)
    return false
  }

  return (
    localStorage.getItem(PERFORMANCE_DIAGNOSTICS_STORAGE_KEY) === '1' ||
    import.meta.env.VITE_WEWORK_PERF_DEBUG === '1'
  )
}

function handlePerformanceDiagnosticsToggleKeyDown(event: KeyboardEvent) {
  if (!event.shiftKey || !event.altKey || !(event.metaKey || event.ctrlKey)) return
  if (event.code !== `Key${TOGGLE_SHORTCUT_KEY}`) return

  event.preventDefault()
  event.stopPropagation()

  const enabled = localStorage.getItem(PERFORMANCE_DIAGNOSTICS_STORAGE_KEY) === '1'
  if (enabled) {
    localStorage.removeItem(PERFORMANCE_DIAGNOSTICS_STORAGE_KEY)
    console.info('[Wework perf] diagnostics disabled. Reloading...')
  } else {
    localStorage.setItem(PERFORMANCE_DIAGNOSTICS_STORAGE_KEY, '1')
    console.info('[Wework perf] diagnostics enabled. Reloading...')
  }
  window.location.reload()
}

export function installPerformanceDiagnostics(): PerformanceDiagnosticsController | null {
  if (!isPerformanceDiagnosticsEnabled()) return null
  if (controller) return controller

  const events: DiagnosticsEvent[] = []
  const cleanupCallbacks: Array<() => void> = []
  let stopped = false

  const pushEvent = (type: DiagnosticsEventType, data: Record<string, unknown>) => {
    if (stopped) return
    const event = {
      type,
      timestamp: Date.now(),
      data,
    }
    events.push(event)
    while (events.length > MAX_EVENTS) {
      events.shift()
    }
    if (type !== 'sample') {
      console.warn('[Wework perf]', type, data)
    }
  }

  const snapshot = (): DiagnosticsSnapshot => ({
    timestamp: Date.now(),
    url: window.location.href,
    visibilityState: document.visibilityState,
    domNodeCount: document.getElementsByTagName('*').length,
    activeElement: describeElement(document.activeElement),
    memory: getMemorySnapshot(),
    resourceCount: performance.getEntriesByType('resource').length,
    navigation: getNavigationSnapshot(),
    recentEvents: [...events],
  })

  controller = {
    enabled: true,
    mark: (name, data = {}) => pushEvent('mark', { name, ...data }),
    snapshot,
    stop: () => {
      stopped = true
      cleanupCallbacks.splice(0).forEach(cleanup => cleanup())
      if (window.__WEWORK_PERF__ === controller) {
        delete window.__WEWORK_PERF__
      }
      controller = null
    },
    getEvents: () => [...events],
  }
  window.__WEWORK_PERF__ = controller

  installLongTaskObserver(pushEvent, cleanupCallbacks)
  installPeriodicSampler(pushEvent, cleanupCallbacks)
  installEventLoopLagSampler(pushEvent, cleanupCallbacks)

  console.info(
    '[Wework perf] diagnostics enabled. Use window.__WEWORK_PERF__.snapshot() to inspect current state.'
  )
  return controller
}

export function recordReactCommit(
  id: string,
  phase: string,
  actualDuration: number,
  baseDuration: number,
  startTime: number,
  commitTime: number
) {
  if (!controller || actualDuration < SLOW_REACT_COMMIT_MS) return

  controller.mark('slow-react-commit', {
    id,
    phase,
    actualDuration: Math.round(actualDuration * 10) / 10,
    baseDuration: Math.round(baseDuration * 10) / 10,
    startTime: Math.round(startTime * 10) / 10,
    commitTime: Math.round(commitTime * 10) / 10,
  })
}

function installLongTaskObserver(
  pushEvent: (type: DiagnosticsEventType, data: Record<string, unknown>) => void,
  cleanupCallbacks: Array<() => void>
) {
  if (typeof PerformanceObserver === 'undefined') return

  try {
    const observer = new PerformanceObserver(list => {
      list.getEntries().forEach(entry => {
        pushEvent('longtask', {
          name: entry.name,
          duration: Math.round(entry.duration * 10) / 10,
          startTime: Math.round(entry.startTime * 10) / 10,
        })
      })
    })
    observer.observe({ type: 'longtask', buffered: true })
    cleanupCallbacks.push(() => observer.disconnect())
  } catch (error) {
    console.warn('[Wework perf] long task observer unavailable', error)
  }
}

function installPeriodicSampler(
  pushEvent: (type: DiagnosticsEventType, data: Record<string, unknown>) => void,
  cleanupCallbacks: Array<() => void>
) {
  const sample = () => {
    pushEvent('sample', {
      memory: getMemorySnapshot(),
      domNodeCount: document.getElementsByTagName('*').length,
      resourceCount: performance.getEntriesByType('resource').length,
      visibilityState: document.visibilityState,
      path: window.location.pathname,
    })
  }

  sample()
  const timer = window.setInterval(sample, SAMPLE_INTERVAL_MS)
  cleanupCallbacks.push(() => window.clearInterval(timer))
}

function installEventLoopLagSampler(
  pushEvent: (type: DiagnosticsEventType, data: Record<string, unknown>) => void,
  cleanupCallbacks: Array<() => void>
) {
  let expectedAt = performance.now() + EVENT_LOOP_SAMPLE_INTERVAL_MS
  const timer = window.setInterval(() => {
    const now = performance.now()
    const lag = now - expectedAt
    expectedAt = now + EVENT_LOOP_SAMPLE_INTERVAL_MS
    if (lag < EVENT_LOOP_LAG_WARN_MS) return

    pushEvent('event-loop-lag', {
      lag: Math.round(lag * 10) / 10,
      visibilityState: document.visibilityState,
      path: window.location.pathname,
    })
  }, EVENT_LOOP_SAMPLE_INTERVAL_MS)

  cleanupCallbacks.push(() => window.clearInterval(timer))
}

function getMemorySnapshot(): MemorySnapshot | null {
  if (!performance.memory) return null
  return {
    usedJSHeapSize: performance.memory.usedJSHeapSize,
    totalJSHeapSize: performance.memory.totalJSHeapSize,
    jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
  }
}

function getNavigationSnapshot(): Record<string, number | string | null> {
  const navigation = performance.getEntriesByType('navigation')[0]
  if (!navigation) return {}

  const entry = navigation as PerformanceNavigationTiming
  return {
    type: entry.type,
    domInteractive: roundTiming(entry.domInteractive),
    domComplete: roundTiming(entry.domComplete),
    loadEventEnd: roundTiming(entry.loadEventEnd),
    responseEnd: roundTiming(entry.responseEnd),
  }
}

function roundTiming(value: number): number | null {
  if (!Number.isFinite(value) || value <= 0) return null
  return Math.round(value * 10) / 10
}

function describeElement(element: Element | null): string | null {
  if (!element) return null

  const id = element.id ? `#${element.id}` : ''
  const testId = element.getAttribute('data-testid')
  const testIdPart = testId ? `[data-testid="${testId}"]` : ''
  return `${element.tagName.toLowerCase()}${id}${testIdPart}`
}
