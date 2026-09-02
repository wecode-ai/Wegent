import {
  app,
  BrowserWindow,
  Menu,
  WebContentsView,
  session,
  shell,
  type ContextMenuParams,
  type DownloadItem,
  type MenuItemConstructorOptions,
  type WebContents,
} from 'electron'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BrowserHistoryStore,
  type BrowserHistoryEntry,
  type BrowserHistorySearch,
} from './browser-history-store.js'
import { prepareLocalFileNavigation } from './local-file-preview.js'
import { captureWebContentsDataUrl } from './web-contents-capture.js'

export interface BrowserBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface BrowserPageState {
  label: string
  nativeLabel: string
  title: string | null
  url: string | null
  isLoading: boolean
  visible: boolean
  navigationError: {
    code: number
    message: string
    url: string | null
  } | null
}

interface BrowserEntry {
  label: string
  nativeLabel: string
  contents: WebContents
  bounds: BrowserBounds
  visible: boolean
  requestedUrl: string | null
  previewDisplayUrl: string | null
  previewSourceUrl: string | null
  ownsDeviceMetricsDebugger: boolean
  navigationError: BrowserPageState['navigationError']
  historyId: string | null
  historyGeneration: number
}

interface BrowserOpenInput {
  label: string
  url: string
  bounds: BrowserBounds
  visible: boolean
  navigateExisting: boolean
}

export interface BrowserHostEvent {
  sequence: number
  type:
    | 'agent-cursor'
    | 'agent-state'
    | 'close-request'
    | 'download'
    | 'local-file-preview'
    | 'open-request'
    | 'page-state'
    | 'popup'
    | 'annotation-request'
  payload: Record<string, unknown>
}

interface BrowserAgentApproval {
  label: string
  signature: string
  approved: boolean
  payload: {
    approvalId: string
    risk: string
    actionKind: string
    reason: string
    target: unknown
    expiresAtUnixMs: number
  }
}

interface BrowserAgentCursorState {
  x: number
  y: number
  moveSequence: number
}

interface BrowserAgentCursorArrivalWaiter {
  moveSequence: number
  resolve: (arrived: boolean) => void
  timeout: NodeJS.Timeout
}

interface BrowserDownload {
  id: string
  item: DownloadItem
  label: string
  nativeLabel: string
  path: string | null
}

export interface BrowserRequestHeaderRule {
  id: string
  origins: string[]
  pathPrefixes: string[]
  headers: Record<string, string>
  expiresAt?: number | null
  allowInsecure?: boolean
}

export interface BrowserBackgroundPageState {
  id: string
  title: string | null
  url: string | null
  userAgent: string
  isLoading: boolean
  httpResponseCode: number | null
  httpStatusText: string | null
  navigationError: {
    code: number
    message: string
    url: string | null
  } | null
}

const AGENT_CURSOR_IDLE_HIDE_MS = 4_000
export const EMBEDDED_BROWSER_PARTITION = 'persist:wework-browser'
export const EMBEDDED_BROWSER_ROUTE_PARTITION_PREFIX = 'persist:wework-browser-app-route:'
export const EMBEDDED_BROWSER_ROUTE_HOST_SEPARATOR = ':host:'

export class EmbeddedBrowserManager {
  private readonly entries = new Map<string, BrowserEntry>()
  private readonly attachedContents = new Map<string, WebContents>()
  private readonly attachmentWaiters = new Map<
    string,
    Set<{
      resolve: (contents: WebContents) => void
      reject: (error: Error) => void
      timeout: NodeJS.Timeout
    }>
  >()
  private readonly activeTabs = new Map<string, string>()
  private readonly downloads = new Map<string, BrowserDownload>()
  private readonly agentControlPaused = new Set<string>()
  private readonly agentActive = new Set<string>()
  private readonly agentApprovals = new Map<string, BrowserAgentApproval>()
  private readonly agentCursorStates = new Map<string, BrowserAgentCursorState>()
  private readonly agentCursorArrivals = new Map<string, number>()
  private readonly agentCursorArrivalWaiters = new Map<
    string,
    Set<BrowserAgentCursorArrivalWaiter>
  >()
  private readonly agentCursorHideTimers = new Map<string, NodeJS.Timeout>()
  private readonly backgroundPages = new Map<
    string,
    {
      view: WebContentsView
      httpResponseCode: number | null
      httpStatusText: string | null
      navigationError: BrowserBackgroundPageState['navigationError']
    }
  >()
  private readonly requestHeaderRules = new Map<string, BrowserRequestHeaderRule>()
  private readonly history: BrowserHistoryStore
  private agentCursorSequence = 0
  private eventSequence = 0
  private historyGeneration = 0

  constructor(
    dataDirectory: string,
    private readonly onEvent: (event: BrowserHostEvent) => void = () => {}
  ) {
    this.history = new BrowserHistoryStore(join(dataDirectory, 'browser-history.json'))
    const browserSession = session.fromPartition(EMBEDDED_BROWSER_PARTITION)
    browserSession.on('will-download', (_event, item, webContents) => {
      const entry = [...this.entries.values()].find(
        candidate => candidate.contents.id === webContents.id
      )
      if (entry) this.trackDownload(entry, item)
    })
    browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
      callback({ requestHeaders: this.requestHeaders(details.url, details.requestHeaders) })
    })
  }

  setRequestHeaderRule(rule: BrowserRequestHeaderRule): void {
    validateRequestHeaderRule(rule)
    this.requestHeaderRules.set(rule.id, structuredClone(rule))
  }

  removeRequestHeaderRule(id: string): void {
    this.requestHeaderRules.delete(id)
  }

  createBackgroundPage(id: string): BrowserBackgroundPageState {
    const normalizedId = requiredBackgroundPageId(id)
    if (this.backgroundPages.has(normalizedId)) {
      throw new Error('Browser background page already exists')
    }
    const view = new WebContentsView({
      webPreferences: {
        session: session.fromPartition(EMBEDDED_BROWSER_PARTITION),
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
      },
    })
    const entry = {
      view,
      httpResponseCode: null as number | null,
      httpStatusText: null as string | null,
      navigationError: null as BrowserBackgroundPageState['navigationError'],
    }
    this.backgroundPages.set(normalizedId, entry)
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isBrowserUrl(url)) void shell.openExternal(url)
      return { action: 'deny' }
    })
    view.webContents.on(
      'did-fail-load',
      (_event, code: number, message: string, url: string, isMainFrame: boolean) => {
        if (!isMainFrame) return
        entry.navigationError = { code, message, url: url || null }
      }
    )
    view.webContents.on(
      'did-navigate',
      (_event, _url: string, httpResponseCode: number, httpStatusText: string) => {
        entry.httpResponseCode = httpResponseCode >= 0 ? httpResponseCode : null
        entry.httpStatusText = httpStatusText || null
      }
    )
    view.webContents.once('destroyed', () => {
      if (this.backgroundPages.get(normalizedId)?.view === view) {
        this.backgroundPages.delete(normalizedId)
      }
    })
    return this.backgroundPageState(normalizedId)
  }

  async navigateBackgroundPage(id: string, rawUrl: string): Promise<BrowserBackgroundPageState> {
    const entry = this.requiredBackgroundPage(id)
    entry.navigationError = null
    entry.httpResponseCode = null
    entry.httpStatusText = null
    await entry.view.webContents.loadURL(validRemoteBrowserUrl(rawUrl))
    return this.backgroundPageState(id)
  }

  setBackgroundPageUserAgent(id: string, userAgent: string): BrowserBackgroundPageState {
    const entry = this.requiredBackgroundPage(id)
    entry.view.webContents.setUserAgent(requiredUserAgent(userAgent))
    return this.backgroundPageState(id)
  }

  backgroundPageState(id: string): BrowserBackgroundPageState {
    const normalizedId = requiredBackgroundPageId(id)
    const entry = this.requiredBackgroundPage(normalizedId)
    const contents = entry.view.webContents
    return {
      id: normalizedId,
      title: contents.getTitle() || null,
      url: contents.getURL() || null,
      userAgent: contents.getUserAgent(),
      isLoading: contents.isLoading(),
      httpResponseCode: entry.httpResponseCode,
      httpStatusText: entry.httpStatusText,
      navigationError: entry.navigationError,
    }
  }

  closeBackgroundPage(id: string): void {
    const normalizedId = requiredBackgroundPageId(id)
    const entry = this.backgroundPages.get(normalizedId)
    if (!entry) return
    this.backgroundPages.delete(normalizedId)
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close()
  }

  private requestHeaders(rawUrl: string, headers: Record<string, string>): Record<string, string> {
    let url: URL
    try {
      url = new URL(rawUrl)
    } catch {
      return headers
    }
    const now = Date.now()
    let next = headers
    for (const [id, rule] of this.requestHeaderRules) {
      if (rule.expiresAt != null && rule.expiresAt <= now) {
        this.requestHeaderRules.delete(id)
        continue
      }
      if (
        rule.origins.includes(url.origin) &&
        rule.pathPrefixes.some(prefix => url.pathname.startsWith(prefix))
      ) {
        next = { ...next, ...rule.headers }
      }
    }
    return next
  }

  private requiredBackgroundPage(id: string) {
    const normalizedId = requiredBackgroundPageId(id)
    const entry = this.backgroundPages.get(normalizedId)
    if (!entry || entry.view.webContents.isDestroyed()) {
      throw new Error('Browser background page does not exist')
    }
    return entry
  }

  attach(label: string, contents: WebContents): void {
    const normalizedLabel = requiredLabel(label)
    const existing = this.entries.get(normalizedLabel)
    if (existing && existing.contents.id !== contents.id) {
      this.close(normalizedLabel, existing.nativeLabel)
    }
    const previous = this.attachedContents.get(normalizedLabel)
    if (previous && previous.id !== contents.id && !previous.isDestroyed()) previous.close()
    this.attachedContents.set(normalizedLabel, contents)
    contents.on('before-mouse-event', (_event, mouse) => {
      if (mouse.type !== 'mouseDown') return
      const entry = [...this.entries.values()].find(
        candidate => candidate.contents.id === contents.id
      )
      if (!entry || !this.agentActive.has(entry.label)) return
      this.setAgentControlPaused(entry.label, true)
    })
    contents.once('destroyed', () => {
      const removedLabels = new Set<string>()
      for (const [attachedLabel, attached] of this.attachedContents) {
        if (attached.id !== contents.id) continue
        this.attachedContents.delete(attachedLabel)
        removedLabels.add(attachedLabel)
      }
      for (const [entryLabel, entry] of this.entries) {
        if (entry.contents.id !== contents.id) continue
        this.entries.delete(entryLabel)
        removedLabels.add(entryLabel)
      }
      for (const removedLabel of removedLabels) this.clearLabelScopedState(removedLabel)
    })
    this.resolveAttachmentWaiters(normalizedLabel, contents)
  }

  requestPopupTab(parentLabel: string, url: string): void {
    const entry = this.entries.get(parentLabel)
    if (!entry || !isBrowserUrl(url)) {
      if (isBrowserUrl(url)) void shell.openExternal(url)
      return
    }
    this.emit('popup', {
      popupId: randomUUID(),
      parentLabel: entry.label,
      parentNativeLabel: entry.nativeLabel,
      url,
      origin: new URL(url).origin,
      kind: 'context-menu',
      strategy: 'new-tab',
      status: 'pending',
      createdAtUnixMs: Date.now(),
      warning: null,
    })
  }

  async open(input: BrowserOpenInput): Promise<BrowserPageState> {
    const label = requiredLabel(input.label)
    const existing = this.entries.get(label)
    if (existing) return this.openExisting(existing, input)
    const contents = await this.waitForAttachedContents(label)
    const migrated = this.entries.get(label)
    if (migrated) return this.openExisting(migrated, input)
    const entry: BrowserEntry = {
      label,
      nativeLabel: `electron-browser-${randomUUID()}`,
      contents,
      bounds: validBounds(input.bounds),
      visible: input.visible,
      requestedUrl: validBrowserUrl(input.url),
      previewDisplayUrl: null,
      previewSourceUrl: null,
      ownsDeviceMetricsDebugger: false,
      navigationError: null,
      historyId: null,
      historyGeneration: this.historyGeneration,
    }
    contents.on('before-input-event', (event, input) => {
      const isBareF12 =
        input.type === 'keyDown' &&
        (input.key === 'F12' || input.code === 'F12') &&
        !input.isAutoRepeat &&
        !input.isComposing &&
        !input.alt &&
        !input.control &&
        !input.meta &&
        !input.shift
      if (!isBareF12) return
      event.preventDefault()
      if (contents.isDevToolsOpened()) contents.closeDevTools()
      else contents.openDevTools({ mode: 'detach', activate: true })
    })
    contents.on('context-menu', (_event, params) => {
      this.showContextMenu(entry, params)
    })
    contents.setWindowOpenHandler(({ url }) => {
      if (isBrowserUrl(url)) {
        this.emit('popup', {
          popupId: randomUUID(),
          parentLabel: entry.label,
          parentNativeLabel: entry.nativeLabel,
          url,
          origin: new URL(url).origin,
          kind: 'window-open',
          strategy: 'new-tab',
          status: 'pending',
          createdAtUnixMs: Date.now(),
          warning: null,
        })
      } else {
        void shell.openExternal(url)
      }
      return { action: 'deny' }
    })
    const emitPageState = () => this.emitPageState(entry)
    contents.on('did-start-loading', emitPageState)
    contents.on('did-stop-loading', emitPageState)
    contents.on('page-title-updated', emitPageState)
    contents.on('page-title-updated', (_event, title) => {
      if (entry.historyId) void this.history.backfillTitle(entry.historyId, title)
    })
    contents.on('did-navigate', (_event, url) => {
      if (url !== entry.previewDisplayUrl) {
        entry.requestedUrl = url
        entry.previewDisplayUrl = null
        entry.previewSourceUrl = null
      }
      emitPageState()
    })
    contents.on('did-navigate-in-page', (_event, url) => {
      if (url !== entry.previewDisplayUrl) {
        entry.requestedUrl = url
        entry.previewDisplayUrl = null
        entry.previewSourceUrl = null
      }
      emitPageState()
    })
    contents.on('did-fail-load', (_event, code, message, validatedURL, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      this.recordNavigationFailure(entry, code, message, validatedURL || entry.requestedUrl)
    })
    contents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) {
        entry.navigationError = null
        entry.historyId = null
        entry.historyGeneration = this.historyGeneration
      }
    })
    contents.on('did-finish-load', () => {
      void this.recordHistoryVisit(entry)
    })
    this.entries.set(label, entry)
    // Registration, not navigation completion, is the browser host readiness boundary.
    // The requested URL is already authoritative in state() while Chromium finishes loading.
    await this.load(entry, entry.requestedUrl as string)
    return this.state(label)
  }

  private async openExisting(
    entry: BrowserEntry,
    input: BrowserOpenInput
  ): Promise<BrowserPageState> {
    entry.bounds = validBounds(input.bounds)
    entry.visible = input.visible
    if (input.navigateExisting && entry.contents.getURL() !== input.url) {
      const url = validBrowserUrl(input.url)
      entry.requestedUrl = url
      await this.load(entry, url)
    }
    return this.state(entry.label)
  }

  setBounds(label: string, bounds: BrowserBounds, visible: boolean): void {
    const entry = this.required(label)
    entry.bounds = validBounds(bounds)
    entry.visible = visible
  }

  async navigate(label: string, url: string): Promise<void> {
    const entry = this.required(label)
    const normalizedUrl = validBrowserUrl(url)
    entry.requestedUrl = normalizedUrl
    await this.load(entry, normalizedUrl)
    // Browser lifecycle events are not guaranteed to reach the renderer when
    // a preserved panel is hidden and shown again. Publish the authoritative
    // post-navigation state so bridge-driven navigation always updates its UI.
    this.emitPageState(entry)
  }

  reload(label: string): void {
    this.required(label).contents.reload()
  }

  goBack(label: string): void {
    const contents = this.required(label).contents
    if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
  }

  goForward(label: string): void {
    const contents = this.required(label).contents
    if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
  }

  setZoom(label: string, scaleFactor: number): void {
    if (!Number.isFinite(scaleFactor) || scaleFactor < 0.25 || scaleFactor > 5) {
      throw new Error('Browser zoom factor is invalid')
    }
    this.required(label).contents.setZoomFactor(scaleFactor)
  }

  async setDeviceMetrics(
    label: string,
    metrics: { width: number; height: number; scale: number } | null
  ): Promise<void> {
    const contents = this.required(label).contents
    const target = contents.debugger
    const entry = this.required(label)
    if (metrics && !target.isAttached()) {
      target.attach('1.3')
      entry.ownsDeviceMetricsDebugger = true
    }
    try {
      if (metrics) {
        if (!Number.isFinite(metrics.scale) || metrics.scale <= 0 || metrics.scale > 5) {
          throw new Error('Browser device scale is invalid')
        }
        await target.sendCommand('Emulation.setDeviceMetricsOverride', {
          width: Math.max(1, Math.round(metrics.width)),
          height: Math.max(1, Math.round(metrics.height)),
          deviceScaleFactor: 1,
          mobile: false,
          scale: metrics.scale,
        })
      } else {
        if (target.isAttached()) {
          await target.sendCommand('Emulation.clearDeviceMetricsOverride')
        }
      }
    } finally {
      if (!metrics && entry.ownsDeviceMetricsDebugger && target.isAttached()) {
        target.detach()
        entry.ownsDeviceMetricsDebugger = false
      }
    }
  }

  async evaluate(label: string, expression: string): Promise<unknown> {
    return this.required(label).contents.executeJavaScript(expression, true)
  }

  clickAt(label: string, x: number, y: number): void {
    const contents = this.required(label).contents
    const point = {
      x: Math.max(0, Math.round(x)),
      y: Math.max(0, Math.round(y)),
    }
    contents.focus()
    contents.sendInputEvent({ type: 'mouseMove', ...point })
    contents.sendInputEvent({
      type: 'mouseDown',
      ...point,
      button: 'left',
      clickCount: 1,
    })
    contents.sendInputEvent({
      type: 'mouseUp',
      ...point,
      button: 'left',
      clickCount: 1,
    })
  }

  state(label: string): BrowserPageState {
    const entry = this.required(label)
    const contents = entry.contents
    const currentUrl = contents.getURL()
    const visibleCurrentUrl =
      currentUrl === entry.previewDisplayUrl && entry.previewSourceUrl
        ? entry.previewSourceUrl
        : currentUrl
    const pendingUrl =
      entry.requestedUrl && entry.requestedUrl !== visibleCurrentUrl && !entry.navigationError
        ? entry.requestedUrl
        : null
    return {
      label: entry.label,
      nativeLabel: entry.nativeLabel,
      title: contents.getTitle() || null,
      url: pendingUrl || visibleCurrentUrl || entry.requestedUrl,
      isLoading: contents.isLoading(),
      visible: entry.visible,
      navigationError: entry.navigationError,
    }
  }

  relabel(fromLabel: string, toLabel: string): void {
    const entry = this.required(fromLabel)
    const target = requiredLabel(toLabel)
    if (this.entries.has(target)) throw new Error(`Browser label already exists: ${target}`)
    const attached = this.attachedContents.get(entry.label)
    const targetAttached = this.attachedContents.get(target)
    if (
      attached &&
      targetAttached &&
      attached.id !== targetAttached.id &&
      !targetAttached.isDestroyed()
    ) {
      targetAttached.close()
    }
    this.attachedContents.delete(entry.label)
    if (attached && !attached.isDestroyed()) this.attachedContents.set(target, attached)
    for (const [baseLabel, activeLabel] of this.activeTabs) {
      if (activeLabel === entry.label) this.activeTabs.set(baseLabel, target)
    }
    if (this.agentControlPaused.delete(entry.label)) this.agentControlPaused.add(target)
    for (const approval of this.agentApprovals.values()) {
      if (approval.label === entry.label) approval.label = target
    }
    for (const download of this.downloads.values()) {
      if (download.label === entry.label) download.label = target
    }
    this.entries.delete(entry.label)
    entry.label = target
    this.entries.set(target, entry)
    const cursorState = this.agentCursorStates.get(fromLabel)
    if (cursorState) {
      this.agentCursorStates.delete(fromLabel)
      this.agentCursorStates.set(target, cursorState)
    }
    const arrivedSequence = this.agentCursorArrivals.get(fromLabel)
    if (arrivedSequence !== undefined) {
      this.agentCursorArrivals.delete(fromLabel)
      this.agentCursorArrivals.set(target, arrivedSequence)
    }
    this.cancelAgentCursorArrivalWaiters(fromLabel)
    this.clearAgentCursorHide(fromLabel)
    if (cursorState && !this.agentActive.has(fromLabel)) this.scheduleAgentCursorHide(target)
    if (this.agentActive.delete(fromLabel)) this.agentActive.add(target)
    if (attached && !attached.isDestroyed()) this.resolveAttachmentWaiters(target, attached)
  }

  setActiveTab(baseLabel: string, activeLabel: string): void {
    const normalizedBaseLabel = requiredLabel(baseLabel)
    const normalizedActiveLabel = requiredLabel(activeLabel)
    this.activeTabs.set(normalizedBaseLabel, normalizedActiveLabel)
    const prefix = `${normalizedBaseLabel}:`
    for (const entry of this.entries.values()) {
      if (
        entry.label === normalizedBaseLabel ||
        entry.label.startsWith(prefix) ||
        entry.label.startsWith(`${normalizedBaseLabel}-`)
      ) {
        entry.visible = entry.label === normalizedActiveLabel
      }
    }
  }

  activeLabel(baseLabel: string): string {
    const normalizedBaseLabel = requiredLabel(baseLabel)
    return this.activeTabs.get(normalizedBaseLabel) ?? normalizedBaseLabel
  }

  has(label: string): boolean {
    return this.entries.has(requiredLabel(label))
  }

  isAgentControlPaused(label: string): boolean {
    return this.agentControlPaused.has(requiredLabel(label))
  }

  setAgentControlPaused(label: string, paused: boolean): void {
    const normalizedLabel = requiredLabel(label)
    if (paused) this.agentControlPaused.add(normalizedLabel)
    else this.agentControlPaused.delete(normalizedLabel)
    this.emitAgentState(normalizedLabel, paused ? 'paused' : 'idle')
  }

  consumeApprovedAgentRisk(label: string, signature: string): boolean {
    const normalizedLabel = requiredLabel(label)
    const approval = [...this.agentApprovals.values()].find(
      candidate =>
        candidate.label === normalizedLabel &&
        candidate.signature === signature &&
        candidate.approved &&
        candidate.payload.expiresAtUnixMs > Date.now()
    )
    if (!approval) return false
    this.agentApprovals.delete(approval.payload.approvalId)
    return true
  }

  registerAgentApproval(
    label: string,
    signature: string,
    action: string,
    result: Record<string, unknown>
  ): BrowserAgentApproval['payload'] | null {
    const error = result.error as { code?: unknown } | undefined
    if (error?.code !== 'approval_required') return null
    const source = (result.approval ?? {}) as Record<string, unknown>
    const payload = {
      approvalId: `browser-approval-${randomUUID()}`,
      risk: typeof source.risk === 'string' ? source.risk : 'high',
      actionKind: typeof source.actionKind === 'string' ? source.actionKind : action,
      reason:
        typeof source.reason === 'string'
          ? source.reason
          : 'This browser action may change data on the page.',
      target: source.target ?? null,
      expiresAtUnixMs: Date.now() + 60_000,
    }
    result.approval = payload
    this.agentApprovals.set(payload.approvalId, {
      label: requiredLabel(label),
      signature,
      approved: false,
      payload,
    })
    return payload
  }

  resolveAgentApproval(label: string, approvalId: string, approved: boolean): void {
    const normalizedLabel = requiredLabel(label)
    const approval = this.agentApprovals.get(approvalId)
    if (!approval) throw new Error('Browser approval request not found')
    if (approval.label !== normalizedLabel) {
      throw new Error('Browser approval request belongs to a different label')
    }
    if (approval.payload.expiresAtUnixMs <= Date.now()) {
      this.agentApprovals.delete(approvalId)
      throw new Error('Browser approval request expired')
    }
    if (approved) {
      approval.approved = true
      this.emitAgentState(normalizedLabel, 'idle', {
        action: approval.payload.actionKind,
        message: 'Browser action approved. The agent can retry it now.',
      })
      return
    }
    this.agentApprovals.delete(approvalId)
    this.emitAgentState(normalizedLabel, 'error', {
      action: approval.payload.actionKind,
      message: 'Browser action was rejected by the user.',
      errorCode: 'approval_rejected',
    })
  }

  emitAgentState(
    label: string,
    status: 'idle' | 'running' | 'paused' | 'needs_user' | 'error',
    detail: {
      action?: string | null
      target?: string | null
      message?: string | null
      errorCode?: string | null
      approval?: BrowserAgentApproval['payload'] | null
    } = {}
  ): void {
    const normalizedLabel = requiredLabel(label)
    if (status === 'running') {
      this.agentActive.add(normalizedLabel)
      this.clearAgentCursorHide(normalizedLabel)
    } else {
      this.agentActive.delete(normalizedLabel)
      if (status === 'idle') this.scheduleAgentCursorHide(normalizedLabel)
      else this.hideAgentCursor(normalizedLabel)
    }
    this.emit('agent-state', {
      label: normalizedLabel,
      status,
      action: detail.action ?? null,
      target: detail.target ?? null,
      message: detail.message ?? null,
      errorCode: detail.errorCode ?? null,
      approval: detail.approval ?? null,
      createdAtUnixMs: Date.now(),
    })
  }

  showAgentCursor(label: string, x: number, y: number): number {
    const normalizedLabel = requiredLabel(label)
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      throw new Error('Browser agent cursor coordinates are invalid')
    }
    this.clearAgentCursorHide(normalizedLabel)
    const moveSequence = ++this.agentCursorSequence
    this.agentCursorStates.set(normalizedLabel, { x, y, moveSequence })
    this.emit('agent-cursor', {
      label: normalizedLabel,
      visible: true,
      x,
      y,
      animateMovement: true,
      moveSequence,
      createdAtUnixMs: Date.now(),
    })
    return moveSequence
  }

  hideAgentCursor(label: string): void {
    const normalizedLabel = requiredLabel(label)
    this.clearAgentCursorHide(normalizedLabel)
    const state = this.agentCursorStates.get(normalizedLabel)
    if (!state) return
    this.emit('agent-cursor', {
      label: normalizedLabel,
      visible: false,
      x: state.x,
      y: state.y,
      animateMovement: false,
      moveSequence: state.moveSequence,
      createdAtUnixMs: Date.now(),
    })
  }

  notifyAgentCursorArrived(label: string, moveSequence: number): void {
    const normalizedLabel = requiredLabel(label)
    if (!Number.isInteger(moveSequence) || moveSequence < 1) {
      throw new Error('Browser agent cursor sequence is invalid')
    }
    const latest = Math.max(this.agentCursorArrivals.get(normalizedLabel) ?? 0, moveSequence)
    this.agentCursorArrivals.set(normalizedLabel, latest)
    const waiters = this.agentCursorArrivalWaiters.get(normalizedLabel)
    if (!waiters) return
    for (const waiter of waiters) {
      if (waiter.moveSequence > latest) continue
      clearTimeout(waiter.timeout)
      waiters.delete(waiter)
      waiter.resolve(true)
    }
    if (waiters.size === 0) this.agentCursorArrivalWaiters.delete(normalizedLabel)
  }

  waitForAgentCursorArrival(
    label: string,
    moveSequence: number,
    timeoutMs = 2_500
  ): Promise<boolean> {
    const normalizedLabel = requiredLabel(label)
    if ((this.agentCursorArrivals.get(normalizedLabel) ?? 0) >= moveSequence) {
      return Promise.resolve(true)
    }
    return new Promise(resolve => {
      const timeout = setTimeout(() => {
        const waiters = this.agentCursorArrivalWaiters.get(normalizedLabel)
        if (waiters) {
          for (const waiter of waiters) {
            if (waiter.moveSequence === moveSequence) waiters.delete(waiter)
          }
          if (waiters.size === 0) this.agentCursorArrivalWaiters.delete(normalizedLabel)
        }
        resolve(false)
      }, timeoutMs)
      const waiters = this.agentCursorArrivalWaiters.get(normalizedLabel) ?? new Set()
      waiters.add({ moveSequence, resolve, timeout })
      this.agentCursorArrivalWaiters.set(normalizedLabel, waiters)
    })
  }

  requestOpen(payload: Record<string, unknown>): void {
    this.emit('open-request', payload)
  }

  requestClose(label: string): void {
    const normalizedLabel = requiredLabel(label)
    const entry = this.entries.get(normalizedLabel)
    this.close(normalizedLabel)
    if (entry) {
      this.emit('close-request', {
        label: normalizedLabel,
        nativeLabel: entry.nativeLabel,
      })
    }
  }

  close(label: string, expectedNativeLabel?: string | null): void {
    const entry = this.entries.get(label)
    if (!entry) return
    if (expectedNativeLabel && entry.nativeLabel !== expectedNativeLabel) return
    this.entries.delete(label)
    this.clearLabelScopedState(label)
    if (!entry.contents.isDestroyed()) entry.contents.close()
  }

  private clearLabelScopedState(label: string): void {
    this.agentControlPaused.delete(label)
    this.agentActive.delete(label)
    this.clearAgentCursorHide(label)
    this.agentCursorStates.delete(label)
    this.agentCursorArrivals.delete(label)
    this.cancelAgentCursorArrivalWaiters(label)
    for (const [approvalId, approval] of this.agentApprovals) {
      if (approval.label === label) this.agentApprovals.delete(approvalId)
    }
    this.attachedContents.delete(label)
    this.rejectAttachmentWaiters(
      label,
      new Error(`Embedded browser webview was closed before attachment: ${label}`)
    )
  }

  closeMany(labels: string[]): void {
    for (const label of labels) this.close(label)
  }

  private scheduleAgentCursorHide(label: string): void {
    const normalizedLabel = requiredLabel(label)
    this.clearAgentCursorHide(normalizedLabel)
    if (!this.agentCursorStates.has(normalizedLabel)) return
    const timer = setTimeout(() => {
      this.agentCursorHideTimers.delete(normalizedLabel)
      this.hideAgentCursor(normalizedLabel)
    }, AGENT_CURSOR_IDLE_HIDE_MS)
    this.agentCursorHideTimers.set(normalizedLabel, timer)
  }

  private clearAgentCursorHide(label: string): void {
    const timer = this.agentCursorHideTimers.get(label)
    if (!timer) return
    clearTimeout(timer)
    this.agentCursorHideTimers.delete(label)
  }

  private cancelAgentCursorArrivalWaiters(label: string): void {
    const waiters = this.agentCursorArrivalWaiters.get(label)
    if (!waiters) return
    this.agentCursorArrivalWaiters.delete(label)
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout)
      waiter.resolve(false)
    }
  }

  async clearData(kinds: string[] | null): Promise<number> {
    const clearAll = !kinds || kinds.length === 0
    if (clearAll || kinds.includes('history')) {
      this.historyGeneration += 1
      await this.history.clear()
    }
    const storages = kinds?.flatMap(kind => {
      if (kind === 'cookies') return ['cookies'] as const
      if (kind === 'cache') return ['serviceworkers', 'cachestorage', 'shadercache'] as const
      if (kind === 'storage') {
        return ['localstorage', 'indexdb', 'filesystem'] as const
      }
      return []
    })
    const browserSession = session.fromPartition(EMBEDDED_BROWSER_PARTITION)
    if (clearAll || storages?.length) {
      await browserSession.clearStorageData({
        ...(storages?.length ? { storages: [...new Set(storages)] } : {}),
      })
    }
    if (clearAll || kinds.includes('cache')) await browserSession.clearCache()
    return this.entries.size
  }

  searchHistory(input: BrowserHistorySearch): Promise<BrowserHistoryEntry[]> {
    return this.history.search(input)
  }

  removeHistory(ids: string[]): Promise<number> {
    return this.history.remove(ids)
  }

  async capture(label: string, rect?: BrowserBounds): Promise<string> {
    const entry = this.required(label)
    return captureWebContentsDataUrl(entry.contents, { rect })
  }

  labelForContentsId(contentsId: number): string | null {
    return [...this.entries.values()].find(entry => entry.contents.id === contentsId)?.label ?? null
  }

  send(label: string, channel: string, payload: unknown): void {
    this.required(label).contents.send(channel, payload)
  }

  pageRectToScreen(
    label: string,
    rect: BrowserBounds
  ): { x: number; y: number; width: number; height: number } {
    const entry = this.required(label)
    const hostContents = entry.contents.hostWebContents
    const owner = hostContents ? BrowserWindow.fromWebContents(hostContents) : null
    const contentBounds = owner?.getContentBounds() ?? { x: 0, y: 0, width: 0, height: 0 }
    return {
      x: contentBounds.x + entry.bounds.x + rect.x,
      y: contentBounds.y + entry.bounds.y + rect.y,
      width: rect.width,
      height: rect.height,
    }
  }

  async verifyDetachedInspector(label: string): Promise<{
    beforeFrame: number[]
    afterFrame: number[]
    visible: boolean
    beforeWindowCount: number
    afterWindowCount: number
    closedVisible: boolean
  }> {
    const entry = this.required(this.activeLabel(label))
    const contents = entry.contents
    const beforeFrame = await waitForSettledFrame(entry, 5_000)
    const beforeWindowCount = this.nativeWindowCount()
    contents.openDevTools({ mode: 'detach', activate: true })
    await waitForState(
      () => contents.isDevToolsOpened() && contents.devToolsWebContents !== null,
      5_000,
      'Timed out waiting for detached embedded browser Inspector'
    )
    await waitForStableFrame(entry, beforeFrame, 5_000)
    const afterFrame = browserFrame(entry.bounds)
    const afterWindowCount = this.nativeWindowCount()
    contents.closeDevTools()
    await waitForState(
      () => !contents.isDevToolsOpened(),
      5_000,
      'Timed out closing detached embedded browser Inspector'
    )
    return {
      beforeFrame,
      afterFrame,
      visible: true,
      beforeWindowCount,
      afterWindowCount,
      closedVisible: contents.isDevToolsOpened(),
    }
  }

  private nativeWindowCount(): number {
    const detachedInspectors = [...this.entries.values()].filter(entry => {
      const contents = entry.contents
      return contents.isDevToolsOpened() && contents.devToolsWebContents !== null
    }).length
    return BrowserWindow.getAllWindows().length + detachedInspectors
  }

  pauseDownload(id: string): void {
    const download = this.requiredDownload(id)
    if (download.item.getState() === 'progressing') {
      download.item.pause()
      this.emitDownload(download, 'paused')
    }
  }

  resumeDownload(id: string): void {
    const download = this.requiredDownload(id)
    if (!download.item.canResume()) {
      throw new Error(`Embedded browser download cannot resume: ${id}`)
    }
    download.item.resume()
    this.emitDownload(download, 'progress')
  }

  async deleteDownload(id: string): Promise<void> {
    const download = this.requiredDownload(id)
    if (download.item.getState() === 'progressing') download.item.cancel()
    if (download.path) await rm(download.path, { force: true })
    this.emitDownload(download, 'deleted')
    this.downloads.delete(id)
  }

  layoutAll(): void {
    // Renderer-owned <webview> elements follow their DOM layout automatically.
  }

  stop(): void {
    for (const download of this.downloads.values()) {
      if (download.item.getState() === 'progressing') download.item.cancel()
    }
    this.downloads.clear()
    for (const id of [...this.backgroundPages.keys()]) this.closeBackgroundPage(id)
    this.requestHeaderRules.clear()
    this.closeMany([...this.entries.keys()])
    for (const [label, waiters] of this.attachmentWaiters) {
      for (const waiter of waiters) {
        clearTimeout(waiter.timeout)
        waiter.reject(new Error(`Embedded browser stopped before webview attached: ${label}`))
      }
    }
    this.attachmentWaiters.clear()
  }

  private required(label: string): BrowserEntry {
    const normalized = requiredLabel(label)
    const entry = this.entries.get(normalized)
    if (!entry) throw new Error(`Embedded browser is unavailable: ${normalized}`)
    return entry
  }

  private trackDownload(entry: BrowserEntry, item: DownloadItem): void {
    const download: BrowserDownload = {
      id: randomUUID(),
      item,
      label: entry.label,
      nativeLabel: entry.nativeLabel,
      path: item.getSavePath() || null,
    }
    this.downloads.set(download.id, download)
    this.emitDownload(download, 'started')
    item.on('updated', (_event, state) => {
      download.path = item.getSavePath() || download.path
      this.emitDownload(download, state === 'interrupted' ? 'failed' : 'progress')
    })
    item.once('done', (_event, state) => {
      download.path = item.getSavePath() || download.path
      this.emitDownload(download, state === 'completed' ? 'finished' : 'failed')
    })
  }

  private requiredDownload(id: string): BrowserDownload {
    const download = this.downloads.get(id)
    if (!download) {
      throw new Error(`Embedded browser download is unavailable: ${id}`)
    }
    return download
  }

  private emitDownload(
    download: BrowserDownload,
    status: 'started' | 'progress' | 'paused' | 'finished' | 'failed' | 'deleted'
  ): void {
    this.emit('download', {
      id: download.id,
      label: download.label,
      nativeLabel: download.nativeLabel,
      url: download.item.getURL(),
      path: download.path,
      status,
      receivedBytes: download.item.getReceivedBytes(),
      totalBytes: download.item.getTotalBytes(),
    })
  }

  private emitPageState(entry: BrowserEntry): void {
    if (this.entries.get(entry.label) !== entry) return
    this.emit('page-state', this.state(entry.label) as unknown as Record<string, unknown>)
  }

  private async load(entry: BrowserEntry, url: string): Promise<void> {
    try {
      const navigation = await prepareLocalFileNavigation(url)
      if (navigation.kind === 'blocked') {
        entry.requestedUrl = this.currentVisibleUrl(entry)
        this.emit('local-file-preview', {
          label: entry.label,
          nativeLabel: entry.nativeLabel,
          url: navigation.sourceUrl,
        })
        return
      }
      entry.previewDisplayUrl = navigation.kind === 'preview' ? navigation.displayUrl : null
      entry.previewSourceUrl = navigation.kind === 'preview' ? navigation.sourceUrl : null
      await entry.contents.loadURL(navigation.displayUrl)
    } catch (error) {
      if (!entry.navigationError) {
        const message = error instanceof Error ? error.message : String(error)
        const code = Number(message.match(/\((-?\d+)\)/)?.[1] ?? -2)
        this.recordNavigationFailure(entry, code, message, url)
      }
    }
  }

  private currentVisibleUrl(entry: BrowserEntry): string | null {
    const currentUrl = entry.contents.getURL()
    if (currentUrl === entry.previewDisplayUrl && entry.previewSourceUrl) {
      return entry.previewSourceUrl
    }
    return currentUrl || null
  }

  private async recordHistoryVisit(entry: BrowserEntry): Promise<void> {
    const url = this.currentVisibleUrl(entry)
    if (
      !url ||
      !isHistoryRecordableUrl(url) ||
      entry.historyGeneration !== this.historyGeneration
    ) {
      return
    }
    const historyId = await this.history.recordVisit(url, Date.now(), entry.contents.getTitle())
    if (entry.historyGeneration === this.historyGeneration) entry.historyId = historyId
  }

  private recordNavigationFailure(
    entry: BrowserEntry,
    code: number,
    message: string,
    url: string | null
  ): void {
    entry.navigationError = { code, message, url }
    this.emitPageState(entry)
  }

  private showContextMenu(entry: BrowserEntry, params: ContextMenuParams): void {
    const contents = entry.contents
    const labels = embeddedBrowserContextMenuLabels(app.getLocale())
    const requestAnnotation = (mode: 'quick' | 'batch') => {
      this.emit('annotation-request', {
        label: entry.label,
        nativeLabel: entry.nativeLabel,
        mode,
        x: params.x,
        y: params.y,
      })
    }
    const items: MenuItemConstructorOptions[] = [
      {
        label: labels.quickAnnotate,
        click: () => requestAnnotation('quick'),
      },
      {
        label: labels.annotate,
        click: () => requestAnnotation('batch'),
      },
      { type: 'separator' },
    ]
    if (isPlainBrowserContext(params)) {
      items.push(
        {
          label: labels.back,
          enabled: contents.navigationHistory.canGoBack(),
          click: () => contents.navigationHistory.goBack(),
        },
        {
          label: labels.forward,
          enabled: contents.navigationHistory.canGoForward(),
          click: () => contents.navigationHistory.goForward(),
        },
        {
          label: labels.reload,
          enabled: Boolean(this.currentVisibleUrl(entry) || entry.requestedUrl),
          click: () => contents.reload(),
        },
        { type: 'separator' }
      )
    }
    items.push({
      label: labels.inspect,
      click: () => contents.inspectElement(params.x, params.y),
    })
    Menu.buildFromTemplate(items).popup()
  }

  private emit(type: BrowserHostEvent['type'], payload: Record<string, unknown>): void {
    this.onEvent({
      sequence: ++this.eventSequence,
      type,
      payload,
    })
  }

  private waitForAttachedContents(label: string): Promise<WebContents> {
    const attached = this.attachedContents.get(label)
    if (attached && !attached.isDestroyed()) return Promise.resolve(attached)
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        const waiters = this.attachmentWaiters.get(label)
        if (waiters) {
          for (const waiter of waiters) {
            if (waiter.resolve === resolve) waiters.delete(waiter)
          }
          if (waiters.size === 0) this.attachmentWaiters.delete(label)
        }
        reject(new Error(`Timed out waiting for embedded browser webview: ${label}`))
      }, 5_000)
      const waiters = this.attachmentWaiters.get(label) ?? new Set()
      waiters.add({ resolve, reject, timeout })
      this.attachmentWaiters.set(label, waiters)
    })
  }

  private resolveAttachmentWaiters(label: string, contents: WebContents): void {
    const waiters = this.attachmentWaiters.get(label)
    if (!waiters) return
    this.attachmentWaiters.delete(label)
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout)
      waiter.resolve(contents)
    }
  }

  private rejectAttachmentWaiters(label: string, error: Error): void {
    const waiters = this.attachmentWaiters.get(label)
    if (!waiters) return
    this.attachmentWaiters.delete(label)
    for (const waiter of waiters) {
      clearTimeout(waiter.timeout)
      waiter.reject(error)
    }
  }
}

function validateRequestHeaderRule(rule: BrowserRequestHeaderRule): void {
  if (!/^[a-zA-Z0-9._:-]{1,160}$/.test(rule.id)) {
    throw new Error('Browser request header rule id is invalid')
  }
  if (rule.origins.length === 0 || rule.pathPrefixes.length === 0) {
    throw new Error('Browser request header rule must include origins and path prefixes')
  }
  for (const origin of rule.origins) {
    const parsed = new URL(origin)
    if (
      parsed.origin !== origin ||
      !['http:', 'https:'].includes(parsed.protocol) ||
      (parsed.protocol === 'http:' && rule.allowInsecure !== true)
    ) {
      throw new Error(
        'Browser request header rule origin must be HTTPS unless insecure HTTP is explicitly allowed'
      )
    }
  }
  if (rule.pathPrefixes.some(prefix => !prefix.startsWith('/'))) {
    throw new Error('Browser request header rule path prefix is invalid')
  }
  const forbidden = new Set([
    'connection',
    'content-length',
    'cookie',
    'host',
    'proxy-authorization',
  ])
  for (const [name, value] of Object.entries(rule.headers)) {
    if (
      !/^[a-zA-Z0-9-]+$/.test(name) ||
      forbidden.has(name.toLowerCase()) ||
      value.includes('\r') ||
      value.includes('\n')
    ) {
      throw new Error('Browser request header rule contains an invalid header')
    }
  }
}

function browserFrame(bounds: BrowserBounds): number[] {
  return [bounds.x, bounds.y, bounds.width, bounds.height]
}

async function waitForState(
  predicate: () => boolean,
  timeoutMs: number,
  message: string
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(message)
}

async function waitForStableFrame(
  entry: BrowserEntry,
  expectedFrame: number[],
  timeoutMs: number
): Promise<void> {
  const deadline = Date.now() + timeoutMs
  let stableSamples = 0
  while (Date.now() <= deadline) {
    const frame = browserFrame(entry.bounds)
    if (frame.every((value, index) => value === expectedFrame[index])) {
      stableSamples += 1
      if (stableSamples >= 10) return
    } else {
      stableSamples = 0
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(
    `Detached embedded browser Inspector changed the browser frame: expected=${expectedFrame.join(
      ','
    )} actual=${browserFrame(entry.bounds).join(',')}`
  )
}

async function waitForSettledFrame(entry: BrowserEntry, timeoutMs: number): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  let frame = browserFrame(entry.bounds)
  let stableSamples = 0
  while (Date.now() <= deadline) {
    const currentFrame = browserFrame(entry.bounds)
    if (currentFrame.every((value, index) => value === frame[index])) {
      stableSamples += 1
      if (stableSamples >= 20) return currentFrame
    } else {
      frame = currentFrame
      stableSamples = 1
    }
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(
    `Timed out waiting for embedded browser frame to settle: actual=${frame.join(',')}`
  )
}

function validBounds(bounds: BrowserBounds): BrowserBounds {
  if (
    !bounds ||
    ![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite) ||
    bounds.width < 0 ||
    bounds.height < 0
  ) {
    throw new Error('Embedded browser bounds are invalid')
  }
  return { ...bounds }
}

function requiredLabel(label: string): string {
  const value = label?.trim()
  if (!value || value.length > 160) throw new Error('Embedded browser label is invalid')
  return value
}

function requiredBackgroundPageId(id: string): string {
  const value = id?.trim()
  if (!value || !/^[a-zA-Z0-9._:-]{1,160}$/.test(value)) {
    throw new Error('Browser background page id is invalid')
  }
  return value
}

function requiredUserAgent(userAgent: string): string {
  const value = userAgent?.trim()
  if (!value || value.length > 4096 || /[\r\n]/.test(value)) {
    throw new Error('Browser user agent is invalid')
  }
  return value
}

function validBrowserUrl(value: string): string {
  const url = new URL(value)
  if (!isBrowserUrl(url.toString())) {
    throw new Error(`Embedded browser URL protocol is not allowed: ${url.protocol}`)
  }
  return url.toString()
}

function validRemoteBrowserUrl(value: string): string {
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error(`Browser background page URL protocol is not allowed: ${url.protocol}`)
  }
  return url.toString()
}

function isBrowserUrl(value: string): boolean {
  try {
    return ['http:', 'https:', 'file:', 'about:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}

interface EmbeddedBrowserContextMenuLabels {
  quickAnnotate: string
  annotate: string
  back: string
  forward: string
  reload: string
  inspect: string
}

function embeddedBrowserContextMenuLabels(language: string): EmbeddedBrowserContextMenuLabels {
  if (language.trim().toLowerCase().startsWith('zh')) {
    return {
      quickAnnotate: '快速评论',
      annotate: '评论',
      back: '返回',
      forward: '前进',
      reload: '重新加载',
      inspect: '检查',
    }
  }
  return {
    quickAnnotate: 'Quick annotate',
    annotate: 'Annotate',
    back: 'Back',
    forward: 'Forward',
    reload: 'Reload',
    inspect: 'Inspect',
  }
}

function isPlainBrowserContext(params: ContextMenuParams): boolean {
  return (
    !params.isEditable &&
    params.formControlType === 'none' &&
    params.mediaType === 'none' &&
    !params.linkURL &&
    !params.srcURL &&
    !params.selectionText.trim()
  )
}

function isHistoryRecordableUrl(value: string): boolean {
  try {
    return ['http:', 'https:', 'file:'].includes(new URL(value).protocol)
  } catch {
    return false
  }
}
