const { ipcRenderer } = require('electron') as typeof import('electron')

type Rect = { x: number; y: number; width: number; height: number }

interface ElementAnchor {
  kind: 'element'
  pageUrl: string
  frameUrl: string
  framePath: string[]
  selector: string
  elementPath: string[]
  tagName: string
  role?: string
  name?: string
  title?: string
  immediateText?: string
  nearbyText?: string
  rect: Rect
  fixedPosition: boolean
  scrollContainers: Array<{ selector: string; left: number; top: number }>
}

interface DesignChange {
  property: string
  value: string
  previousValue: string
}

interface RuntimeComment {
  id: string
  number: number
  anchor: ElementAnchor
  designChanges: DesignChange[]
  textChange?: { before: string; after: string } | null
}

interface RuntimeState {
  mode: 'off' | 'quick' | 'batch'
  comments: RuntimeComment[]
  originalView: boolean
}

interface RuntimeCommand {
  type: 'sync'
  state?: RuntimeState
  point?: { x: number; y: number } | null
}

const ROOT_ID = '__wework_browser_annotation_root__'
const DESIGN_ATTRIBUTE = 'data-wework-browser-design'
const DESIGN_STYLE_ATTRIBUTE = 'data-wework-browser-design-style'
const MARKER_ATTRIBUTE = 'data-wework-browser-annotation-marker'
const SELECTION_ATTRIBUTE = 'data-wework-browser-annotation-selection'
const INTERACTION_LAYER_ATTRIBUTE = 'data-wework-browser-annotation-interaction-layer'
const HOVER_ATTRIBUTE = 'data-wework-browser-annotation-hover'
const ANNOTATION_BLUE = '#0069fb'
const DESIGN_PROPERTIES = [
  'color',
  'font-family',
  'font-size',
  'font-weight',
  'background-color',
  'opacity',
  'border-radius',
  'border-color',
  'border-width',
  'width',
  'height',
  'padding',
  'margin',
] as const
const pageSessionId = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`
let state: RuntimeState = { mode: 'off', comments: [], originalView: false }
let rootHost: HTMLElement | null = null
let shadowRoot: ShadowRoot | null = null
let renderTimer: ReturnType<typeof setTimeout> | null = null
let draftAnchor: ElementAnchor | null = null
let hoveredElement: Element | null = null
const resolvedElements = new Map<string, Element>()
const textChangeSnapshots = new Map<
  string,
  {
    addedNode: Text | null
    nodes: Array<{ node: Text; value: string }>
  }
>()

function emit(type: string, payload: Record<string, unknown> = {}) {
  ipcRenderer.send('wework:browser-annotation-event', {
    type,
    pageSessionId,
    pageUrl: location.href,
    ...payload,
  })
}

function normalizedText(value: string | null | undefined, limit = 240) {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit)
}

function cssEscape(value: string) {
  if (globalThis.CSS?.escape) return globalThis.CSS.escape(value)
  return value.replace(/[^a-zA-Z0-9_-]/g, character => `\\${character}`)
}

function isGeneratedIdentity(value: string) {
  return (
    value.length > 80 ||
    /(^|[-_])(?:[a-f0-9]{8,}|\d{6,})(?:[-_]|$)/i.test(value) ||
    /^(?:ember|react|radix|headlessui|mui)-/i.test(value)
  )
}

function uniqueSelector(root: Document | ShadowRoot, selector: string) {
  try {
    return root.querySelectorAll(selector).length === 1
  } catch {
    return false
  }
}

function selectorSegment(element: Element, root: Document | ShadowRoot) {
  if (element.id && !isGeneratedIdentity(element.id)) {
    const selector = `#${cssEscape(element.id)}`
    if (uniqueSelector(root, selector)) return selector
  }
  for (const name of ['data-testid', 'aria-label', 'name']) {
    const value = element.getAttribute(name)
    if (!value || isGeneratedIdentity(value)) continue
    const selector = `${element.localName}[${name}="${cssEscape(value)}"]`
    if (uniqueSelector(root, selector)) return selector
  }
  const classes = Array.from(element.classList)
    .filter(value => !isGeneratedIdentity(value))
    .slice(0, 3)
    .map(value => `.${cssEscape(value)}`)
    .join('')
  if (classes) {
    const selector = `${element.localName}${classes}`
    if (uniqueSelector(root, selector)) return selector
  }
  const segments: string[] = []
  let current: Element | null = element
  while (current) {
    const parent: Element | null = current.parentElement
    let segment = current.localName
    if (parent) {
      const siblings = Array.from(parent.children).filter(
        candidate => candidate.localName === current?.localName
      )
      if (siblings.length > 1) segment += `:nth-of-type(${siblings.indexOf(current) + 1})`
    }
    segments.unshift(segment)
    const selector = segments.join(' > ')
    if (uniqueSelector(root, selector)) return selector
    current = parent
  }
  return segments.join(' > ') || element.localName
}

function selectorFor(element: Element) {
  const segments: string[] = []
  let current: Element = element
  while (true) {
    const root = current.getRootNode()
    if (!(root instanceof Document || root instanceof ShadowRoot)) break
    segments.unshift(selectorSegment(current, root))
    if (!(root instanceof ShadowRoot)) break
    current = root.host
  }
  return segments.length > 1 ? `shadow:${segments.join(' >>> ')}` : segments[0]
}

function queryAnchorSelector(selector: string): Element | null {
  const shadowSelector = selector.startsWith('shadow:')
  const segments = (shadowSelector ? selector.slice('shadow:'.length) : selector).split(' >>> ')
  let root: Document | ShadowRoot = document
  let element: Element | null = null
  for (const [index, segment] of segments.entries()) {
    try {
      element = root.querySelector(segment)
    } catch {
      return null
    }
    if (!element) return null
    if (index < segments.length - 1) {
      if (!element.shadowRoot) return null
      root = element.shadowRoot
    }
  }
  return element
}

function accessibleName(element: Element) {
  return normalizedText(
    element.getAttribute('aria-label') ||
      element.getAttribute('alt') ||
      element.getAttribute('title') ||
      element.textContent,
    160
  )
}

function roleFor(element: Element) {
  const explicit = element.getAttribute('role')
  if (explicit) return explicit
  if (element instanceof HTMLButtonElement) return 'button'
  if (element instanceof HTMLAnchorElement && element.href) return 'link'
  if (element instanceof HTMLInputElement)
    return element.type === 'checkbox' ? 'checkbox' : 'textbox'
  return undefined
}

function elementPath(element: Element) {
  const path: string[] = []
  let current: Element | null = element
  while (current && path.length < 8) {
    path.unshift(current.localName)
    const root = current.getRootNode()
    current = root instanceof ShadowRoot ? root.host : current.parentElement
  }
  return path
}

function scrollContainers(element: Element) {
  const result: ElementAnchor['scrollContainers'] = []
  let current = element.parentElement
  while (current) {
    const style = getComputedStyle(current)
    if (/(auto|scroll)/.test(`${style.overflow}${style.overflowX}${style.overflowY}`)) {
      result.push({
        selector: selectorFor(current),
        left: current.scrollLeft,
        top: current.scrollTop,
      })
    }
    current = current.parentElement
  }
  return result
}

function anchorFor(element: Element): ElementAnchor {
  const rect = element.getBoundingClientRect()
  const style = getComputedStyle(element)
  return {
    kind: 'element',
    pageUrl: location.href,
    frameUrl: location.href,
    framePath: [],
    selector: selectorFor(element),
    elementPath: elementPath(element),
    tagName: element.localName,
    role: roleFor(element),
    name: accessibleName(element),
    title: normalizedText(element.getAttribute('title'), 160) || undefined,
    immediateText: normalizedText(element.textContent),
    nearbyText: normalizedText(element.parentElement?.textContent),
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    fixedPosition: style.position === 'fixed' || style.position === 'sticky',
    scrollContainers: scrollContainers(element),
  }
}

function designValuesFor(element: Element) {
  const style = getComputedStyle(element)
  return Object.fromEntries(
    DESIGN_PROPERTIES.map(property => [property, style.getPropertyValue(property).trim()])
  )
}

function isVisible(element: Element) {
  const rect = element.getBoundingClientRect()
  const style = getComputedStyle(element)
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    style.display !== 'none' &&
    style.visibility !== 'hidden' &&
    Number(style.opacity) !== 0
  )
}

function anchorScore(element: Element, anchor: ElementAnchor) {
  let score = 0
  const name = accessibleName(element)
  const text = normalizedText(element.textContent)
  const nearby = normalizedText(element.parentElement?.textContent)
  if (anchor.name && name === anchor.name) score += 1000
  if (anchor.immediateText && text === anchor.immediateText) score += 600
  if (anchor.nearbyText && nearby === anchor.nearbyText) score += 300
  if (element.localName === anchor.tagName) score += 100
  const rect = element.getBoundingClientRect()
  score -= Math.hypot(rect.x - anchor.rect.x, rect.y - anchor.rect.y)
  return score
}

function resolveAnchor(anchor: ElementAnchor) {
  const direct = queryAnchorSelector(anchor.selector)
  if (direct && isVisible(direct)) return direct
  const candidates = Array.from(document.querySelectorAll(anchor.tagName)).filter(isVisible)
  const ranked = candidates
    .map(element => ({ element, score: anchorScore(element, anchor) }))
    .sort((left, right) => right.score - left.score)
  if (!ranked[0] || ranked[0].score < 400) return null
  if (ranked[1] && ranked[0].score - ranked[1].score < 100) return null
  return ranked[0].element
}

function ensureRoot() {
  if (rootHost?.isConnected && shadowRoot) return shadowRoot
  rootHost = document.getElementById(ROOT_ID)
  if (!rootHost) {
    rootHost = document.createElement('div')
    rootHost.id = ROOT_ID
    Object.assign(rootHost.style, {
      inset: '0',
      pointerEvents: 'none',
      position: 'fixed',
      zIndex: '2147483647',
    })
    document.documentElement.append(rootHost)
  }
  shadowRoot = rootHost.shadowRoot ?? rootHost.attachShadow({ mode: 'open' })
  return shadowRoot
}

function cleanupDesignChanges() {
  for (const snapshot of textChangeSnapshots.values()) {
    snapshot.addedNode?.remove()
    for (const entry of snapshot.nodes) entry.node.data = entry.value
  }
  textChangeSnapshots.clear()
  document.querySelectorAll(`[${DESIGN_ATTRIBUTE}]`).forEach(element => {
    element.removeAttribute(DESIGN_ATTRIBUTE)
  })
  document.querySelectorAll(`style[${DESIGN_STYLE_ATTRIBUTE}]`).forEach(element => element.remove())
}

function applyTextChange(comment: RuntimeComment, element: Element) {
  const textChange = comment.textChange
  if (!textChange || state.originalView) return
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT)
  const nodes: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text)
  }
  if (nodes.map(node => node.data).join('') !== textChange.before) return
  const snapshot = {
    addedNode: null as Text | null,
    nodes: nodes.map(node => ({ node, value: node.data })),
  }
  if (nodes.length === 0) {
    snapshot.addedNode = document.createTextNode(textChange.after)
    element.append(snapshot.addedNode)
  } else {
    nodes[0].data = textChange.after
    for (const node of nodes.slice(1)) node.data = ''
  }
  textChangeSnapshots.set(comment.id, snapshot)
}

function applyDesignChanges() {
  cleanupDesignChanges()
  for (const comment of state.comments) {
    const element = resolvedElements.get(comment.id)
    if (!element) continue
    applyTextChange(comment, element)
    if (state.originalView || comment.designChanges.length === 0) continue
    const token = `annotation-${comment.id.replace(/[^a-zA-Z0-9_-]/g, '-')}`
    element.setAttribute(DESIGN_ATTRIBUTE, token)
    const style = document.createElement('style')
    style.setAttribute(DESIGN_STYLE_ATTRIBUTE, comment.id)
    style.textContent = `[${DESIGN_ATTRIBUTE}="${cssEscape(token)}"] { ${comment.designChanges
      .map(change => `${change.property}: ${change.value} !important;`)
      .join(' ')} }`
    document.head.append(style)
  }
}

function markerButton(comment: RuntimeComment, element: Element) {
  const rect = element.getBoundingClientRect()
  const marker = document.createElement('button')
  marker.type = 'button'
  marker.textContent = String(comment.number)
  marker.setAttribute(MARKER_ATTRIBUTE, '')
  marker.setAttribute('data-annotation-id', comment.id)
  marker.setAttribute('aria-label', `Browser annotation ${comment.number}`)
  marker.setAttribute('aria-expanded', 'false')
  Object.assign(marker.style, {
    alignItems: 'center',
    background: ANNOTATION_BLUE,
    border: '2px solid white',
    borderRadius: '999px',
    boxShadow: '0 2px 8px rgba(0,0,0,.24)',
    color: 'white',
    cursor: 'pointer',
    display: 'flex',
    font: '600 12px system-ui, sans-serif',
    height: '24px',
    justifyContent: 'center',
    left: `${Math.max(4, rect.right - 12)}px`,
    padding: '0',
    pointerEvents: 'auto',
    position: 'fixed',
    top: `${Math.max(4, rect.top - 12)}px`,
    width: '24px',
  })
  marker.addEventListener('click', event => {
    event.preventDefault()
    event.stopPropagation()
    marker.setAttribute('aria-expanded', 'true')
    draftAnchor = anchorFor(element)
    scheduleRender()
    emit('open-comment', {
      commentId: comment.id,
      anchor: anchorFor(element),
      designValues: designValuesFor(element),
    })
  })
  return marker
}

function selectionOutline(element: Element) {
  const rect = element.getBoundingClientRect()
  const outline = document.createElement('div')
  outline.setAttribute(SELECTION_ATTRIBUTE, '')
  Object.assign(outline.style, {
    background: 'rgba(0, 105, 251, .08)',
    border: `2px solid ${ANNOTATION_BLUE}`,
    borderRadius: '6px',
    boxSizing: 'border-box',
    height: `${rect.height}px`,
    left: `${rect.left}px`,
    pointerEvents: 'none',
    position: 'fixed',
    top: `${rect.top}px`,
    width: `${rect.width}px`,
  })
  return outline
}

function hoverOutline(element: Element) {
  const rect = element.getBoundingClientRect()
  const outline = document.createElement('div')
  outline.setAttribute(HOVER_ATTRIBUTE, '')
  Object.assign(outline.style, {
    background: 'rgba(0, 105, 251, .03)',
    border: `2px solid ${ANNOTATION_BLUE}`,
    boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, .28)',
    boxSizing: 'border-box',
    height: `${rect.height}px`,
    left: `${rect.left}px`,
    pointerEvents: 'none',
    position: 'fixed',
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    zIndex: '1',
  })
  return outline
}

function targetBelowInteractionLayer(layer: HTMLElement, point: { x: number; y: number }) {
  layer.style.pointerEvents = 'none'
  try {
    const target = deepestElementAtPoint(point.x, point.y)
    return target ? annotationTarget(target) : null
  } finally {
    layer.style.pointerEvents = 'auto'
  }
}

function interactionLayer() {
  const layer = document.createElement('div')
  layer.setAttribute(INTERACTION_LAYER_ATTRIBUTE, '')
  Object.assign(layer.style, {
    background: 'transparent',
    cursor: 'crosshair',
    inset: '0',
    pointerEvents: 'auto',
    position: 'fixed',
    touchAction: 'pan-x pan-y',
    zIndex: '0',
  })
  layer.addEventListener('pointermove', event => {
    const target = targetBelowInteractionLayer(layer, {
      x: event.clientX,
      y: event.clientY,
    })
    if (target === rootHost || rootHost?.contains(target)) return
    if (hoveredElement === target) return
    hoveredElement = target
    scheduleRender()
  })
  layer.addEventListener('pointerleave', () => {
    if (!hoveredElement) return
    hoveredElement = null
    scheduleRender()
  })
  layer.addEventListener('click', event => {
    event.preventDefault()
    event.stopPropagation()
    const target = targetBelowInteractionLayer(layer, {
      x: event.clientX,
      y: event.clientY,
    })
    if (target) selectElement(target, { x: event.clientX, y: event.clientY })
  })
  return layer
}

function render() {
  renderTimer = null
  const root = ensureRoot()
  root.replaceChildren()
  if (state.mode !== 'off' && !draftAnchor) {
    root.append(interactionLayer())
    if (hoveredElement?.isConnected && isVisible(hoveredElement)) {
      root.append(hoverOutline(hoveredElement))
    } else {
      hoveredElement = null
    }
  } else {
    hoveredElement = null
  }
  if (draftAnchor) {
    const selectedElement = resolveAnchor(draftAnchor)
    if (selectedElement) root.append(selectionOutline(selectedElement))
  }
  resolvedElements.clear()
  const unresolved: string[] = []
  if (state.mode !== 'off') {
    for (const comment of state.comments) {
      const element = resolveAnchor(comment.anchor)
      if (!element) {
        unresolved.push(comment.id)
        continue
      }
      resolvedElements.set(comment.id, element)
      root.append(markerButton(comment, element))
    }
  } else {
    for (const comment of state.comments) {
      const element = resolveAnchor(comment.anchor)
      if (element) resolvedElements.set(comment.id, element)
      else unresolved.push(comment.id)
    }
  }
  applyDesignChanges()
  emit('anchors-updated', {
    unresolvedIds: unresolved,
    anchors: [...resolvedElements.entries()].map(([commentId, element]) => ({
      commentId,
      anchor: anchorFor(element),
    })),
  })
}

function scheduleRender() {
  if (renderTimer !== null) return
  renderTimer = setTimeout(render, 0)
}

function renderImmediately() {
  if (renderTimer !== null) {
    clearTimeout(renderTimer)
    renderTimer = null
  }
  render()
}

function isInternalMutationNode(node: Node) {
  const parentElement = node.parentElement
  return (
    node === rootHost ||
    (shadowRoot !== null && (node === shadowRoot || shadowRoot.contains(node))) ||
    (node instanceof HTMLStyleElement && node.hasAttribute(DESIGN_STYLE_ATTRIBUTE)) ||
    (parentElement instanceof HTMLStyleElement &&
      parentElement.hasAttribute(DESIGN_STYLE_ATTRIBUTE))
  )
}

function shouldRenderForMutation(mutation: MutationRecord) {
  if (
    mutation.type === 'attributes' &&
    mutation.attributeName === DESIGN_ATTRIBUTE &&
    mutation.target instanceof Element
  ) {
    return false
  }
  if (isInternalMutationNode(mutation.target)) return false
  if (mutation.type !== 'childList') return true
  const changedNodes = [...mutation.addedNodes, ...mutation.removedNodes]
  return changedNodes.some(node => !isInternalMutationNode(node))
}

function deepestElementAtPoint(x: number, y: number): Element | null {
  let element = document.elementFromPoint(x, y)
  while (element?.shadowRoot) {
    const nested = element.shadowRoot.elementFromPoint(x, y)
    if (!nested || nested === element) break
    element = nested
  }
  return element
}

function composedParentElement(element: Element) {
  if (element.parentElement) return element.parentElement
  const root = element.getRootNode()
  return root instanceof ShadowRoot ? root.host : null
}

function isPreferredAnnotationTarget(element: Element) {
  return (
    ['a', 'button', 'input', 'textarea', 'select', 'label', 'img'].includes(element.localName) ||
    element.hasAttribute('role')
  )
}

function annotationTarget(element: Element) {
  let current: Element | null = element
  let fallback: Element | null = null
  while (current && current !== document.body && current !== document.documentElement) {
    if (current === rootHost || rootHost?.contains(current)) return null
    if (isVisible(current)) {
      fallback ??= current
      if (isPreferredAnnotationTarget(current)) return current
    }
    current = composedParentElement(current)
  }
  return fallback
}

function selectElement(element: Element, point?: { x: number; y: number }) {
  const target = annotationTarget(element)
  if (!target) return
  const anchor = anchorFor(target)
  hoveredElement = null
  draftAnchor = anchor
  scheduleRender()
  emit('create-draft', {
    anchor,
    designValues: designValuesFor(target),
    markerPoint: point ?? {
      x: anchor.rect.x + anchor.rect.width,
      y: anchor.rect.y,
    },
  })
}

document.addEventListener(
  'click',
  event => {
    if (state.mode === 'off') return
    const path = event.composedPath()
    if (rootHost && path.includes(rootHost)) return
    const target = path.find(candidate => candidate instanceof Element) as Element | undefined
    if (!target) return
    event.preventDefault()
    event.stopImmediatePropagation()
    selectElement(target, { x: event.clientX, y: event.clientY })
  },
  true
)

for (const eventName of ['scroll', 'resize']) {
  globalThis.addEventListener(eventName, scheduleRender, true)
}
globalThis.visualViewport?.addEventListener('scroll', scheduleRender)
globalThis.visualViewport?.addEventListener('resize', scheduleRender)
ipcRenderer.on('wework:browser-annotation-command', (_event: unknown, command: RuntimeCommand) => {
  if (command.type === 'sync' && command.state) {
    state = command.state
    draftAnchor = null
    if (state.mode === 'off') hoveredElement = null
    if (command.point) {
      const target = deepestElementAtPoint(command.point.x, command.point.y)
      if (target) {
        selectElement(target, command.point)
        return
      }
    }
    renderImmediately()
  }
})

function initializeRuntime() {
  new MutationObserver(mutations => {
    if (mutations.some(shouldRenderForMutation)) scheduleRender()
  }).observe(document.documentElement, {
    attributes: true,
    childList: true,
    subtree: true,
  })
  ensureRoot()
  emit('runtime-ready', {
    title: document.title,
    viewport: {
      width: innerWidth,
      height: innerHeight,
      devicePixelRatio,
    },
  })
}

if (document.documentElement) initializeRuntime()
else document.addEventListener('DOMContentLoaded', initializeRuntime, { once: true })
