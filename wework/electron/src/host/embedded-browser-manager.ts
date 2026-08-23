import { BrowserWindow, session, shell, WebContentsView, type DownloadItem } from 'electron'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { prepareLocalFileNavigation } from './local-file-preview.js'

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
  navigationError: {
    code: number
    message: string
    url: string | null
  } | null
}

interface BrowserEntry {
  label: string
  nativeLabel: string
  view: WebContentsView
  bounds: BrowserBounds
  visible: boolean
  ready: boolean
  requestedUrl: string | null
  previewDisplayUrl: string | null
  previewSourceUrl: string | null
  ownsDeviceMetricsDebugger: boolean
  navigationError: BrowserPageState['navigationError']
}

export interface BrowserHostEvent {
  sequence: number
  type:
    | 'agent-state'
    | 'close-request'
    | 'download'
    | 'local-file-preview'
    | 'open-request'
    | 'page-state'
    | 'popup'
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

interface BrowserDownload {
  id: string
  item: DownloadItem
  label: string
  nativeLabel: string
  path: string | null
}

const MAX_EVENTS = 1024

export class EmbeddedBrowserManager {
  private readonly entries = new Map<string, BrowserEntry>()
  private readonly activeTabs = new Map<string, string>()
  private readonly downloads = new Map<string, BrowserDownload>()
  private readonly agentControlPaused = new Set<string>()
  private readonly agentApprovals = new Map<string, BrowserAgentApproval>()
  private readonly events: BrowserHostEvent[] = []
  private eventSequence = 0

  constructor(
    private readonly window: () => BrowserWindow | null,
    private readonly contentOffset: () => { x: number; y: number }
  ) {
    session.defaultSession.on('will-download', (_event, item, webContents) => {
      const entry = [...this.entries.values()].find(
        candidate => candidate.view.webContents.id === webContents.id
      )
      if (entry) this.trackDownload(entry, item)
    })
  }

  async open(input: {
    label: string
    url: string
    bounds: BrowserBounds
    visible: boolean
    navigateExisting: boolean
  }): Promise<BrowserPageState> {
    const label = requiredLabel(input.label)
    const existing = this.entries.get(label)
    if (existing) {
      existing.bounds = validBounds(input.bounds)
      existing.visible = input.visible
      this.layout(existing)
      if (input.navigateExisting && existing.view.webContents.getURL() !== input.url) {
        const url = validBrowserUrl(input.url)
        existing.requestedUrl = url
        await this.load(existing, url)
      }
      return this.state(label)
    }
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
      },
    })
    const entry: BrowserEntry = {
      label,
      nativeLabel: `electron-browser-${randomUUID()}`,
      view,
      bounds: validBounds(input.bounds),
      visible: input.visible,
      ready: false,
      requestedUrl: validBrowserUrl(input.url),
      previewDisplayUrl: null,
      previewSourceUrl: null,
      ownsDeviceMetricsDebugger: false,
      navigationError: null,
    }
    view.webContents.setWindowOpenHandler(({ url }) => {
      if (isBrowserUrl(url)) {
        this.emit('popup', {
          popupId: randomUUID(),
          parentLabel: entry.label,
          parentNativeLabel: entry.label,
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
    view.webContents.on('did-start-loading', emitPageState)
    view.webContents.on('did-stop-loading', emitPageState)
    view.webContents.on('page-title-updated', emitPageState)
    view.webContents.on('did-navigate', (_event, url) => {
      if (url !== entry.previewDisplayUrl) {
        entry.requestedUrl = url
        entry.previewDisplayUrl = null
        entry.previewSourceUrl = null
      }
      emitPageState()
    })
    view.webContents.on('did-navigate-in-page', (_event, url) => {
      if (url !== entry.previewDisplayUrl) {
        entry.requestedUrl = url
        entry.previewDisplayUrl = null
        entry.previewSourceUrl = null
      }
      emitPageState()
    })
    view.webContents.on('did-fail-load', (_event, code, message, validatedURL, isMainFrame) => {
      if (!isMainFrame || code === -3) return
      this.recordNavigationFailure(entry, code, message, validatedURL || entry.requestedUrl)
    })
    view.webContents.on('did-start-navigation', (_event, _url, _inPlace, isMainFrame) => {
      if (isMainFrame) entry.navigationError = null
    })
    this.entries.set(label, entry)
    this.attach(entry)
    await this.load(entry, entry.requestedUrl as string)
    entry.ready = true
    return this.state(label)
  }

  setBounds(label: string, bounds: BrowserBounds, visible: boolean): void {
    const entry = this.required(label)
    entry.bounds = validBounds(bounds)
    entry.visible = visible
    this.layout(entry)
  }

  async navigate(label: string, url: string): Promise<void> {
    const entry = this.required(label)
    const normalizedUrl = validBrowserUrl(url)
    entry.requestedUrl = normalizedUrl
    await this.load(entry, normalizedUrl)
  }

  reload(label: string): void {
    this.required(label).view.webContents.reload()
  }

  goBack(label: string): void {
    const contents = this.required(label).view.webContents
    if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack()
  }

  goForward(label: string): void {
    const contents = this.required(label).view.webContents
    if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward()
  }

  setZoom(label: string, scaleFactor: number): void {
    if (!Number.isFinite(scaleFactor) || scaleFactor < 0.25 || scaleFactor > 5) {
      throw new Error('Browser zoom factor is invalid')
    }
    this.required(label).view.webContents.setZoomFactor(scaleFactor)
  }

  async setDeviceMetrics(
    label: string,
    metrics: { width: number; height: number } | null
  ): Promise<void> {
    const contents = this.required(label).view.webContents
    const target = contents.debugger
    const entry = this.required(label)
    if (metrics && !target.isAttached()) {
      target.attach('1.3')
      entry.ownsDeviceMetricsDebugger = true
    }
    try {
      if (metrics) {
        await target.sendCommand('Emulation.setDeviceMetricsOverride', {
          width: Math.max(1, Math.round(metrics.width)),
          height: Math.max(1, Math.round(metrics.height)),
          deviceScaleFactor: 1,
          mobile: false,
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
    return this.required(label).view.webContents.executeJavaScript(expression, true)
  }

  state(label: string): BrowserPageState {
    const entry = this.required(label)
    const contents = entry.view.webContents
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
      navigationError: entry.navigationError,
    }
  }

  relabel(fromLabel: string, toLabel: string): void {
    const entry = this.required(fromLabel)
    const target = requiredLabel(toLabel)
    if (this.entries.has(target)) throw new Error(`Browser label already exists: ${target}`)
    this.entries.delete(entry.label)
    entry.label = target
    this.entries.set(target, entry)
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
        this.layout(entry)
      }
    }
  }

  activeLabel(baseLabel: string): string {
    const normalizedBaseLabel = requiredLabel(baseLabel)
    return this.activeTabs.get(normalizedBaseLabel) ?? normalizedBaseLabel
  }

  has(label: string): boolean {
    return this.entries.get(requiredLabel(label))?.ready === true
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
    this.emit('agent-state', {
      label: requiredLabel(label),
      status,
      action: detail.action ?? null,
      target: detail.target ?? null,
      message: detail.message ?? null,
      errorCode: detail.errorCode ?? null,
      approval: detail.approval ?? null,
      createdAtUnixMs: Date.now(),
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

  close(label: string): void {
    const entry = this.entries.get(label)
    if (!entry) return
    this.entries.delete(label)
    this.agentControlPaused.delete(label)
    for (const [approvalId, approval] of this.agentApprovals) {
      if (approval.label === label) this.agentApprovals.delete(approvalId)
    }
    const target = this.window()
    if (target && !target.isDestroyed()) target.contentView.removeChildView(entry.view)
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close()
  }

  closeMany(labels: string[]): void {
    for (const label of labels) this.close(label)
  }

  async clearData(kinds: string[] | null): Promise<number> {
    const storages = kinds?.flatMap(kind => {
      if (kind === 'cookies') return ['cookies'] as const
      if (kind === 'cache') return ['serviceworkers', 'cachestorage', 'shadercache'] as const
      if (kind === 'storage') {
        return ['localstorage', 'indexdb', 'filesystem'] as const
      }
      return []
    })
    await session.defaultSession.clearStorageData({
      ...(storages?.length ? { storages: [...new Set(storages)] } : {}),
    })
    if (!kinds || kinds.includes('cache')) await session.defaultSession.clearCache()
    return this.entries.size
  }

  async capture(label: string): Promise<string> {
    const entry = this.required(label)
    const target = entry.view.webContents.debugger
    const ownsAttachment = !target.isAttached()
    if (ownsAttachment) target.attach('1.3')
    try {
      await target.sendCommand('Page.bringToFront')
      const result = (await target.sendCommand('Page.captureScreenshot', {
        captureBeyondViewport: false,
        format: 'png',
        fromSurface: true,
      })) as { data?: unknown }
      if (typeof result.data !== 'string' || result.data.length === 0) {
        throw new Error('Embedded browser screenshot returned no image data')
      }
      return `data:image/png;base64,${result.data}`
    } finally {
      if (ownsAttachment && target.isAttached()) target.detach()
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
    const contents = entry.view.webContents
    const beforeFrame = await stableBrowserFrame(entry.view)
    const beforeWindowCount = this.nativeWindowCount()
    contents.openDevTools({ mode: 'detach', activate: true })
    await waitForState(
      () => contents.isDevToolsOpened() && contents.devToolsWebContents !== null,
      5_000,
      'Timed out waiting for detached embedded browser Inspector'
    )
    const afterFrame = browserFrame(entry.view.getBounds())
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
      const contents = entry.view.webContents
      return contents.isDevToolsOpened() && contents.devToolsWebContents !== null
    }).length
    return BrowserWindow.getAllWindows().length + detachedInspectors
  }

  readEvents(after: number): {
    events: BrowserHostEvent[]
    latestSequence: number
    historyLost: boolean
  } {
    const earliest = this.events[0]?.sequence ?? this.eventSequence + 1
    return {
      events: this.events.filter(event => event.sequence > after),
      latestSequence: this.eventSequence,
      historyLost: after > 0 && after < earliest - 1,
    }
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
    for (const entry of this.entries.values()) this.layout(entry)
  }

  stop(): void {
    for (const download of this.downloads.values()) {
      if (download.item.getState() === 'progressing') download.item.cancel()
    }
    this.downloads.clear()
    this.closeMany([...this.entries.keys()])
  }

  private required(label: string): BrowserEntry {
    const normalized = requiredLabel(label)
    const entry = this.entries.get(normalized)
    if (!entry) throw new Error(`Embedded browser is unavailable: ${normalized}`)
    return entry
  }

  private attach(entry: BrowserEntry): void {
    const target = this.window()
    if (!target || target.isDestroyed()) throw new Error('Desktop window is unavailable')
    target.contentView.addChildView(entry.view)
    this.layout(entry)
  }

  private layout(entry: BrowserEntry): void {
    const offset = this.contentOffset()
    entry.view.setBounds({
      x: Math.round(offset.x + entry.bounds.x),
      y: Math.round(offset.y + entry.bounds.y),
      width: entry.visible ? Math.max(0, Math.round(entry.bounds.width)) : 0,
      height: entry.visible ? Math.max(0, Math.round(entry.bounds.height)) : 0,
    })
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
    if (!this.entries.has(entry.label)) return
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
      await entry.view.webContents.loadURL(navigation.displayUrl)
    } catch (error) {
      if (!entry.navigationError) {
        const message = error instanceof Error ? error.message : String(error)
        const code = Number(message.match(/\((-?\d+)\)/)?.[1] ?? -2)
        this.recordNavigationFailure(entry, code, message, url)
      }
    }
  }

  private currentVisibleUrl(entry: BrowserEntry): string | null {
    const currentUrl = entry.view.webContents.getURL()
    if (currentUrl === entry.previewDisplayUrl && entry.previewSourceUrl) {
      return entry.previewSourceUrl
    }
    return currentUrl || null
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

  private emit(type: BrowserHostEvent['type'], payload: Record<string, unknown>): void {
    this.events.push({
      sequence: ++this.eventSequence,
      type,
      payload,
    })
    if (this.events.length > MAX_EVENTS) this.events.shift()
  }
}

function browserFrame(bounds: BrowserBounds): number[] {
  return [bounds.x, bounds.y, bounds.width, bounds.height]
}

async function stableBrowserFrame(view: WebContentsView): Promise<number[]> {
  let previous = browserFrame(view.getBounds())
  let stableSamples = 0
  const deadline = Date.now() + 5_000
  while (Date.now() <= deadline) {
    await new Promise(resolve => setTimeout(resolve, 50))
    const current = browserFrame(view.getBounds())
    if (current.every((value, index) => value === previous[index])) {
      stableSamples += 1
      if (stableSamples >= 15) return current
    } else {
      previous = current
      stableSamples = 0
    }
  }
  throw new Error('Timed out waiting for embedded browser frame to stabilize')
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

function validBrowserUrl(value: string): string {
  const url = new URL(value)
  if (!isBrowserUrl(url.toString())) {
    throw new Error(`Embedded browser URL protocol is not allowed: ${url.protocol}`)
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
