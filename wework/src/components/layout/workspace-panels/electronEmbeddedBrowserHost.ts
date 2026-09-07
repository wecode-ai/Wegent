interface ElectronWebviewElement extends HTMLElement {
  destroy?: () => void
}

interface HostedElectronWebviewClaim {
  active: boolean
  bounds: ElectronEmbeddedBrowserBounds | null
  interactionBlocked: boolean
  owner: symbol
}

export interface ElectronEmbeddedBrowserBounds {
  height: number
  left: number
  top: number
  width: number
}

export interface HostedElectronWebview {
  claims: HostedElectronWebviewClaim[]
  container: HTMLDivElement
  cursorHost: HTMLDivElement
  destroyed: boolean
  label: string
  owner: symbol | null
  retained: boolean
  retentionTimeout: number | null
  webview: ElectronWebviewElement
}

const WEBVIEW_HOST_ROOT_ATTRIBUTE = 'data-wework-browser-webview-host-root'
const ROUTE_PARTITION_PREFIX = 'persist:wework-browser-app-route:'
const ROUTE_HOST_SEPARATOR = ':host:'
const WEBVIEW_TRANSFER_RETENTION_MS = 6_000
const rendererInstanceId = getRendererInstanceId()
const hostedWebviews = new Map<string, HostedElectronWebview>()
let nextHostGeneration = 0

function getRendererInstanceId() {
  const storageKey = 'wework.browser.renderer-instance-id'
  const stored = window.sessionStorage.getItem(storageKey)
  if (stored) return stored
  const id =
    typeof window.crypto?.randomUUID === 'function'
      ? window.crypto.randomUUID()
      : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  window.sessionStorage.setItem(storageKey, id)
  return id
}

function getWebviewHostRoot() {
  const existing = document.querySelector<HTMLElement>(`[${WEBVIEW_HOST_ROOT_ATTRIBUTE}]`)
  if (existing) return existing
  const root = document.createElement('div')
  root.setAttribute(WEBVIEW_HOST_ROOT_ATTRIBUTE, '')
  Object.assign(root.style, {
    inset: '0',
    overflow: 'visible',
    pointerEvents: 'none',
    position: 'fixed',
    zIndex: '10',
  })
  document.body.append(root)
  return root
}

function routePartition(label: string, hostGeneration: number) {
  const route = `${ROUTE_PARTITION_PREFIX}${encodeURIComponent(`wework\0${label}`)}`
  return `${route}${ROUTE_HOST_SEPARATOR}${rendererInstanceId}:${hostGeneration}`
}

function createElectronWebview(label: string): ElectronWebviewElement {
  const webview = document.createElement('webview') as ElectronWebviewElement
  const hostGeneration = ++nextHostGeneration
  webview.setAttribute('data-wework-browser-label', label)
  webview.setAttribute('data-browser-sidebar-conversation-id', 'wework')
  webview.setAttribute('data-browser-sidebar-browser-tab-id', label)
  webview.setAttribute('allowpopups', 'true')
  webview.setAttribute('partition', routePartition(label, hostGeneration))
  webview.setAttribute('src', 'about:blank')
  webview.setAttribute('webviewrole', 'tab')
  webview.setAttribute('aria-label', 'Wework built-in browser content')
  Object.assign(webview.style, {
    display: 'flex',
    height: '100%',
    width: '100%',
  })
  return webview
}

function createHostedWebview(label: string): HostedElectronWebview {
  const container = document.createElement('div')
  const webview = createElectronWebview(label)
  const cursorHost = document.createElement('div')
  container.dataset.testid = 'workspace-browser-electron-webview'
  container.dataset.weworkBrowserWebview = label
  Object.assign(container.style, {
    overflow: 'hidden',
    position: 'fixed',
  })
  cursorHost.dataset.testid = 'workspace-browser-agent-cursor-overlay'
  Object.assign(cursorHost.style, {
    inset: '0',
    pointerEvents: 'none',
    position: 'absolute',
    zIndex: '1',
  })
  container.append(webview, cursorHost)
  getWebviewHostRoot().append(container)
  return {
    claims: [],
    container,
    cursorHost,
    destroyed: false,
    label,
    owner: null,
    retained: false,
    retentionTimeout: null,
    webview,
  }
}

function clearRetentionTimeout(host: HostedElectronWebview) {
  if (host.retentionTimeout === null) return
  window.clearTimeout(host.retentionTimeout)
  host.retentionTimeout = null
}

function destroyElectronWebview(webview: ElectronWebviewElement): void {
  if (typeof webview.destroy === 'function') webview.destroy()
  webview.remove()
}

function destroyHostedWebview(host: HostedElectronWebview) {
  if (host.destroyed) return
  host.destroyed = true
  clearRetentionTimeout(host)
  if (hostedWebviews.get(host.label) === host) hostedWebviews.delete(host.label)
  destroyElectronWebview(host.webview)
  host.container.remove()
}

function connectedHostedWebview(label: string): HostedElectronWebview | null {
  const candidate = hostedWebviews.get(label)
  if (!candidate) return null
  if (!candidate.destroyed && candidate.container.isConnected) return candidate
  hostedWebviews.delete(label)
  return null
}

function assignHostedWebviewLabel(host: HostedElectronWebview, label: string): void {
  if (host.label === label) return
  const existing = connectedHostedWebview(label)
  if (existing && existing !== host) {
    if (existing.owner !== null || existing.claims.length > 0) {
      throw new Error(`Embedded browser label already has an active host: ${label}`)
    }
    destroyHostedWebview(existing)
  }
  if (hostedWebviews.get(host.label) === host) hostedWebviews.delete(host.label)
  host.label = label
  host.container.dataset.weworkBrowserWebview = label
  host.webview.setAttribute('data-wework-browser-label', label)
  host.webview.setAttribute('data-browser-sidebar-browser-tab-id', label)
  hostedWebviews.set(label, host)
}

function currentClaim(host: HostedElectronWebview): HostedElectronWebviewClaim | null {
  return host.claims.at(-1) ?? null
}

function applyClaim(host: HostedElectronWebview, claim: HostedElectronWebviewClaim): void {
  if (claim.bounds) {
    Object.assign(host.container.style, {
      height: `${claim.bounds.height}px`,
      left: `${claim.bounds.left}px`,
      top: `${claim.bounds.top}px`,
      width: `${claim.bounds.width}px`,
    })
  }
  host.container.style.pointerEvents = claim.interactionBlocked ? 'none' : 'auto'
  host.container.style.visibility = claim.active ? 'visible' : 'hidden'
}

function claimForOwner(
  host: HostedElectronWebview,
  owner: symbol
): HostedElectronWebviewClaim | null {
  return host.claims.find(claim => claim.owner === owner) ?? null
}

function assignOwner(host: HostedElectronWebview, owner: symbol): void {
  const existingClaim = claimForOwner(host, owner)
  if (existingClaim) {
    host.claims = host.claims.filter(claim => claim !== existingClaim)
    host.claims.push(existingClaim)
  } else {
    host.claims.push({
      active: false,
      bounds: null,
      interactionBlocked: true,
      owner,
    })
  }
  host.owner = owner
}

export function claimElectronEmbeddedBrowserView(
  label: string,
  owner: symbol,
  transferFromLabel?: string
): HostedElectronWebview {
  const existing =
    connectedHostedWebview(label) ??
    (transferFromLabel ? connectedHostedWebview(transferFromLabel) : null)
  if (existing) {
    assignHostedWebviewLabel(existing, label)
    clearRetentionTimeout(existing)
    assignOwner(existing, owner)
    existing.retained = false
    return existing
  }

  const host = createHostedWebview(label)
  assignOwner(host, owner)
  hostedWebviews.set(label, host)
  return host
}

export function releaseElectronEmbeddedBrowserView(
  host: HostedElectronWebview,
  owner: symbol
): void {
  const claim = claimForOwner(host, owner)
  if (!claim) return
  const wasCurrentOwner = host.owner === owner
  host.claims = host.claims.filter(candidate => candidate !== claim)
  if (!wasCurrentOwner) return
  const nextClaim = currentClaim(host)
  host.owner = nextClaim?.owner ?? null
  if (nextClaim) {
    applyClaim(host, nextClaim)
    return
  }
  host.container.style.pointerEvents = 'none'
  host.container.style.visibility = 'hidden'
  if (host.retained) return
  queueMicrotask(() => {
    if (host.owner !== null || host.retained) return
    destroyHostedWebview(host)
  })
}

export function relabelElectronEmbeddedBrowserView(
  host: HostedElectronWebview,
  owner: symbol,
  label: string
): void {
  if (host.owner !== owner || host.label === label) return
  assignHostedWebviewLabel(host, label)
}

export function resetElectronEmbeddedBrowserView(host: HostedElectronWebview, owner: symbol): void {
  if (host.destroyed || host.owner !== owner) return
  const previousWebview = host.webview
  const nextWebview = createElectronWebview(host.label)
  host.webview = nextWebview
  destroyElectronWebview(previousWebview)
  host.container.insertBefore(nextWebview, host.cursorHost)
}

export function positionElectronEmbeddedBrowserView(
  host: HostedElectronWebview,
  owner: symbol,
  bounds: ElectronEmbeddedBrowserBounds
): void {
  const claim = claimForOwner(host, owner)
  if (!claim || bounds.width <= 0 || bounds.height <= 0) return
  claim.bounds = bounds
  if (host.owner === owner) applyClaim(host, claim)
}

export function syncElectronEmbeddedBrowserView(
  host: HostedElectronWebview,
  owner: symbol,
  active: boolean,
  interactionBlocked: boolean
): void {
  const claim = claimForOwner(host, owner)
  if (!claim) return
  claim.active = active
  claim.interactionBlocked = interactionBlocked
  if (host.owner === owner) applyClaim(host, claim)
}

export function retainElectronEmbeddedBrowserView(label: string): void {
  const host = hostedWebviews.get(label)
  if (!host || host.destroyed || !host.container.isConnected) return
  host.retained = true
  clearRetentionTimeout(host)
  host.retentionTimeout = window.setTimeout(() => {
    host.retentionTimeout = null
    host.retained = false
    if (host.owner === null) destroyHostedWebview(host)
  }, WEBVIEW_TRANSFER_RETENTION_MS)
}
