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
}

const captures = new Map<string, Capture>()
const knownRenderIds = new Set<string>()
let observer: MutationObserver | undefined
let observedRoot: Element | undefined
let rendererInstanceId: string | undefined
let profilerObserved = false

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

function subtreeSize(node: Node, roots: Element[]): number {
  if (roots.some(root => contains(root, node))) return elements(node)
  // A mutation outside the region can insert or remove an ancestor of its root.
  return roots.reduce(
    (largest, root) => (contains(node, root) ? Math.max(largest, elements(root)) : largest),
    0
  )
}

function recordRegion(region: Region, records: MutationRecord[]): void {
  const counts = region.counts
  const current = [...document.querySelectorAll(counts.selector)]
  const roots = mutationRoots(region, records, current)
  counts.observed ||= roots.length > 0
  let affected = false
  for (const record of records) {
    const added = [...record.addedNodes].filter(node =>
      roots.some(root => contains(root, node) || contains(node, root))
    )
    const removed = [...record.removedNodes].filter(node =>
      roots.some(root => contains(root, node) || contains(node, root))
    )
    if (
      !roots.some(root => contains(root, record.target)) &&
      added.length === 0 &&
      removed.length === 0
    )
      continue
    affected = true
    counts.mutationRecords += 1
    counts.attributeChanges += Number(record.type === 'attributes')
    counts.textChanges += Number(record.type === 'characterData')
    counts.addedNodes += added.length
    counts.removedNodes += removed.length
    counts.rootRemovals += roots.filter(root => removed.some(node => contains(node, root))).length
    for (const node of added)
      counts.maxAddedSubtreeElements = Math.max(
        counts.maxAddedSubtreeElements,
        subtreeSize(node, roots)
      )
    for (const node of removed)
      counts.maxRemovedSubtreeElements = Math.max(
        counts.maxRemovedSubtreeElements,
        subtreeSize(node, roots)
      )
  }
  counts.mutationBatches += Number(affected)
  counts.finalMatches = current.length
  region.roots = outerRoots(current)
}

function recordMutations(records: MutationRecord[]): void {
  if (records.length === 0) return
  for (const capture of captures.values()) {
    for (const region of capture.regions.values()) recordRegion(region, records)
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
  if (captures.size === 0) observedRoot = document.documentElement
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
    }
  }
}
