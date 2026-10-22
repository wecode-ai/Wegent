type SearchPerformanceEventName = 'search-long-task' | 'search-long-frame' | 'search-slow-script'

interface ScriptEntry {
  startTime?: number
  duration?: number
  executionStart?: number
  forcedStyleAndLayoutDuration?: number
  sourceURL?: string
  sourceFunctionName?: string
  sourceCharPosition?: number
  invokerType?: string
}

interface AnimationFrameEntry extends PerformanceEntry {
  blockingDuration?: number
  renderStart?: number
  styleAndLayoutStart?: number
  scripts?: ReadonlyArray<ScriptEntry>
}

type RecordPerformanceEvent = (
  name: SearchPerformanceEventName,
  details: Record<string, number | string>
) => void

const SCRIPT_INVOKER_TYPES = new Set([
  'user-callback',
  'event-listener',
  'resolve-promise',
  'reject-promise',
  'classic-script',
  'module-script',
])
const SCRIPT_ASSET_PATTERN = /^[A-Za-z0-9_.-]{1,150}-[A-Za-z0-9_-]{8}\.m?js$/
const SCRIPT_FUNCTION_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/

// Only compiler-generated asset names, function identifiers and browser enums may be retained.
export function sanitizeSearchScriptDetail(key: string, value: string): string | undefined {
  if (key === 'sourceAsset' && SCRIPT_ASSET_PATTERN.test(value)) return value
  if (key === 'sourceFunctionName' && value.length <= 100 && SCRIPT_FUNCTION_PATTERN.test(value))
    return value
  if (key === 'invokerType' && SCRIPT_INVOKER_TYPES.has(value)) return value
  return undefined
}

// Observe browser-provided timings only while the reader is editing a search query.
export function createConversationSearchPerformanceCapture(
  record: RecordPerformanceEvent,
  captureWindowMs: number
) {
  let observer: PerformanceObserver | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let captureUntil = 0

  const stop = () => {
    observer?.disconnect()
    observer = null
    if (timer !== null) clearTimeout(timer)
    timer = null
    captureUntil = 0
  }

  const capture = () => {
    if (typeof PerformanceObserver === 'undefined') return
    const entryTypes = ['longtask', 'long-animation-frame'].filter(type =>
      PerformanceObserver.supportedEntryTypes?.includes(type)
    )
    if (entryTypes.length === 0) return
    captureUntil = performance.now() + captureWindowMs
    if (!observer) {
      observer = new PerformanceObserver(list => {
        if (performance.now() >= captureUntil) return
        for (const entry of list.getEntries()) {
          if (entry.entryType === 'longtask') {
            record('search-long-task', {
              startTime: entry.startTime,
              elapsedMs: entry.duration,
            })
          } else if (entry.entryType === 'long-animation-frame') {
            const frame = entry as AnimationFrameEntry
            record('search-long-frame', animationFrameDetails(frame))
            recordSlowScripts(frame, record)
          }
        }
      })
      observer.observe({ entryTypes })
    }
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(stop, captureWindowMs)
  }

  return { capture, stop }
}

function recordSlowScripts(entry: AnimationFrameEntry, record: RecordPerformanceEvent): void {
  const scripts = [...(entry.scripts ?? [])]
    .filter(
      script => (script.forcedStyleAndLayoutDuration ?? 0) >= 16 || (script.duration ?? 0) >= 50
    )
    .sort(
      (left, right) =>
        (right.forcedStyleAndLayoutDuration ?? 0) - (left.forcedStyleAndLayoutDuration ?? 0) ||
        (right.duration ?? 0) - (left.duration ?? 0)
    )
    .slice(0, 3)
  for (const script of scripts) {
    const details: Record<string, number | string> = { frameStartTime: entry.startTime }
    for (const key of [
      'startTime',
      'duration',
      'executionStart',
      'forcedStyleAndLayoutDuration',
      'sourceCharPosition',
    ] as const) {
      const value = script[key]
      if (typeof value === 'number' && value >= 0 && Number.isFinite(value)) {
        details[key === 'duration' ? 'elapsedMs' : key] = value
      }
    }
    const asset = script.sourceURL?.match(/\/assets\/([^/?#]+)(?:[?#]|$)/)?.[1]
    if (asset && sanitizeSearchScriptDetail('sourceAsset', asset)) {
      details.sourceAsset = asset
      const name = sanitizeSearchScriptDetail('sourceFunctionName', script.sourceFunctionName ?? '')
      if (name) details.sourceFunctionName = name
    }
    const invokerType = sanitizeSearchScriptDetail('invokerType', script.invokerType ?? '')
    if (invokerType) details.invokerType = invokerType
    record('search-slow-script', details)
  }
}

function animationFrameDetails(entry: AnimationFrameEntry): Record<string, number> {
  const details: Record<string, number> = {
    startTime: entry.startTime,
    elapsedMs: entry.duration,
  }
  if (typeof entry.blockingDuration === 'number') details.blockingDuration = entry.blockingDuration
  const frameEnd = entry.startTime + entry.duration
  // These intervals end with the frame; neither claims to isolate layout or paint alone.
  if (entry.renderStart && entry.renderStart > 0) {
    details.renderTailMs = Math.max(0, frameEnd - entry.renderStart)
  }
  if (entry.styleAndLayoutStart && entry.styleAndLayoutStart > 0) {
    details.styleLayoutTailMs = Math.max(0, frameEnd - entry.styleAndLayoutStart)
  }
  if (entry.scripts) {
    details.scriptCount = entry.scripts.length
    details.scriptDuration = entry.scripts.reduce(
      (total, script) => total + (script.duration ?? 0),
      0
    )
    details.forcedStyleAndLayoutDuration = entry.scripts.reduce(
      (total, script) => total + (script.forcedStyleAndLayoutDuration ?? 0),
      0
    )
  }
  return details
}
