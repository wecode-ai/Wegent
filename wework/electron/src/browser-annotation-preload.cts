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

interface RuntimeDraft {
  label: string
  commentId: string | null
  anchor: ElementAnchor
  comment: string
  designChanges: DesignChange[]
  designValues: Record<string, string>
  textChange: { before: string; after: string } | null
  screenshotState: 'capturing' | 'ready' | 'failed'
}

interface RuntimeState {
  mode: 'off' | 'quick' | 'batch'
  draft: RuntimeDraft | null
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
const CURSOR_ATTRIBUTE = 'data-wework-browser-annotation-cursor'
const ANNOTATION_BLUE = '#0069fb'
const ANNOTATION_CURSOR = {
  fill: '#0285FF',
  height: 25,
  hotspotX: 13,
  hotspotY: 12,
  path: 'M12.6504 0.824799C6.21496 0.824799 0.825466 5.77554 0.825195 12.0885C0.825245 14.2375 1.46183 16.2421 2.55176 17.943L2.02148 20.235L1.99316 20.3756C1.77603 21.655 2.78945 22.7791 4.02832 22.7691L4.0791 22.8209L4.53418 22.7047L7.12305 22.0426C8.77593 22.8778 10.6577 23.3531 12.6504 23.3531C19.086 23.3531 24.4754 18.4014 24.4756 12.0885C24.4753 5.77554 19.0858 0.824799 12.6504 0.824799Z',
  stroke: 'white',
  strokeWidth: 1.65,
  width: 26,
} as const
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
let state: RuntimeState = { mode: 'off', draft: null, comments: [], originalView: false }
let rootHost: HTMLElement | null = null
let shadowRoot: ShadowRoot | null = null
let renderTimer: ReturnType<typeof setTimeout> | null = null
let draftAnchor: ElementAnchor | null = null
let hoveredElement: Element | null = null
let pointerPosition: { x: number; y: number } | null = null
let editorDraftIdentity: string | null = null
let editorComment = ''
let editorDesignOpen = false
let editorDesignValues: Record<string, string> = {}
let editorNeedsFocus = false
let suppressPageClickUntil = 0
let submittedDraftIdentity: string | null = null
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
  bindButtonActivation(marker, () => {
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

function annotationCursor(point: { x: number; y: number }) {
  const cursor = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  cursor.setAttribute(CURSOR_ATTRIBUTE, '')
  cursor.setAttribute('aria-hidden', 'true')
  cursor.setAttribute('height', String(ANNOTATION_CURSOR.height))
  cursor.setAttribute('viewBox', `0 0 ${ANNOTATION_CURSOR.width} ${ANNOTATION_CURSOR.height}`)
  cursor.setAttribute('width', String(ANNOTATION_CURSOR.width))
  Object.assign(cursor.style, {
    display: 'block',
    height: `${ANNOTATION_CURSOR.height}px`,
    left: `${point.x - ANNOTATION_CURSOR.hotspotX}px`,
    pointerEvents: 'none',
    position: 'fixed',
    top: `${point.y - ANNOTATION_CURSOR.hotspotY}px`,
    width: `${ANNOTATION_CURSOR.width}px`,
    zIndex: '2',
  })
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  path.setAttribute('d', ANNOTATION_CURSOR.path)
  path.setAttribute('fill', ANNOTATION_CURSOR.fill)
  path.setAttribute('stroke', ANNOTATION_CURSOR.stroke)
  path.setAttribute('stroke-width', String(ANNOTATION_CURSOR.strokeWidth))
  cursor.append(path)
  return cursor
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
    cursor: 'none',
    inset: '0',
    pointerEvents: 'auto',
    position: 'fixed',
    touchAction: 'pan-x pan-y',
    zIndex: '0',
  })
  layer.addEventListener('pointermove', event => {
    const point = {
      x: event.clientX,
      y: event.clientY,
    }
    const target = targetBelowInteractionLayer(layer, point)
    if (target === rootHost || rootHost?.contains(target)) return
    pointerPosition = point
    hoveredElement = target
    scheduleRender()
  })
  layer.addEventListener('pointerdown', event => {
    if (event.button !== 0 || draftAnchor) return
    event.preventDefault()
    event.stopPropagation()
    suppressPageClickUntil = performance.now() + 500
    const target = targetBelowInteractionLayer(layer, {
      x: event.clientX,
      y: event.clientY,
    })
    if (target) selectElement(target, { x: event.clientX, y: event.clientY })
  })
  return layer
}

const EDITOR_DESIGN_PROPERTIES = [
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

function editorIdentity(draft: RuntimeDraft) {
  return `${draft.commentId ?? 'new'}:${draft.anchor.selector}`
}

function syncEditorState(draft: RuntimeDraft | null) {
  if (!draft) {
    editorDraftIdentity = null
    editorComment = ''
    editorDesignOpen = false
    editorDesignValues = {}
    return
  }
  const identity = editorIdentity(draft)
  if (editorDraftIdentity === identity) return
  editorDraftIdentity = identity
  editorComment = draft.comment
  editorDesignOpen = draft.designChanges.length > 0
  editorDesignValues = Object.fromEntries(
    draft.designChanges.map(change => [change.property, change.value])
  )
  editorNeedsFocus = true
}

function closeDraftLocally() {
  state = { ...state, draft: null }
  draftAnchor = null
  editorDraftIdentity = null
  editorComment = ''
  editorDesignOpen = false
  editorDesignValues = {}
  editorNeedsFocus = false
  renderImmediately()
}

function editorTargetLabel(anchor: ElementAnchor) {
  return (
    anchor.immediateText?.trim() ||
    anchor.name?.trim() ||
    anchor.title?.trim() ||
    anchor.role?.trim() ||
    anchor.selector
  )
}

function editorDesignChanges(draft: RuntimeDraft): DesignChange[] {
  return Object.entries(editorDesignValues).flatMap(([property, rawValue]) => {
    const value = rawValue.trim()
    if (!value) return []
    const previous = draft.designChanges.find(change => change.property === property)
    return [
      {
        property,
        value,
        previousValue: previous?.previousValue ?? draft.designValues[property] ?? '',
      },
    ]
  })
}

function editorDesignInputValue(property: string, value: string) {
  if (!['color', 'background-color', 'border-color'].includes(property)) return value
  const match = value.match(
    /^rgba?\(\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)(?:\s*,\s*(\d+(?:\.\d+)?))?\s*\)$/i
  )
  if (!match || (match[4] !== undefined && Number(match[4]) !== 1)) return value
  return `#${match
    .slice(1, 4)
    .map(component =>
      Math.round(Math.min(255, Math.max(0, Number(component))))
        .toString(16)
        .padStart(2, '0')
    )
    .join('')}`
}

function editorPosition(anchor: ElementAnchor, width: number, height: number) {
  const margin = 16
  const gap = 12
  const maxX = Math.max(margin, innerWidth - width - margin)
  const maxY = Math.max(margin, innerHeight - height - margin)
  const x = Math.min(Math.max(margin, anchor.rect.x), maxX)
  const below = anchor.rect.y + anchor.rect.height + gap
  const above = anchor.rect.y - height - gap
  const y = below <= maxY ? below : Math.max(margin, above)
  return { x, y }
}

function styleElement(element: HTMLElement, styles: Partial<CSSStyleDeclaration>) {
  Object.assign(element.style, styles)
  return element
}

function editorButton(label: string, testId: string) {
  const button = document.createElement('button')
  button.type = 'button'
  button.setAttribute('aria-label', label)
  button.setAttribute('data-testid', testId)
  styleElement(button, {
    alignItems: 'center',
    background: 'transparent',
    border: '0',
    borderRadius: '8px',
    color: 'inherit',
    cursor: 'pointer',
    display: 'flex',
    font: '500 13px system-ui, sans-serif',
    height: '28px',
    justifyContent: 'center',
    padding: '0 8px',
  })
  return button
}

function bindButtonActivation(button: HTMLButtonElement, action: () => void) {
  let activated = false
  const activate = (event: MouseEvent | PointerEvent) => {
    if (event.type !== 'click' && event.button !== 0) return
    event.preventDefault()
    event.stopPropagation()
    if (activated || button.disabled) return
    activated = true
    action()
  }
  button.addEventListener('pointerdown', activate)
  button.addEventListener('mousedown', activate)
  button.addEventListener('click', activate)
}

function editorPanel(draft: RuntimeDraft) {
  const width = editorDesignOpen ? 376 : 326
  const height = editorDesignOpen ? Math.min(540, innerHeight - 32) : 220
  const position = editorPosition(draft.anchor, width, height)
  let submit: HTMLButtonElement | null = null
  let submitted = false
  const submitDraft = () => {
    if (submitted) return
    const nextDesignChanges = editorDesignChanges(draft)
    if (editorComment.trim().length === 0 && nextDesignChanges.length === 0) return
    submitted = true
    submittedDraftIdentity = editorIdentity(draft)
    emit('save-draft', {
      comment: editorComment,
      designChanges: nextDesignChanges,
      textChange: draft.textChange,
    })
    closeDraftLocally()
  }
  const updateSubmitAvailability = () => {
    if (!submit) return
    submit.disabled = editorComment.trim().length === 0 && editorDesignChanges(draft).length === 0
    submit.style.opacity = submit.disabled ? '.35' : '1'
  }
  const surface = document.createElement('form')
  surface.setAttribute('data-testid', 'browser-annotation-editor-surface')
  styleElement(surface, {
    background: 'Canvas',
    border: '1px solid color-mix(in srgb, CanvasText 18%, transparent)',
    borderRadius: '22px',
    boxShadow: '0 18px 48px rgba(0, 0, 0, .28)',
    boxSizing: 'border-box',
    color: 'CanvasText',
    display: 'flex',
    flexDirection: 'column',
    height: `${height}px`,
    left: `${position.x}px`,
    overflow: 'hidden',
    pointerEvents: 'auto',
    position: 'fixed',
    top: `${position.y}px`,
    width: `${width}px`,
    zIndex: '4',
  })
  const header = styleElement(document.createElement('div'), {
    alignItems: 'center',
    display: 'flex',
    gap: '8px',
    minHeight: '50px',
    padding: '8px 12px 4px',
  })
  const designButton = editorButton('调整样式', 'browser-annotation-design-button')
  designButton.textContent = '☷'
  designButton.style.width = '28px'
  designButton.style.padding = '0'
  if (editorDesignOpen)
    designButton.style.background = 'color-mix(in srgb, CanvasText 10%, transparent)'
  bindButtonActivation(designButton, () => {
    editorDesignOpen = !editorDesignOpen
    renderImmediately()
  })
  header.append(designButton)

  const chip = styleElement(document.createElement('span'), {
    alignItems: 'center',
    background: 'color-mix(in srgb, CanvasText 7%, transparent)',
    border: '1px solid color-mix(in srgb, CanvasText 14%, transparent)',
    borderRadius: '9px',
    display: 'flex',
    flex: '1',
    font: '12px system-ui, sans-serif',
    gap: '6px',
    minWidth: '0',
    overflow: 'hidden',
    padding: '3px 4px 3px 6px',
  })
  chip.setAttribute('data-testid', 'browser-annotation-selection-chip')
  const tag = styleElement(document.createElement('span'), {
    border: '1px solid color-mix(in srgb, CanvasText 14%, transparent)',
    borderRadius: '6px',
    flexShrink: '0',
    font: '12px ui-monospace, SFMono-Regular, Menlo, monospace',
    padding: '1px 5px',
  })
  tag.textContent = draft.anchor.tagName.toLowerCase()
  const label = styleElement(document.createElement('span'), {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  })
  label.textContent = editorTargetLabel(draft.anchor)
  const remove = editorButton('移除选择', 'browser-annotation-remove-selection-button')
  remove.textContent = '×'
  remove.style.flexShrink = '0'
  remove.style.fontSize = '20px'
  remove.style.padding = '0'
  remove.style.width = '24px'
  bindButtonActivation(remove, () => emit('close-draft'))
  chip.append(tag, label, remove)
  header.append(chip)
  surface.append(header)

  if (editorDesignOpen) surface.append(editorDesignEditor(draft, updateSubmitAvailability))

  const textarea = document.createElement('textarea')
  textarea.setAttribute('aria-label', '添加评论')
  textarea.setAttribute('data-testid', 'browser-annotation-comment-input')
  textarea.placeholder = editorDesignOpen ? '描述希望如何调整…' : '添加评论…'
  textarea.value = editorComment
  styleElement(textarea, {
    background: 'transparent',
    border: '0',
    boxSizing: 'border-box',
    color: 'inherit',
    flex: editorDesignOpen ? '0 0 64px' : '1',
    font: '14px system-ui, sans-serif',
    minHeight: '56px',
    outline: 'none',
    padding: '8px 16px',
    resize: 'none',
    width: '100%',
  })
  textarea.addEventListener('input', () => {
    editorComment = textarea.value
    updateSubmitAvailability()
  })
  textarea.addEventListener('keydown', event => {
    if (
      event.key === 'Enter' &&
      !event.altKey &&
      !event.shiftKey &&
      (event.metaKey || event.ctrlKey)
    ) {
      event.preventDefault()
      surface.requestSubmit()
    }
  })
  surface.append(textarea)

  const footer = styleElement(document.createElement('div'), {
    alignItems: 'center',
    borderTop: '1px solid color-mix(in srgb, CanvasText 12%, transparent)',
    display: 'flex',
    flexShrink: '0',
    height: '48px',
    justifyContent: draft.commentId ? 'space-between' : 'flex-end',
    padding: '0 12px',
  })
  footer.setAttribute('data-testid', 'browser-annotation-footer-actions')
  if (draft.commentId) {
    const deleteButton = editorButton('删除批注', 'browser-annotation-delete-button')
    deleteButton.textContent = '⌫'
    bindButtonActivation(deleteButton, () => emit('delete-draft'))
    footer.append(deleteButton)
  }
  const actions = styleElement(document.createElement('div'), {
    display: 'flex',
    gap: '6px',
  })
  if (draft.commentId || editorDesignOpen) {
    const cancel = editorButton('取消', 'browser-annotation-cancel-button')
    cancel.textContent = '取消'
    cancel.style.border = '1px solid color-mix(in srgb, CanvasText 16%, transparent)'
    bindButtonActivation(cancel, () => emit('close-draft'))
    actions.append(cancel)
  }
  submit = editorButton(
    draft.commentId ? '保存批注' : '添加批注',
    'browser-annotation-submit-button'
  )
  submit.type = 'submit'
  submit.textContent = draft.commentId ? '保存' : editorDesignOpen ? '添加' : '↑'
  submit.style.background = 'CanvasText'
  submit.style.color = 'Canvas'
  submit.style.minWidth = draft.commentId || editorDesignOpen ? '56px' : '28px'
  updateSubmitAvailability()
  bindButtonActivation(submit, submitDraft)
  actions.append(submit)
  footer.append(actions)
  surface.append(footer)

  const screenshotState = document.createElement('span')
  screenshotState.setAttribute(
    'data-testid',
    draft.screenshotState === 'ready'
      ? 'browser-annotation-screenshot-ready'
      : 'browser-annotation-screenshot-state'
  )
  screenshotState.hidden = true
  screenshotState.textContent = draft.screenshotState
  surface.append(screenshotState)

  surface.addEventListener('submit', event => {
    event.preventDefault()
    submitDraft()
  })
  queueMicrotask(() => {
    if (!editorNeedsFocus || !textarea.isConnected) return
    editorNeedsFocus = false
    textarea.focus()
  })
  return surface
}

function editorDesignEditor(draft: RuntimeDraft, updateSubmitAvailability: () => void) {
  const editor = styleElement(document.createElement('div'), {
    borderTop: '1px solid color-mix(in srgb, CanvasText 12%, transparent)',
    flex: '1',
    minHeight: '0',
    overflowY: 'auto',
    padding: '8px 16px',
  })
  editor.setAttribute('data-testid', 'browser-annotation-design-editor')
  for (const property of EDITOR_DESIGN_PROPERTIES) {
    const row = styleElement(document.createElement('label'), {
      alignItems: 'center',
      display: 'grid',
      font: '13px system-ui, sans-serif',
      gap: '8px',
      gridTemplateColumns: 'minmax(0, 1fr) 150px 28px',
      minHeight: '34px',
    })
    const name = document.createElement('span')
    name.textContent = property
    const input = document.createElement('input')
    input.setAttribute(
      'data-testid',
      property === 'color'
        ? 'browser-annotation-design-color'
        : `browser-annotation-design-${property}`
    )
    input.value =
      editorDesignValues[property] ??
      editorDesignInputValue(property, draft.designValues[property] ?? '')
    styleElement(input, {
      background: 'Canvas',
      border: '1px solid color-mix(in srgb, CanvasText 16%, transparent)',
      borderRadius: '8px',
      boxSizing: 'border-box',
      color: 'inherit',
      font: '12px ui-monospace, SFMono-Regular, Menlo, monospace',
      height: '28px',
      minWidth: '0',
      outline: 'none',
      padding: '0 8px',
    })
    input.addEventListener('input', () => {
      editorDesignValues[property] = input.value
      updateSubmitAvailability()
    })
    const reset = editorButton(`重置 ${property}`, `browser-annotation-reset-${property}`)
    reset.textContent = '↶'
    reset.style.padding = '0'
    bindButtonActivation(reset, () => {
      delete editorDesignValues[property]
      renderImmediately()
    })
    row.append(name, input, reset)
    editor.append(row)
  }
  return editor
}

interface EditorFocusSnapshot {
  testId: string
  selectionStart: number | null
  selectionEnd: number | null
}

function editorFocusSnapshot(root: ShadowRoot): EditorFocusSnapshot | null {
  const activeElement = root.activeElement
  if (
    !(activeElement instanceof HTMLInputElement) &&
    !(activeElement instanceof HTMLTextAreaElement)
  ) {
    return null
  }
  const testId = activeElement.dataset.testid
  if (!testId) return null
  return {
    testId,
    selectionStart: activeElement.selectionStart,
    selectionEnd: activeElement.selectionEnd,
  }
}

function restoreEditorFocus(root: ShadowRoot, snapshot: EditorFocusSnapshot | null) {
  if (!snapshot) return
  queueMicrotask(() => {
    const selector = `[data-testid="${cssEscape(snapshot.testId)}"]`
    const input = root.querySelector(selector)
    if (!(input instanceof HTMLInputElement) && !(input instanceof HTMLTextAreaElement)) return
    input.focus()
    if (snapshot.selectionStart !== null && snapshot.selectionEnd !== null) {
      input.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd)
    }
  })
}

function render() {
  renderTimer = null
  const root = ensureRoot()
  const focusSnapshot = editorFocusSnapshot(root)
  root.replaceChildren()
  syncEditorState(state.draft)
  if (state.mode !== 'off' && !draftAnchor) {
    root.append(interactionLayer())
    if (hoveredElement?.isConnected && isVisible(hoveredElement)) {
      root.append(hoverOutline(hoveredElement))
    } else {
      hoveredElement = null
    }
    if (pointerPosition) root.append(annotationCursor(pointerPosition))
  } else {
    hoveredElement = null
    pointerPosition = null
  }
  if (draftAnchor) {
    const selectedElement = resolveAnchor(draftAnchor)
    if (selectedElement) root.append(selectionOutline(selectedElement))
  }
  if (state.draft) root.append(editorPanel(state.draft))
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
  restoreEditorFocus(root, focusSnapshot)
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
  pointerPosition = null
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
  'keydown',
  event => {
    if (event.key !== 'Escape' || state.mode === 'off') return
    event.preventDefault()
    event.stopImmediatePropagation()
    if (state.draft) {
      emit('close-draft')
      closeDraftLocally()
      return
    }
    emit('stop-annotation')
  },
  true
)

document.addEventListener(
  'click',
  event => {
    if (state.mode === 'off') return
    if (performance.now() <= suppressPageClickUntil) {
      event.preventDefault()
      event.stopImmediatePropagation()
      return
    }
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

document.addEventListener(
  'pointerleave',
  () => {
    if (!hoveredElement && !pointerPosition) return
    hoveredElement = null
    pointerPosition = null
    scheduleRender()
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
    const incomingDraftIdentity = command.state.draft ? editorIdentity(command.state.draft) : null
    if (submittedDraftIdentity && incomingDraftIdentity === submittedDraftIdentity) {
      state = { ...command.state, draft: null }
    } else {
      submittedDraftIdentity = null
      state = command.state
    }
    draftAnchor = state.draft?.anchor ?? null
    if (state.mode === 'off') {
      hoveredElement = null
      pointerPosition = null
    }
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
