import type { BrowserWindow, WebContents, WebFrameMain } from 'electron'
import type { WorkbenchService } from './workbench-application-contract.js'
import { pendingWorkbenchInstallationWindow } from './workbench-installation.js'
import { evaluateWorkbenchPage } from './e2e-workbench-page.js'
import { LIGHTWEIGHT_WORKBENCH_FRAME_NAME } from './lightweight-workbench-client.js'

const STEP_TIMEOUT_MS = 10_000

interface WorkbenchControlHost extends WorkbenchService {
  windowForId(id: string): BrowserWindow | null
  contentsForId(id: string): WebContents | null
  isViewVisible(id: string): boolean
}

export async function controlWorkbenchApp(
  host: WorkbenchControlHost | null,
  params: Record<string, unknown>,
  routeScheme: (url: string) => boolean
): Promise<unknown> {
  if (process.env.VITE_WEWORK_E2E !== 'true' || !process.env.WEWORK_E2E_CONTROL_URL)
    throw new Error('Workbench E2E control is disabled')
  if (!host) throw new Error('Workbench host is unavailable')
  if (params.action === 'installation') {
    const prompt = pendingWorkbenchInstallationWindow()
    if (!prompt || prompt.isDestroyed()) return { visible: false, ready: false }
    if (params.choice !== undefined) {
      if (!['accept', 'cancel'].includes(String(params.choice)))
        throw new Error('Invalid installation choice')
      const testId =
        params.choice === 'accept' ? 'workbench-install-accept' : 'workbench-install-cancel'
      await clickInstallationButton(prompt, testId)
      return { clicked: true }
    }
    return {
      visible: prompt.isVisible(),
      ready: await prompt.webContents.executeJavaScript(
        'Boolean(document.querySelector(\'[data-testid="workbench-install-accept"]\'))'
      ),
    }
  }
  if (params.action === 'scheme') {
    if (typeof params.url !== 'string' || !routeScheme(params.url))
      throw new Error('Expected a Workbench scheme URL')
    return { queued: true }
  }
  if (typeof params.id !== 'string') throw new Error('Workbench installation id is required')
  const window = host.windowForId(params.id)
  const contents = host.contentsForId(params.id)
  const installation = (await host.list()).find(item => item.id === params.id)
  const available = contents && !contents.isDestroyed()
  if (params.action === 'snapshot') {
    const frame =
      available && installation?.flavor === 'lightweight' && !contents.isLoadingMainFrame()
        ? contents.mainFrame.frames.find(frame => frame.name === LIGHTWEIGHT_WORKBENCH_FRAME_NAME)
        : undefined
    return {
      running: installation?.state === 'running',
      visible: host.isViewVisible(params.id),
      url: available ? contents.getURL() : null,
      contentsId: available ? contents.id : null,
      presentation: installation?.presentation ?? null,
      sdkAvailable:
        available &&
        frame &&
        !frame.isDestroyed() &&
        !frame.detached &&
        frame.url === 'about:srcdoc'
          ? Boolean(await evaluateWorkbenchPage(contents, 'Boolean(window.weworkWorkbench)'))
          : false,
    }
  }
  if (!available) throw new Error('Workbench window is not running')
  if (params.action === 'close') {
    if (!window || window.isDestroyed())
      throw new Error('Workbench is not in an independent window')
    window.close()
    return { closed: true }
  }
  if (params.action === 'document') {
    return evaluateWorkbenchPage(
      contents,
      'Promise.resolve().then(async () => ({ sdk: Boolean(window.weworkWorkbench), text: document.body.textContent, state: await window.weworkWorkbench?.storage.get() }))'
    )
  }
  if (params.action === 'capture') return (await contents.capturePage()).toDataURL()
  if (params.action === 'setWindowValue' || params.action === 'getWindowValue') {
    if (typeof params.key !== 'string' || !/^__wework[A-Za-z0-9_]{1,100}$/.test(params.key))
      throw new Error('Expected an E2E workbench state key')
    const key = JSON.stringify(params.key)
    return evaluateWorkbenchPage(
      contents,
      params.action === 'setWindowValue'
        ? `(window[${key}] = ${JSON.stringify(params.value)})`
        : `window[${key}]`
    )
  }
  if (typeof params.selector !== 'string' || params.selector.length > 1000)
    throw new Error('Workbench selector is required')
  const selector = JSON.stringify(params.selector)
  switch (params.action) {
    case 'getText':
      return evaluateWorkbenchPage(
        contents,
        `document.querySelector(${selector})?.textContent ?? null`
      )
    case 'getValue':
      return evaluateWorkbenchPage(contents, `document.querySelector(${selector})?.value ?? null`)
    case 'click':
      return clickWorkbenchElement(contents, selector)
    case 'clickAndWaitForBlockedNavigation':
      if (typeof params.url !== 'string') throw new Error('Expected navigation URL is required')
      return clickAndWaitForBlockedNavigation(contents, selector, params.url)
    case 'fill': {
      if (typeof params.value !== 'string') throw new Error('Workbench input value must be text')
      return evaluateWorkbenchPage(
        contents,
        `(() => {
        const target = document.querySelector(${selector})
        if (!(target instanceof window.HTMLInputElement) || target.disabled) throw new Error('Workbench input is unavailable')
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set.call(target, ${JSON.stringify(params.value)})
        target.dispatchEvent(new window.Event('input', { bubbles: true }))
        target.dispatchEvent(new window.Event('change', { bubbles: true }))
        return true
      })()`
      )
    }
    default:
      throw new Error('Unknown Workbench control action')
  }
}

async function clickInstallationButton(window: BrowserWindow, testId: string): Promise<void> {
  const position = await window.webContents.executeJavaScript(`(() => {
    const button = document.querySelector('[data-testid="${testId}"]')
    if (!button || button.disabled || !button.checkVisibility()) return null
    button.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    const bounds = button.getBoundingClientRect()
    return { x: Math.round(bounds.x + bounds.width / 2), y: Math.round(bounds.y + bounds.height / 2) }
  })()`)
  if (!position) throw new Error('Installation confirmation is not ready')
  await new Promise<void>((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout)
      window.removeListener('closed', closed)
    }
    const failed = (error: unknown) => {
      cleanup()
      reject(error)
    }
    const closed = () => {
      cleanup()
      resolve()
    }
    const timeout = setTimeout(
      () => failed(new Error('Installation confirmation did not close after the native click')),
      STEP_TIMEOUT_MS
    )
    window.on('closed', closed)
    try {
      if (window.isDestroyed()) throw new Error('Installation confirmation is no longer available')
      window.focus()
      window.webContents.sendInputEvent({ type: 'mouseMove', ...position })
      window.webContents.sendInputEvent({
        type: 'mouseDown',
        button: 'left',
        clickCount: 1,
        ...position,
      })
      window.webContents.sendInputEvent({
        type: 'mouseUp',
        button: 'left',
        clickCount: 1,
        ...position,
      })
    } catch (error) {
      failed(error)
    }
  })
}

function clickWorkbenchElement(contents: WebContents, selector: string): Promise<unknown> {
  return evaluateWorkbenchPage(
    contents,
    `(() => {
      const target = document.querySelector(${selector})
      if (!target || target.disabled) throw new Error('Workbench control is unavailable')
      target.click()
      return true
    })()`
  )
}

function navigationUrlMetadata(url: string): unknown {
  if (url === 'about:blank' || url === 'about:srcdoc') return url
  try {
    const parsed = new URL(url)
    return {
      protocol: parsed.protocol.slice(0, 32),
      origin: parsed.origin === 'null' ? null : parsed.origin.slice(0, 256),
    }
  } catch {
    return { protocol: null, origin: null }
  }
}

class WorkbenchNavigationDiagnostics {
  private readonly references = new WeakMap<WebFrameMain, number>()
  private referenceCount = 0
  private readonly startedAt = Date.now()
  private readonly observations: Record<string, unknown>[] = []
  private omittedObservations = 0
  private readonly initialFrame: unknown

  constructor(
    private readonly contents: WebContents,
    private readonly expectedFrame: WebFrameMain,
    private readonly expectedUrl: string
  ) {
    this.initialFrame = this.frame(expectedFrame)
  }

  start(): void {
    this.contents.on('did-start-navigation', this.onStart)
    this.contents.on('did-frame-navigate', this.onCommit)
    this.contents.on('did-fail-load', this.onFailure)
    this.contents.on('did-fail-provisional-load', this.onProvisionalFailure)
    this.contents.on('console-message', this.onConsole)
  }

  dispose(): void {
    this.contents.removeListener('did-start-navigation', this.onStart)
    this.contents.removeListener('did-frame-navigate', this.onCommit)
    this.contents.removeListener('did-fail-load', this.onFailure)
    this.contents.removeListener('did-fail-provisional-load', this.onProvisionalFailure)
    this.contents.removeListener('console-message', this.onConsole)
  }

  navigation(
    type: string,
    event: Electron.WebContentsWillFrameNavigateEventParams & {
      defaultPrevented: boolean
    }
  ): void {
    this.record({
      type,
      url: navigationUrlMetadata(event.url),
      urlMatchesExpected: event.url === this.expectedUrl,
      frameMatchesExpected: event.frame === this.expectedFrame,
      frame: this.frame(event.frame),
      initiator: this.frame(event.initiator),
      isMainFrame: event.isMainFrame,
      isSameDocument: event.isSameDocument,
      defaultPrevented: event.defaultPrevented,
    })
  }

  error(reason: string): Error {
    let currentFrames: unknown = 'unavailable'
    let omittedFrames = 0
    try {
      const frames = this.contents.mainFrame.frames
      currentFrames = frames.slice(0, 8).map(frame => this.frame(frame))
      omittedFrames = Math.max(0, frames.length - 8)
    } catch {
      // A destroyed WebContents cannot expose its current frame tree.
    }
    const metadata = {
      expectedUrl: navigationUrlMetadata(this.expectedUrl),
      initialFrame: this.initialFrame,
      currentFrame: this.frame(this.expectedFrame),
      currentFrames,
      omittedFrames,
      observations: this.observations,
      omittedObservations: this.omittedObservations,
    }
    return new Error(
      `Workbench navigation was ${reason}: ${JSON.stringify(metadata.expectedUrl)}\nNavigation diagnostics: ${JSON.stringify(metadata)}`
    )
  }

  private frame(frame: WebFrameMain | null | undefined): unknown {
    if (!frame) return null
    let referenceId = this.references.get(frame)
    if (referenceId === undefined) {
      referenceId = ++this.referenceCount
      this.references.set(frame, referenceId)
    }
    const metadata: Record<string, unknown> = { referenceId }
    for (const key of [
      'processId',
      'routingId',
      'frameTreeNodeId',
      'name',
      'url',
      'detached',
    ] as const) {
      try {
        metadata[key] =
          key === 'url'
            ? navigationUrlMetadata(frame.url)
            : key === 'name'
              ? frame.name === LIGHTWEIGHT_WORKBENCH_FRAME_NAME
                ? LIGHTWEIGHT_WORKBENCH_FRAME_NAME
                : frame.name
                  ? 'other'
                  : 'empty'
              : frame[key]
      } catch {
        metadata[key] = 'unavailable'
      }
    }
    try {
      metadata.destroyed = frame.isDestroyed()
    } catch {
      metadata.destroyed = 'unavailable'
    }
    return metadata
  }

  private record(metadata: Record<string, unknown>): void {
    if (this.observations.length === 32) {
      this.observations.shift()
      this.omittedObservations += 1
    }
    this.observations.push({ ...metadata, elapsedMs: Date.now() - this.startedAt })
  }

  private readonly onStart = (
    event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>
  ) => this.navigation('did-start-navigation', event)

  private readonly onCommit = (
    _event: Electron.Event,
    url: string,
    httpResponseCode: number,
    _httpStatusText: string,
    isMainFrame: boolean,
    frameProcessId: number,
    frameRoutingId: number
  ) =>
    this.record({
      type: 'did-frame-navigate',
      url: navigationUrlMetadata(url),
      httpResponseCode,
      isMainFrame,
      frameProcessId,
      frameRoutingId,
    })

  private loadFailureObserver(type: string) {
    return (
      _event: Electron.Event,
      errorCode: number,
      _errorDescription: string,
      url: string,
      isMainFrame: boolean,
      frameProcessId: number,
      frameRoutingId: number
    ) =>
      this.record({
        type,
        url: navigationUrlMetadata(url),
        errorCode,
        isMainFrame,
        frameProcessId,
        frameRoutingId,
      })
  }

  private readonly onFailure = this.loadFailureObserver('did-fail-load')
  private readonly onProvisionalFailure = this.loadFailureObserver('did-fail-provisional-load')

  private readonly onConsole = (
    event: Electron.Event<Electron.WebContentsConsoleMessageEventParams>
  ) => {
    const classification = /\bSecurityError\b/.test(event.message)
      ? 'SecurityError'
      : /content.security.policy/i.test(event.message)
        ? 'CSP'
        : null
    if (classification)
      this.record({
        type: 'console-message',
        classification,
        level: event.level,
        frame: this.frame(event.frame),
      })
  }
}

async function clickAndWaitForBlockedNavigation(
  contents: WebContents,
  selector: string,
  url: string
): Promise<unknown> {
  const frame = contents.mainFrame.frames.find(
    candidate => candidate.name === LIGHTWEIGHT_WORKBENCH_FRAME_NAME
  )
  if (!frame) throw new Error('Lightweight Workbench frame is unavailable')
  const diagnostics = new WorkbenchNavigationDiagnostics(contents, frame, url)
  let cleanup = () => {}
  const blocked = new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(diagnostics.error('not observed')), STEP_TIMEOUT_MS)
    const observe =
      (type: string) =>
      (event: Electron.Event<Electron.WebContentsWillFrameNavigateEventParams>) => {
        diagnostics.navigation(type, event)
        if (event.frame !== frame || event.url !== url) return
        if (!event.defaultPrevented) reject(diagnostics.error('not blocked'))
        else resolve()
      }
    const navigate = observe('will-frame-navigate')
    const redirect = observe('will-redirect')
    cleanup = () => {
      clearTimeout(timeout)
      contents.removeListener('will-frame-navigate', navigate)
      contents.removeListener('will-redirect', redirect)
      diagnostics.dispose()
    }
    contents.on('will-frame-navigate', navigate)
    contents.on('will-redirect', redirect)
    diagnostics.start()
  })
  try {
    await Promise.all([blocked, clickWorkbenchElement(contents, selector)])
    return { clicked: true, blocked: true, url }
  } finally {
    cleanup()
  }
}
