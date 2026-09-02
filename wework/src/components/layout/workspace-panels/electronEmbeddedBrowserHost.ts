interface ElectronWebviewElement extends HTMLElement {
  destroy?: () => void
}

export interface HostedElectronWebview {
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

function createHostedWebview(label: string): HostedElectronWebview {
  const container = document.createElement('div')
  const webview = document.createElement('webview') as ElectronWebviewElement
  const cursorHost = document.createElement('div')
  const hostGeneration = ++nextHostGeneration
  container.dataset.testid = 'workspace-browser-electron-webview'
  container.dataset.weworkBrowserWebview = label
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

function destroyHostedWebview(host: HostedElectronWebview) {
  if (host.destroyed) return
  host.destroyed = true
  clearRetentionTimeout(host)
  if (hostedWebviews.get(host.label) === host) hostedWebviews.delete(host.label)
  if (typeof host.webview.destroy === 'function') host.webview.destroy()
  else host.webview.remove()
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
  if (existing && existing !== host) destroyHostedWebview(existing)
  if (hostedWebviews.get(host.label) === host) hostedWebviews.delete(host.label)
  host.label = label
  host.container.dataset.weworkBrowserWebview = label
  host.webview.setAttribute('data-wework-browser-label', label)
  host.webview.setAttribute('data-browser-sidebar-browser-tab-id', label)
  hostedWebviews.set(label, host)
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
    existing.owner = owner
    existing.retained = false
    return existing
  }

  const host = createHostedWebview(label)
  host.owner = owner
  hostedWebviews.set(label, host)
  return host
}

export function releaseElectronEmbeddedBrowserView(
  host: HostedElectronWebview,
  owner: symbol
): void {
  if (host.owner !== owner) return
  host.owner = null
  host.container.style.pointerEvents = 'none'
  if (host.retained) return
  host.container.style.visibility = 'hidden'
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

export function syncElectronEmbeddedBrowserView(
  host: HostedElectronWebview,
  owner: symbol,
  active: boolean,
  interactionBlocked: boolean
): void {
  if (host.owner !== owner) return
  host.container.style.pointerEvents = interactionBlocked ? 'none' : 'auto'
  host.container.style.visibility = active ? 'visible' : 'hidden'
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
