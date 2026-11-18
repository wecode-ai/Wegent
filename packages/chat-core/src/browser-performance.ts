export type BrowserPerformanceEventName = 'long-task' | 'long-frame' | 'slow-script'

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

export type RecordPerformanceEvent = (
  name: BrowserPerformanceEventName,
  details: Record<string, number | string>
) => void

const MAX_SCRIPT_ATTRIBUTIONS = 3

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
export function sanitizeScriptDetail(key: string, value: string): string | undefined {
  if (key === 'sourceAsset' && SCRIPT_ASSET_PATTERN.test(value)) return value
  if (key === 'sourceFunctionName' && value.length <= 100 && SCRIPT_FUNCTION_PATTERN.test(value))
    return value
  if (key === 'invokerType' && SCRIPT_INVOKER_TYPES.has(value)) return value
  return undefined
}

export function observeBrowserPerformance(record: RecordPerformanceEvent) {
  const entryTypes =
    typeof PerformanceObserver === 'undefined'
      ? []
      : ['longtask', 'long-animation-frame'].filter(type =>
          PerformanceObserver.supportedEntryTypes?.includes(type)
        )
  if (!entryTypes.length)
    return {
      available: false,
      entryTypes,
      unavailableReason: 'not-supported',
      flush() {},
      stop() {},
    }
  const consume = (entries: PerformanceEntry[]) => {
    for (const entry of entries) {
      if (entry.entryType === 'longtask')
        record('long-task', {
          startTime: entry.startTime,
          elapsedMs: entry.duration,
        })
      else if (entry.entryType === 'long-animation-frame') {
        const frame = entry as AnimationFrameEntry
        const scripts = [...(frame.scripts ?? [])].filter(
          script => (script.forcedStyleAndLayoutDuration ?? 0) >= 16 || (script.duration ?? 0) >= 50
        )
        record('long-frame', animationFrameDetails(frame, scripts))
        recordSlowScripts(frame, scripts, record)
      }
    }
  }
  let observer: PerformanceObserver
  try {
    observer = new PerformanceObserver(list => consume(list.getEntries()))
    observer.observe({ entryTypes })
  } catch {
    return {
      available: false,
      entryTypes: [],
      unavailableReason: 'observer-start-failed',
      flush() {},
      stop() {},
    }
  }
  return {
    available: true,
    entryTypes,
    unavailableReason: null,
    flush: () => consume(observer.takeRecords()),
    stop: () => observer.disconnect(),
  }
}

function recordSlowScripts(
  entry: AnimationFrameEntry,
  slowScripts: ScriptEntry[],
  record: RecordPerformanceEvent
): void {
  const scripts = slowScripts
    .sort(
      (left, right) =>
        (right.duration ?? 0) - (left.duration ?? 0) ||
        (right.forcedStyleAndLayoutDuration ?? 0) - (left.forcedStyleAndLayoutDuration ?? 0)
    )
    .slice(0, MAX_SCRIPT_ATTRIBUTIONS)
  for (const script of scripts) {
    const details: Record<string, number | string> = {
      frameStartTime: entry.startTime,
    }
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
    if (asset && sanitizeScriptDetail('sourceAsset', asset)) {
      details.sourceAsset = asset
      const name = sanitizeScriptDetail('sourceFunctionName', script.sourceFunctionName ?? '')
      if (name) details.sourceFunctionName = name
    }
    const invokerType = sanitizeScriptDetail('invokerType', script.invokerType ?? '')
    if (invokerType) details.invokerType = invokerType
    record('slow-script', details)
  }
}

function animationFrameDetails(
  entry: AnimationFrameEntry,
  slowScripts: ScriptEntry[]
): Record<string, number> {
  const details: Record<string, number> = {
    startTime: entry.startTime,
    elapsedMs: entry.duration,
    slowScriptCount: slowScripts.length,
    slowScriptMaxMs: slowScripts.reduce(
      (maximum, script) => Math.max(maximum, script.duration ?? 0),
      0
    ),
    omittedSlowScripts: Math.max(0, slowScripts.length - MAX_SCRIPT_ATTRIBUTIONS),
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
