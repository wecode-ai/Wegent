import { reportE2EDiagnostic } from './error-capture'
import {
  observeBrowserPerformance,
  type BrowserPerformanceEventName,
} from '@wegent/chat-core/browser-performance'
import { getDesktopE2ERuntimeConfig } from './runtime-config'
import { startExecutorActivity } from './executor-activity'

export const UI_RENDER_IDS = [
  'app',
  'workbench-provider',
  'desktop-sidebar',
  'desktop-workbench-main',
  'workbench-conversation',
  'right-workspace-panel',
] as const

export interface UiRefreshOptions {
  regions?: Array<{ name: string; selector: string }>
  renderIds?: string[]
}

interface RegionCounts {
  selector: string
  observed: boolean
  initialMatches: number
  finalMatches: number
  mutationBatches: number
  mutationRecords: number
  attributeChanges: number
  textChanges: number
  addedNodes: number
  removedNodes: number
  rootRemovals: number
  addedSubtreeElements: number
  removedSubtreeElements: number
  maxAddedSubtreeElements: number
  maxRemovedSubtreeElements: number
}

interface Region {
  counts: RegionCounts
  roots: Element[]
}

interface Capture {
  id: string
  startedAt: string
  startedMs: number
  regions: Map<string, Region>
  renders: Map<string, number>
  commits: number
  actualDurationMs: number
  executor: ReturnType<typeof startExecutorActivity>
  responsiveness: {
    longTaskCount: number
    longTaskTotalMs: number
    longTaskMaxMs: number
    frameCount: number
    frameTotalMs: number
    frameMaxMs: number
    slowScriptCount: number
    slowScriptMaxMs: number
    lastSequence: number
    droppedEvents: number
    events: Array<{
      sequence: number
      atMs: number
      kind: BrowserPerformanceEventName
      details: Record<string, number | string>
    }>
  }
  removals: Array<{ atMs: number; parent: string | null; testIds: string[] }>
}

const captures = new Map<string, Capture>()
const knownRenderIds = new Set<string>()
let observer: MutationObserver | undefined
let observedRoot: Element | undefined
let rendererInstanceId: string | undefined
let profilerObserved = false
let performanceObserver: ReturnType<typeof observeBrowserPerformance> | undefined

function recordResponsiveness(
  kind: BrowserPerformanceEventName,
  details: Record<string, number | string>
) {
  const start = kind === 'slow-script' ? details.frameStartTime : details.startTime
  if (typeof start !== 'number') return
  const elapsed = Math.ceil(details.elapsedMs as number)
  const captureIds: string[] = []
  for (const capture of captures.values()) {
    if (start < capture.startedMs) continue
    captureIds.push(capture.id)
    const target = capture.responsiveness
    if (kind === 'long-task') {
      target.longTaskCount++
      target.longTaskTotalMs += elapsed
      target.longTaskMaxMs = Math.max(target.longTaskMaxMs, elapsed)
    } else if (kind === 'long-frame') {
      target.frameCount++
      target.frameTotalMs += elapsed
      target.frameMaxMs = Math.max(target.frameMaxMs, elapsed)
      target.slowScriptCount += details.slowScriptCount as number
      target.slowScriptMaxMs = Math.max(
        target.slowScriptMaxMs,
        Math.ceil(details.slowScriptMaxMs as number)
      )
    }
    target.events.push({
      sequence: ++target.lastSequence,
      atMs: start - capture.startedMs,
      kind,
      details,
    })
    if (target.events.length > 32) {
      target.events.shift()
      target.droppedEvents++
    }
  }
  if (captureIds.length) {
    reportE2EDiagnostic('renderer-responsiveness', {
      kind,
      captureIds,
      timeOrigin: performance.timeOrigin,
      ...details,
    })
  }
}

export function isUiRefreshCaptureEnabled(): boolean {
  if (typeof window === 'undefined') return false
  return (
    import.meta.env.VITE_WEWORK_E2E === 'true' ||
    import.meta.env.MODE === 'e2e' ||
    Boolean(getDesktopE2ERuntimeConfig().controlUrl)
  )
}

/** Counts render attempts, including StrictMode and abandoned renders, not paints. */
export function recordUiRender(id: string): void {
  if (!isUiRefreshCaptureEnabled()) return
  knownRenderIds.add(id)
  for (const capture of captures.values()) {
    if (capture.renders.has(id)) capture.renders.set(id, capture.renders.get(id)! + 1)
  }
}

export function recordUiReactCommit(actualDuration: number): void {
  if (!isUiRefreshCaptureEnabled()) return
  profilerObserved = true
  for (const capture of captures.values()) {
    capture.commits += 1
    capture.actualDurationMs += actualDuration
  }
}

function elements(node: Node): number {
  return node.nodeType === Node.ELEMENT_NODE
    ? (node as Element).querySelectorAll('*').length + 1
    : 0
}

function contains(ancestor: Node, node: Node): boolean {
  return ancestor === node || ancestor.contains(node)
}

function rootsInNode(node: Node, selector: string): Element[] {
  if (node.nodeType !== Node.ELEMENT_NODE) return []
  const element = node as Element
  return [...(element.matches(selector) ? [element] : []), ...element.querySelectorAll(selector)]
}

function outerRoots(nodes: Element[]): Element[] {
  const roots = new Set(nodes)
  return [...roots].filter(node => {
    for (let parent = node.parentElement; parent; parent = parent.parentElement) {
      if (roots.has(parent)) return false
    }
    return true
  })
}

function mutationRoots(region: Region, records: MutationRecord[], current: Element[]): Element[] {
  const roots = new Set([...region.roots, ...current])
  for (const record of records) {
    if (record.type !== 'childList') continue
    for (const node of [...record.addedNodes, ...record.removedNodes]) {
      rootsInNode(node, region.counts.selector).forEach(root => roots.add(root))
    }
  }
  return outerRoots([...roots])
}

function subtreeSizes(node: Node, roots: Element[], targetInside: boolean) {
  if (targetInside || roots.some(root => contains(root, node))) {
    const size = elements(node)
    return { total: size, largest: size }
  }
  // Roots are disjoint after outerRoots; nested selector matches count only once.
  let total = 0
  let largest = 0
  for (const root of roots) {
    if (!contains(node, root)) continue
    const size = elements(root)
    total += size
    largest = Math.max(largest, size)
  }
  return { total, largest }
}

function recordRegion(region: Region, records: MutationRecord[]): void {
  const counts = region.counts
  const current = [...document.querySelectorAll(counts.selector)]
  const roots = mutationRoots(region, records, current)
  counts.observed ||= roots.length > 0
  let affected = false
  for (const record of records) {
    // Removed nodes are detached by delivery time; their target retains membership.
    const targetInside = roots.some(root => contains(root, record.target))
    const added = [...record.addedNodes].filter(
      node => targetInside || roots.some(root => contains(root, node) || contains(node, root))
    )
    const removed = [...record.removedNodes].filter(
      node => targetInside || roots.some(root => contains(root, node) || contains(node, root))
    )
    if (!targetInside && added.length === 0 && removed.length === 0) continue
    affected = true
    counts.mutationRecords += 1
    counts.attributeChanges += Number(record.type === 'attributes')
    counts.textChanges += Number(record.type === 'characterData')
    counts.addedNodes += added.length
    counts.removedNodes += removed.length
    counts.rootRemovals += roots.filter(root => removed.some(node => contains(node, root))).length
    for (const node of added) {
      const size = subtreeSizes(node, roots, targetInside)
      counts.addedSubtreeElements += size.total
      counts.maxAddedSubtreeElements = Math.max(counts.maxAddedSubtreeElements, size.largest)
    }
    for (const node of removed) {
      const size = subtreeSizes(node, roots, targetInside)
      counts.removedSubtreeElements += size.total
      counts.maxRemovedSubtreeElements = Math.max(counts.maxRemovedSubtreeElements, size.largest)
    }
  }
  counts.mutationBatches += Number(affected)
  counts.finalMatches = current.length
  region.roots = outerRoots(current)
}

function recordMutations(records: MutationRecord[]): void {
  if (records.length === 0) return
  for (const capture of captures.values()) {
    for (const region of capture.regions.values()) recordRegion(region, records)
    for (const record of records) {
      for (const node of record.removedNodes) {
        if (!(node instanceof Element)) continue
        if (
          ![...capture.regions.values()].some(
            region =>
              region.roots.some(root => contains(root, record.target)) ||
              rootsInNode(node, region.counts.selector).length > 0
          )
        )
          continue
        const testIds = [node, ...node.querySelectorAll('[data-testid]')]
          .map(element => element.getAttribute('data-testid'))
          .filter((id): id is string => Boolean(id))
          .slice(0, 16)
        if (!testIds.length) continue
        capture.removals.push({
          atMs: performance.now() - capture.startedMs,
          parent:
            record.target instanceof Element
              ? (record.target.closest('[data-testid]')?.getAttribute('data-testid') ?? null)
              : null,
          testIds,
        })
        if (capture.removals.length > 32) capture.removals.shift()
      }
    }
  }
}

function flush(): void {
  if (observer) recordMutations(observer.takeRecords())
}

function hasDomCapture(): boolean {
  return [...captures.values()].some(capture => capture.regions.size > 0)
}

function createRegion(selector: string): Region {
  const roots = [...document.querySelectorAll(selector)]
  return {
    roots: outerRoots(roots),
    counts: {
      selector,
      observed: roots.length > 0,
      initialMatches: roots.length,
      finalMatches: roots.length,
      mutationBatches: 0,
      mutationRecords: 0,
      attributeChanges: 0,
      textChanges: 0,
      addedNodes: 0,
      removedNodes: 0,
      rootRemovals: 0,
      addedSubtreeElements: 0,
      removedSubtreeElements: 0,
      maxAddedSubtreeElements: 0,
      maxRemovedSubtreeElements: 0,
    },
  }
}

export function startUiRefreshCapture(options: UiRefreshOptions = {}) {
  if (!isUiRefreshCaptureEnabled() || getDesktopE2ERuntimeConfig().disabled) {
    throw new Error('UI refresh capture requires an enabled E2E session')
  }
  if (captures.size > 0 && observedRoot !== document.documentElement)
    throw new Error('The document changed during UI refresh capture')
  const regions = new Map<string, Region>()
  for (const { name, selector } of options.regions ?? [{ name: 'document', selector: 'body' }]) {
    if (typeof name !== 'string' || !name.trim() || regions.has(name))
      throw new Error('UI refresh region names must be nonempty and unique')
    if (typeof selector !== 'string' || !selector.trim())
      throw new Error('UI refresh regions require a selector')
    regions.set(name, createRegion(selector))
  }
  const renderIds = options.renderIds ?? UI_RENDER_IDS
  if (!Array.isArray(renderIds) || renderIds.some(id => typeof id !== 'string' || !id.trim())) {
    throw new Error('UI render IDs must be nonempty strings')
  }
  const renders = new Map<string, number>(renderIds.map(id => [id, 0]))
  flush()
  if (captures.size === 0) {
    observedRoot = document.documentElement
    performanceObserver = observeBrowserPerformance(recordResponsiveness)
  }
  if (regions.size > 0 && !hasDomCapture()) {
    observer ??= new MutationObserver(recordMutations)
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
    })
  }
  rendererInstanceId ??= crypto.randomUUID()
  const id = crypto.randomUUID()
  captures.set(id, {
    id,
    regions,
    renders,
    startedAt: new Date().toISOString(),
    startedMs: performance.now(),
    commits: 0,
    actualDurationMs: 0,
    executor: startExecutorActivity(),
    responsiveness: {
      longTaskCount: 0,
      longTaskTotalMs: 0,
      longTaskMaxMs: 0,
      frameCount: 0,
      frameTotalMs: 0,
      frameMaxMs: 0,
      slowScriptCount: 0,
      slowScriptMaxMs: 0,
      lastSequence: 0,
      droppedEvents: 0,
      events: [],
    },
    removals: [],
  })
  return {
    captureId: id,
    rendererInstanceId,
    regionNames: [...regions.keys()],
    renderIds: [...renders.keys()],
  }
}

export function readUiRefreshCapture(token: { captureId: string; rendererInstanceId: string }) {
  if (token.rendererInstanceId !== rendererInstanceId)
    throw new Error('UI refresh capture belongs to another renderer or was lost on reload')
  const capture = captures.get(token.captureId)
  if (!capture) throw new Error('UI refresh capture is unavailable or already stopped')
  performanceObserver?.flush()
  const documentChanged = observedRoot !== document.documentElement
  flush()
  if (documentChanged) throw new Error('The document changed during UI refresh capture')
  for (const region of capture.regions.values()) {
    region.counts.finalMatches = document.querySelectorAll(region.counts.selector).length
  }
  return {
    version: 1,
    captureId: capture.id,
    rendererInstanceId: token.rendererInstanceId,
    startedAt: capture.startedAt,
    finishedAt: new Date().toISOString(),
    durationMs: performance.now() - capture.startedMs,
    regions: Object.fromEntries(
      [...capture.regions].map(([name, region]) => [name, region.counts])
    ),
    renders: Object.fromEntries(
      [...capture.renders].map(([id, count]) => [id, knownRenderIds.has(id) ? count : null])
    ),
    reactCommits: profilerObserved
      ? { count: capture.commits, actualDurationMs: capture.actualDurationMs }
      : null,
    executor: capture.executor.snapshot(),
    responsiveness: responsivenessSnapshot(capture),
    removals: [...capture.removals],
  }
}

function responsivenessSnapshot(capture: Capture) {
  const counts = capture.responsiveness
  const supportedEntryTypes = [...(performanceObserver?.entryTypes ?? [])]
  const longTasks = supportedEntryTypes.includes('longtask')
  const frames = supportedEntryTypes.includes('long-animation-frame')
  return {
    lastSequence: counts.lastSequence,
    droppedEvents: counts.droppedEvents,
    supportedEntryTypes,
    unavailableReason: performanceObserver?.unavailableReason ?? null,
    longTaskCount: longTasks ? counts.longTaskCount : null,
    longTaskTotalMs: longTasks ? counts.longTaskTotalMs : null,
    longTaskMaxMs: longTasks ? counts.longTaskMaxMs : null,
    frameCount: frames ? counts.frameCount : null,
    frameTotalMs: frames ? counts.frameTotalMs : null,
    frameMaxMs: frames ? counts.frameMaxMs : null,
    slowScriptCount: frames ? counts.slowScriptCount : null,
    slowScriptMaxMs: frames ? counts.slowScriptMaxMs : null,
  }
}

export function getUiResponsivenessDiagnostics() {
  performanceObserver?.flush()
  return {
    timeOrigin: performance.timeOrigin,
    rendererInstanceId,
    captures: [...captures.values()].map(capture => ({
      captureId: capture.id,
      startedAt: capture.startedAt,
      ...responsivenessSnapshot(capture),
      events: [...capture.responsiveness.events],
    })),
  }
}

export function stopUiRefreshCapture(token: { captureId: string; rendererInstanceId: string }) {
  try {
    return readUiRefreshCapture(token)
  } finally {
    const capture = captures.get(token.captureId)
    if (capture && token.rendererInstanceId === rendererInstanceId) {
      capture.executor.stop()
      captures.delete(capture.id)
      if (!hasDomCapture()) observer?.disconnect()
      if (captures.size === 0) {
        performanceObserver?.stop()
        performanceObserver = undefined
      }
    }
  }
}
