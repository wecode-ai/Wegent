import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { EmbeddedBrowserManager } from './embedded-browser-manager.js'

const RUNTIME_FILE = 'embedded-browser-bridge.json'
const DEFAULT_LABEL = 'workspace-browser'
const OPEN_TIMEOUT_MS = 15_000
const DEFAULT_EVAL_TIMEOUT_MS = 10_000
const MAX_BODY_BYTES = 1024 * 1024

interface BrowserBridgeRequest {
  action: string
  url?: string
  expression?: string
  selector?: string
  text?: string
  key?: string
  x?: number
  y?: number
  timeoutMs?: number
  label?: string
  browserSessionId?: string
  options?: Record<string, unknown>
  inspectId?: string
  index?: number
  ref?: string
}

interface BrowserBridgeResponse {
  ok: boolean
  data?: unknown
  error?: string
}

interface RuntimeRecord {
  schemaVersion: 1
  pid: number
  address: string
  token: string
  startedAtUnixMs: number
}

export class EmbeddedBrowserBridge {
  private server: Server | null = null
  private runtimePath: string | null = null
  private token: string | null = null
  private readonly scripts = new Map<string, string>()

  constructor(
    private readonly browser: EmbeddedBrowserManager,
    private readonly executorHome: string
  ) {}

  async start(): Promise<string> {
    if (this.server && this.runtimePath) return this.runtimePath
    const token = randomBytes(32).toString('base64url')
    const server = createServer((request, response) => {
      void this.handleRequest(request, response, token)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject)
        resolve()
      })
    })
    const address = server.address()
    if (!address || typeof address === 'string') {
      server.close()
      throw new Error('Failed to read embedded browser bridge address')
    }
    const runtimePath = join(this.executorHome, 'runtime', RUNTIME_FILE)
    try {
      await writeRuntimeRecord(runtimePath, {
        schemaVersion: 1,
        pid: process.pid,
        address: `127.0.0.1:${address.port}`,
        token,
        startedAtUnixMs: Date.now(),
      })
    } catch (error) {
      server.close()
      throw error
    }
    this.server = server
    this.runtimePath = runtimePath
    this.token = token
    process.env.WEWORK_EMBEDDED_BROWSER_BRIDGE_ADDR = `127.0.0.1:${address.port}`
    process.env.WEWORK_EMBEDDED_BROWSER_BRIDGE_TOKEN = token
    return runtimePath
  }

  async stop(): Promise<void> {
    const server = this.server
    const runtimePath = this.runtimePath
    this.server = null
    this.runtimePath = null
    this.token = null
    delete process.env.WEWORK_EMBEDDED_BROWSER_BRIDGE_ADDR
    delete process.env.WEWORK_EMBEDDED_BROWSER_BRIDGE_TOKEN
    await Promise.allSettled([
      runtimePath ? rm(runtimePath, { force: true }) : Promise.resolve(),
      server ? new Promise<void>(resolve => server.close(() => resolve())) : Promise.resolve(),
    ])
  }

  private async handleRequest(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
    token: string
  ): Promise<void> {
    response.setHeader('access-control-allow-origin', '*')
    response.setHeader('access-control-allow-headers', 'content-type, authorization')
    response.setHeader('content-type', 'application/json')
    if (request.headers.authorization !== `Bearer ${token}`) {
      writeResponse(response, 401, {
        ok: false,
        error: 'Unauthorized embedded browser bridge request',
      })
      return
    }
    if (request.method === 'GET' && request.url === '/status') {
      await this.dispatchAndWrite(response, { action: 'status' })
      return
    }
    if (request.method !== 'POST' || request.url !== '/browser') {
      writeResponse(response, 404, {
        ok: false,
        error: 'Unknown embedded browser bridge endpoint',
      })
      return
    }
    try {
      const body = await readJsonBody(request)
      await this.dispatchAndWrite(response, body)
    } catch (error) {
      writeResponse(response, 400, {
        ok: false,
        error: errorMessage(error),
      })
    }
  }

  private async dispatchAndWrite(
    response: import('node:http').ServerResponse,
    request: BrowserBridgeRequest
  ): Promise<void> {
    try {
      writeResponse(response, 200, {
        ok: true,
        data: await this.dispatch(request),
      })
    } catch (error) {
      writeResponse(response, 200, {
        ok: false,
        error: errorMessage(error),
      })
    }
  }

  private async dispatch(request: BrowserBridgeRequest): Promise<unknown> {
    const baseLabel = request.label?.trim() || DEFAULT_LABEL
    const label = this.browser.activeLabel(baseLabel)
    const action = request.action
    const observable = isObservableAction(action)
    const mutating = isMutatingAction(action)
    const target = actionTarget(request)
    const signature = actionSignature(action, request)
    if (mutating && this.browser.isAgentControlPaused(label)) {
      const result = agentControlPausedResult(action)
      this.browser.emitAgentState(label, 'paused', {
        action,
        target,
        message: 'User is controlling the embedded browser.',
        errorCode: 'user_control',
      })
      return result
    }
    if (mutating && this.browser.consumeApprovedAgentRisk(label, signature)) {
      request.options = { ...(request.options ?? {}), riskApproved: true }
    }
    if (observable) this.browser.emitAgentState(label, 'running', { action, target })

    try {
      const result = await this.dispatchAction(baseLabel, label, request)
      const object =
        result && typeof result === 'object' && !Array.isArray(result)
          ? (result as Record<string, unknown>)
          : null
      const approval =
        mutating && object
          ? this.browser.registerAgentApproval(label, signature, action, object)
          : null
      if (observable) {
        const error = object?.error as { code?: unknown; message?: unknown } | undefined
        this.browser.emitAgentState(label, object?.ok === false ? 'needs_user' : 'idle', {
          action,
          target,
          message: typeof error?.message === 'string' ? error.message : null,
          errorCode: typeof error?.code === 'string' ? error.code : null,
          approval,
        })
      }
      return result
    } catch (error) {
      if (observable) {
        this.browser.emitAgentState(label, 'error', {
          action,
          target,
          message: errorMessage(error),
          errorCode: 'operation_failed',
        })
      }
      throw error
    }
  }

  private async dispatchAction(
    baseLabel: string,
    label: string,
    request: BrowserBridgeRequest
  ): Promise<unknown> {
    switch (request.action) {
      case 'status':
        return { open: this.browser.has(label), label }
      case 'pageState':
        return this.browser.state(label)
      case 'open':
      case 'navigate':
        return this.open(baseLabel, label, request)
      case 'reload':
        this.browser.reload(label)
        return { ok: true }
      case 'close':
        this.browser.requestClose(label)
        return { ok: true }
      case 'back':
        this.browser.goBack(label)
        return { ok: true }
      case 'forward':
        this.browser.goForward(label)
        return { ok: true }
      case 'evaluate':
        return this.evaluate(
          label,
          expressionScript(requiredString(request.expression, 'expression'))
        )
      case 'inspect':
        return this.evaluate(
          label,
          (await this.loadScript('embedded_browser_inspect.js')).replace(
            '__WEWORK_INSPECT_OPTIONS__',
            JSON.stringify(request.options ?? {})
          )
        )
      case 'click':
      case 'typeText':
      case 'fill':
      case 'hover':
      case 'focus':
      case 'select':
      case 'setChecked':
      case 'scroll':
      case 'scrollIntoView':
      case 'press':
        return this.runAction(label, request)
      case 'waitFor':
        return this.waitForCondition(label, request)
      case 'screenshot':
        if (!embeddedBrowserScreenshotAvailable()) {
          throw new Error('Embedded browser screenshots are currently supported on macOS only')
        }
        return this.screenshot(label)
      case 'nativeInputProbe':
        return nativeInputProbe(request)
      case 'capabilities':
        return browserCapabilities()
      default:
        throw new Error(`Unknown embedded browser bridge action: ${request.action}`)
    }
  }

  private async open(
    baseLabel: string,
    label: string,
    request: BrowserBridgeRequest
  ): Promise<{ ok: true }> {
    const url = requiredString(request.url, 'url')
    let resolvedLabel = label
    if (!this.browser.has(resolvedLabel)) {
      this.browser.requestOpen({
        id: `agent-open-${Date.now()}-${randomBytes(6).toString('hex')}`,
        url,
        baseLabel,
        source: 'agent',
        disposition: 'current-tab',
        targetLabel: label,
        parentLabel: null,
        browserSessionId: request.browserSessionId ?? null,
      })
      await waitFor(() => {
        const activeLabel = this.browser.activeLabel(baseLabel)
        if (this.browser.has(activeLabel)) {
          resolvedLabel = activeLabel
          return true
        }
        return this.browser.has(resolvedLabel)
      }, request.timeoutMs ?? OPEN_TIMEOUT_MS)
    }
    const state = this.browser.state(resolvedLabel)
    if (state.url !== url) await this.browser.navigate(resolvedLabel, url)
    return { ok: true }
  }

  private async evaluate(label: string, expression: string): Promise<unknown> {
    return withTimeout(
      this.browser.evaluate(label, expression),
      DEFAULT_EVAL_TIMEOUT_MS,
      'Timed out waiting for embedded browser evaluation'
    )
  }

  private async runAction(label: string, request: BrowserBridgeRequest): Promise<unknown> {
    const input = {
      action: request.action === 'typeText' ? 'type' : request.action,
      selector: request.selector ?? null,
      text: request.text ?? null,
      key: request.key ?? null,
      x: request.x ?? null,
      y: request.y ?? null,
      inspectId: request.inspectId ?? null,
      index: request.index ?? null,
      ref: request.ref ?? null,
      options: request.options ?? null,
    }
    return this.evaluate(
      label,
      (await this.loadScript('embedded_browser_action.js')).replace(
        '__WEWORK_ACTION_INPUT__',
        JSON.stringify(input)
      )
    )
  }

  private async waitForCondition(label: string, request: BrowserBridgeRequest): Promise<unknown> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS
    const pollMs = clampNumber(request.options?.pollMs, 50, 1000, 100)
    const startedAt = Date.now()
    const waitId = `electron-wait-${randomBytes(8).toString('hex')}`
    let lastResult: Record<string, unknown> = {
      ok: false,
      kind: 'browser.wait',
      backend: 'electron-webcontentsview-js',
      reason: 'not_started',
    }
    while (Date.now() - startedAt <= timeoutMs) {
      if (!this.browser.has(label)) {
        await new Promise(resolve => setTimeout(resolve, pollMs))
        continue
      }
      const input = {
        waitId,
        selector: request.selector ?? null,
        text: request.text ?? null,
        url: request.url ?? null,
        expression: request.expression ?? null,
        timeoutMs,
        options: request.options ?? null,
      }
      let result: unknown
      try {
        result = await this.evaluate(
          label,
          (await this.loadScript('embedded_browser_wait.js')).replace(
            '__WEWORK_WAIT_INPUT__',
            JSON.stringify(input)
          )
        )
      } catch (error) {
        if (!isUnavailableBrowserError(error, label)) throw error
        await new Promise(resolve => setTimeout(resolve, pollMs))
        continue
      }
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        lastResult = result as Record<string, unknown>
      }
      if (lastResult.ok === true) return lastResult
      await new Promise(resolve => setTimeout(resolve, pollMs))
    }
    return {
      ...lastResult,
      ok: false,
      reason: 'timeout',
      elapsedMs: Date.now() - startedAt,
      error: {
        code: 'wait_timeout',
        message: 'Timed out waiting for embedded browser condition.',
        recoverable: true,
        suggestedNextAction: 'inspect',
      },
    }
  }

  private async screenshot(label: string): Promise<Record<string, unknown>> {
    const screenshotId = `electron-screenshot-${randomBytes(8).toString('hex')}`
    const dataUrl = await this.browser.capture(label)
    const bytes = Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64')
    const path = join(tmpdir(), 'wework-embedded-browser', `${screenshotId}.png`)
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, bytes)
    const dimensions = pngDimensions(bytes)
    const page = await this.evaluate(
      label,
      `({
        url: location.href,
        title: document.title || '',
        readyState: document.readyState,
        viewport: {
          width: window.innerWidth,
          height: window.innerHeight,
          devicePixelRatio: window.devicePixelRatio || 1,
          scrollX: window.scrollX,
          scrollY: window.scrollY
        }
      })`
    )
    return {
      ok: true,
      kind: 'browser.screenshot',
      schemaVersion: 1,
      screenshotId,
      backend: 'electron-capture-page',
      format: 'png',
      scope: 'viewport',
      path,
      width: dimensions.width,
      height: dimensions.height,
      scale: 1,
      region: null,
      page,
      capturedAtUnixMs: Date.now(),
      warnings: [],
    }
  }

  private async loadScript(filename: string): Promise<string> {
    const cached = this.scripts.get(filename)
    if (cached) return cached
    const path = join(dirname(fileURLToPath(import.meta.url)), 'browser-runtime', filename)
    const script = await readFile(path, 'utf8')
    this.scripts.set(filename, script)
    return script
  }
}

function isUnavailableBrowserError(error: unknown, label: string): boolean {
  return errorMessage(error) === `Embedded browser is unavailable: ${label}`
}

async function writeRuntimeRecord(path: string, record: RuntimeRecord): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const temporary = join(directory, `.${RUNTIME_FILE}.${process.pid}.tmp`)
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

async function readJsonBody(
  request: import('node:http').IncomingMessage
): Promise<BrowserBridgeRequest> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += bytes.length
    if (size > MAX_BODY_BYTES) throw new Error('Embedded browser bridge request is too large')
    chunks.push(bytes)
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as BrowserBridgeRequest
}

function writeResponse(
  response: import('node:http').ServerResponse,
  statusCode: number,
  body: BrowserBridgeResponse
): void {
  response.statusCode = statusCode
  response.end(JSON.stringify(body))
}

function requiredString(value: string | undefined, name: string): string {
  if (!value?.trim()) throw new Error(`Embedded browser ${name} is required`)
  return value
}

function expressionScript(expression: string): string {
  return `(() => {
    try {
      const value = (() => { return (${expression}) })()
      return { ok: true, value }
    } catch (error) {
      return { ok: false, error: String(error?.stack || error?.message || error) }
    }
  })()`
}

function browserCapabilities(): Record<string, unknown> {
  const screenshotAvailable = embeddedBrowserScreenshotAvailable()
  return {
    kind: 'browser.capabilities',
    backend: 'electron-webcontentsview',
    compatibilityBackend: 'wkwebview',
    schemaVersion: 1,
    inspect: {
      structuredDom: true,
      indexRef: true,
      frame: 'same-origin',
      shadowDom: 'open-shadow-dom',
    },
    actions: {
      syntheticDom: [
        'click',
        'type',
        'fill',
        'hover',
        'focus',
        'press',
        'select',
        'setChecked',
        'scroll',
        'scrollIntoView',
      ],
      trustedNativeInput: 'poc_only',
      appKitNativeInputProbe: false,
    },
    wait: {
      structured: true,
      conditions: [
        'selectorAttached',
        'selectorVisible',
        'textVisible',
        'urlIncludes',
        'urlMatches',
        'titleIncludes',
        'revisionChanged',
        'domStable',
        'pageStable',
        'inputValueChanged',
        'elementGone',
        'expression',
      ],
    },
    screenshot: {
      viewport: screenshotAvailable,
      primaryBackend: screenshotAvailable ? 'electron-capture-page' : null,
      fallbackBackend: null,
    },
  }
}

export function embeddedBrowserScreenshotAvailable(platform = process.platform): boolean {
  return platform === 'darwin'
}

function isObservableAction(action: string): boolean {
  return [
    'open',
    'navigate',
    'inspect',
    'click',
    'typeText',
    'fill',
    'hover',
    'focus',
    'select',
    'setChecked',
    'scroll',
    'scrollIntoView',
    'press',
    'waitFor',
    'screenshot',
  ].includes(action)
}

function isMutatingAction(action: string): boolean {
  return [
    'open',
    'navigate',
    'click',
    'typeText',
    'fill',
    'hover',
    'focus',
    'select',
    'setChecked',
    'scroll',
    'scrollIntoView',
    'press',
  ].includes(action)
}

function actionTarget(request: BrowserBridgeRequest): string | null {
  if (request.ref) return request.ref
  if (request.index !== undefined) return `index ${request.index}`
  if (request.selector) return request.selector
  return request.url ?? null
}

function actionSignature(action: string, request: BrowserBridgeRequest): string {
  if (request.ref) return `${action}:ref:${request.ref}`
  if (request.inspectId) return `${action}:inspect:${request.inspectId}:${request.index ?? 0}`
  if (request.selector) return `${action}:selector:${request.selector}`
  if (request.x !== undefined || request.y !== undefined) {
    return `${action}:coord:${request.x ?? 0}:${request.y ?? 0}`
  }
  return `${action}:active`
}

function agentControlPausedResult(action: string): Record<string, unknown> {
  return {
    ok: false,
    kind: 'browser.action',
    action,
    error: {
      code: 'user_control',
      message: 'User is controlling the embedded browser. Ask before continuing.',
      recoverable: true,
      category: 'control',
      suggestedNextAction: 'ask_user_to_resume_agent_control',
    },
  }
}

function nativeInputProbe(request: BrowserBridgeRequest): Record<string, unknown> {
  return {
    ok: false,
    kind: 'browser.nativeInputProbe',
    backend: 'electron-input-poc',
    probeKind: typeof request.options?.kind === 'string' ? request.options.kind : 'unknown',
    permissionRequired: false,
    eventTrusted: null,
    effect: {
      urlChanged: false,
      domChanged: false,
      focusChanged: false,
      valueChanged: false,
    },
    warnings: [
      {
        code: 'native_input_probe_not_executed',
        message: 'Trusted native input is not enabled as a production path.',
      },
    ],
    error: {
      code: 'requires_trusted_input',
      message: 'Native input is only a PoC surface in this build.',
      recoverable: true,
      category: 'capability',
      suggestedNextAction: 'ask_user_to_take_control',
    },
  }
}

function clampNumber(value: unknown, minimum: number, maximum: number, fallback: number): number {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(maximum, Math.max(minimum, numeric))
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  ) {
    throw new Error('Embedded browser screenshot is not a PNG file')
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  }
}

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() <= deadline) {
    if (predicate()) return
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error('Timed out waiting for embedded browser')
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs)
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
