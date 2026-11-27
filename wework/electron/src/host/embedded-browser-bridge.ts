import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { chmod, mkdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import type {
  BrowserNativeClickTargetSnapshot,
  BrowserUploadTargetSnapshot,
} from './browser-approved-targets.js'
import type { EmbeddedBrowserManager } from './embedded-browser-manager.js'
import {
  BrowserExpressionError,
  type BrowserScriptEvaluationOptions,
} from './browser-script-evaluator.js'
import {
  uploadFileIdentity,
  type ApprovedUploadFile,
  type ApprovedUploadSnapshot,
} from './browser-approved-uploads.js'

const RUNTIME_FILE = 'embedded-browser-bridge.json'
const DEFAULT_LABEL = 'workspace-browser'
const OPEN_TIMEOUT_MS = 15_000
const DEFAULT_EVAL_TIMEOUT_MS = 10_000
const WAIT_DEADLINE_MESSAGE = 'Embedded browser wait deadline exceeded'
const MAX_BODY_BYTES = 1024 * 1024
const EMBEDDED_BROWSER_DATA_KINDS = ['cookies', 'cache', 'storage', 'history'] as const
type EmbeddedBrowserDataKind = (typeof EMBEDDED_BROWSER_DATA_KINDS)[number]
const DEFAULT_CLEAR_DATA_KINDS: readonly EmbeddedBrowserDataKind[] = ['cookies', 'cache', 'storage']

interface BrowserBridgeRequest {
  action: string
  url?: string
  path?: string
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
  kinds?: string[]
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
  private baseUrl: string | null = null
  private token: string | null = null
  private readonly inFlight = new Set<AbortController>()
  private readonly scripts = new Map<string, string>()

  constructor(
    private readonly browser: EmbeddedBrowserManager,
    private readonly executorHome: string,
    private readonly fullControlEnabled: () => Promise<boolean> = async () => false
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
    const record: RuntimeRecord = {
      schemaVersion: 1,
      pid: process.pid,
      address: `127.0.0.1:${address.port}`,
      token,
      startedAtUnixMs: Date.now(),
    }
    try {
      await writeRuntimeRecord(runtimePath, record)
    } catch (error) {
      server.close()
      throw error
    }
    this.server = server
    this.runtimePath = runtimePath
    this.baseUrl = `http://127.0.0.1:${address.port}`
    this.token = token
    return runtimePath
  }

  environment(): NodeJS.ProcessEnv {
    if (!this.baseUrl || !this.token) {
      throw new Error('Embedded browser bridge has not started')
    }
    return {
      WEWORK_EMBEDDED_BROWSER_BRIDGE_URL: this.baseUrl,
      WEWORK_EMBEDDED_BROWSER_BRIDGE_TOKEN: this.token,
    }
  }

  async stop(): Promise<void> {
    const server = this.server
    const runtimePath = this.runtimePath
    this.server = null
    this.runtimePath = null
    this.baseUrl = null
    this.token = null
    for (const controller of this.inFlight) controller.abort()
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
    // A browser mutation cannot be replayed after an idle-socket close race.
    response.setHeader('connection', 'close')
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
    const controller = new AbortController()
    const cancel = () => controller.abort()
    this.inFlight.add(controller)
    response.once('close', cancel)
    try {
      writeResponse(response, 200, {
        ok: true,
        data: await this.dispatch(request, controller.signal),
      })
    } catch (error) {
      writeResponse(response, 200, {
        ok: false,
        error: errorMessage(error),
      })
    } finally {
      response.off('close', cancel)
      this.inFlight.delete(controller)
    }
  }

  private async dispatch(request: BrowserBridgeRequest, signal: AbortSignal): Promise<unknown> {
    const baseLabel = request.label?.trim() || DEFAULT_LABEL
    const label = this.browser.activeLabel(baseLabel)
    const action = request.action
    const observable = isObservableAction(action)
    const mutating = isMutatingAction(action)
    const target = actionTarget(request)
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
    if (observable) this.browser.emitAgentState(label, 'running', { action, target })

    try {
      const result = await this.dispatchWithApproval(baseLabel, label, request, signal)
      const object =
        result && typeof result === 'object' && !Array.isArray(result)
          ? (result as Record<string, unknown>)
          : null
      if (observable) {
        const error = object?.error as { code?: unknown; message?: unknown } | undefined
        this.browser.emitAgentState(label, object?.ok === false ? 'needs_user' : 'idle', {
          action,
          target,
          message: typeof error?.message === 'string' ? error.message : null,
          errorCode: typeof error?.code === 'string' ? error.code : null,
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

  private async dispatchWithApproval(
    baseLabel: string,
    label: string,
    request: BrowserBridgeRequest,
    signal: AbortSignal
  ): Promise<unknown> {
    const mutating = isMutatingAction(request.action)
    if (mutating && (await this.fullControlEnabled())) {
      if (signal.aborted) throw new Error('Browser operation cancelled')
      if (this.browser.isAgentControlPaused(label)) return agentControlPausedResult(request.action)
      return this.dispatchAction(
        baseLabel,
        label,
        { ...request, options: { ...request.options, riskApproved: true } },
        signal,
        true,
        undefined,
        true
      )
    }
    const result = await this.dispatchAction(
      baseLabel,
      label,
      mutating ? { ...request, options: { ...request.options, riskApproved: false } } : request,
      signal
    )
    if (!mutating || !result || typeof result !== 'object' || Array.isArray(result)) return result
    const pendingTarget = takePendingApprovalTarget(result as Record<string, unknown>)
    const approval = this.browser.registerAgentApproval(
      label,
      request.action,
      result as Record<string, unknown>
    )
    if (!approval) return result
    const decision = this.browser.waitForAgentApproval(label, approval.approvalId, signal)
    this.browser.emitAgentState(label, 'needs_user', {
      action: request.action,
      errorCode: 'approval_required',
    })
    const outcome = await decision
    if (outcome !== 'approved' || signal.aborted) {
      const code = signal.aborted ? 'cancelled' : outcome
      return {
        ...result,
        approval: null,
        error: {
          code: `approval_${code}`,
          message: `Browser action approval was ${code}.`,
          recoverable: false,
        },
      }
    }
    if (this.browser.isAgentControlPaused(label)) return agentControlPausedResult(request.action)
    if (this.browser.activeLabel(baseLabel) !== label) {
      return approvalTargetChangedResult(
        request.action,
        'Active browser tab changed before approval completed.'
      )
    }
    this.browser.emitAgentState(label, 'running', {
      action: request.action,
      target: actionTarget(request),
    })
    return this.dispatchAction(
      baseLabel,
      label,
      { ...request, options: { ...request.options, riskApproved: true } },
      signal,
      true,
      pendingTarget
    )
  }

  private async dispatchAction(
    baseLabel: string,
    label: string,
    request: BrowserBridgeRequest,
    signal: AbortSignal,
    riskApproved = false,
    approvedTarget?: ApprovedBrowserTarget | null,
    fullControlGrant = false
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
        await this.browser.requestClose(label)
        return { ok: true }
      case 'back':
        this.browser.goBack(label)
        return { ok: true }
      case 'forward':
        this.browser.goForward(label)
        return { ok: true }
      case 'evaluate':
        return this.evaluateDiagnostic(label, requiredString(request.expression, 'expression'))
      case 'inspect':
        return this.evaluate(
          label,
          (await this.loadScript('embedded_browser_inspect.js')).replace(
            '__WEWORK_INSPECT_OPTIONS__',
            () => JSON.stringify(request.options ?? {})
          )
        )
      case 'click':
        return this.runClickAction(baseLabel, label, request, signal, fullControlGrant)
      case 'typeText':
      case 'fill':
      case 'hover':
      case 'focus':
      case 'select':
      case 'setChecked':
      case 'scroll':
      case 'scrollIntoView':
      case 'press':
        return this.runAction(baseLabel, label, request, signal, false, fullControlGrant)
      case 'nativeClick': {
        const x = requiredCoordinate(request.x, 'x')
        const y = requiredCoordinate(request.y, 'y')
        if (!this.browser.has(label)) throw new Error(`Embedded browser is unavailable: ${label}`)
        if (!riskApproved) {
          const clickTarget = await this.browser.inspectNativeClickTarget(label, x, y)
          const pending = browserApprovalRequired(
            request.action,
            `Click browser position (${x}, ${y})?`,
            {
              x,
              y,
            }
          )
          attachPendingApprovalTarget(pending, { kind: 'nativeClick', target: clickTarget })
          return pending
        }
        try {
          if (fullControlGrant && !(await this.fullControlEnabled())) {
            return approvalTargetChangedResult(
              request.action,
              'Browser control settings changed before click.'
            )
          }
          if (!fullControlGrant && approvedTarget?.kind !== 'nativeClick') {
            return approvalTargetChangedResult(
              request.action,
              'The approved click target could not be verified.'
            )
          }
          await this.browser.clickAt(
            label,
            x,
            y,
            approvedTarget?.kind === 'nativeClick' ? approvedTarget.target : undefined,
            () => this.assertApprovedDispatch(baseLabel, label, signal)
          )
        } catch (error) {
          if ((error as { code?: unknown })?.code === 'user_control')
            return agentControlPausedResult(request.action)
          if ((error as { code?: unknown })?.code === 'approval_target_changed')
            return approvalTargetChangedResult(request.action, errorMessage(error))
          throw error
        }
        return {
          ok: true,
          kind: 'browser.action',
          action: 'click',
          backend: 'electron-send-input-event',
          executionKind: 'trusted-event',
          synthetic: false,
        }
      }
      case 'waitFor':
        return this.waitForCondition(label, request, signal)
      case 'uploadFile':
        return this.uploadFile(
          baseLabel,
          label,
          request,
          signal,
          riskApproved,
          approvedTarget?.kind === 'uploadFile' ? approvedTarget.target : undefined,
          fullControlGrant
        )
      case 'clearData':
        return this.clearData(label, request, riskApproved)
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
    await withTimeout(
      this.browser.waitForNavigation(resolvedLabel, request.timeoutMs ?? OPEN_TIMEOUT_MS),
      request.timeoutMs ?? OPEN_TIMEOUT_MS,
      'Timed out waiting for embedded browser navigation'
    )
    return { ok: true }
  }

  private async evaluate(
    label: string,
    expression: string,
    options?: BrowserScriptEvaluationOptions
  ): Promise<unknown> {
    return withTimeout(
      this.browser.evaluate(label, expression, options),
      DEFAULT_EVAL_TIMEOUT_MS,
      'Timed out waiting for embedded browser evaluation'
    )
  }

  private evaluateReadOnly(label: string, expression: string): Promise<unknown> {
    return this.evaluate(label, `(${expression})`, { readOnly: true })
  }

  private async evaluateDiagnostic(label: string, expression: string): Promise<unknown> {
    try {
      return { ok: true, value: await this.evaluateReadOnly(label, expression) }
    } catch (error) {
      if (error instanceof BrowserExpressionError && error.kind === 'read_only_rejected') {
        return readOnlyExpressionRejectedResult()
      }
      throw error
    }
  }

  private async runClickAction(
    baseLabel: string,
    label: string,
    request: BrowserBridgeRequest,
    signal: AbortSignal,
    fullControlGrant: boolean
  ): Promise<unknown> {
    const preview = await this.runAction(baseLabel, label, request, signal, true)
    const point = actionCursorPoint(request, preview)
    if (!point) return preview
    const moveSequence = this.browser.showAgentCursor(label, point.x, point.y)
    const arrived = await this.browser.waitForAgentCursorArrival(
      label,
      moveSequence,
      request.timeoutMs
    )
    if (!arrived) throw new Error('Timed out waiting for embedded browser agent cursor arrival')
    if (this.browser.isAgentControlPaused(label)) return agentControlPausedResult(request.action)
    return this.runAction(baseLabel, label, request, signal, false, fullControlGrant)
  }

  private async runAction(
    baseLabel: string,
    label: string,
    request: BrowserBridgeRequest,
    signal: AbortSignal,
    previewOnly = false,
    fullControlGrant = false
  ): Promise<unknown> {
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
      previewOnly,
    }
    const script = (await this.loadScript('embedded_browser_action.js')).replace(
      '__WEWORK_ACTION_INPUT__',
      () => JSON.stringify(input)
    )
    if (fullControlGrant && !(await this.fullControlEnabled())) {
      return approvalTargetChangedResult(
        request.action,
        'Browser control settings changed before execution.'
      )
    }
    if (signal.aborted) throw new Error('Browser operation cancelled')
    if (this.browser.isAgentControlPaused(label)) return agentControlPausedResult(request.action)
    if (this.browser.activeLabel(baseLabel) !== label) {
      return approvalTargetChangedResult(
        request.action,
        'Active browser tab changed before execution.'
      )
    }
    return this.evaluate(
      label,
      script,
      // This script returns synchronously. A Promise callback can be destroyed by
      // the navigation that the action itself dispatched.
      { awaitPromise: false }
    ).catch(error => {
      console.warn('[embedded-browser-action]', {
        label,
        action: request.action,
        previewOnly,
        error: errorMessage(error),
      })
      throw error
    })
  }

  private async waitForCondition(
    label: string,
    request: BrowserBridgeRequest,
    signal: AbortSignal
  ): Promise<unknown> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_EVAL_TIMEOUT_MS
    const pollMs = clampNumber(request.options?.pollMs, 50, 1000, 100)
    const rawCondition = request.options?.condition
    const condition =
      rawCondition && typeof rawCondition === 'object' && !Array.isArray(rawCondition)
        ? { ...(rawCondition as Record<string, unknown>) }
        : {}
    const expression = condition.expression || request.expression
    if (expression && typeof expression !== 'string') return readOnlyExpressionRejectedResult()
    delete condition.expression
    delete condition.expressionMatched
    const options = { ...request.options, condition }
    const startedAt = performance.now()
    const deadline = startedAt + timeoutMs
    const waitId = `electron-wait-${randomBytes(8).toString('hex')}`
    const script = await this.loadScript('embedded_browser_wait.js')
    const input = {
      waitId,
      selector: request.selector ?? null,
      text: request.text ?? null,
      url: request.url ?? null,
      timeoutMs,
      options,
    }
    let waitState: Record<string, unknown> | undefined
    const remaining = () => Math.max(0, deadline - performance.now())
    const pause = () =>
      delay(Math.min(pollMs, remaining()), undefined, { signal }).catch(error => {
        if (signal.aborted) throw new Error('Browser operation cancelled')
        throw error
      })
    const probe = async (serializedInput: string, readOnly = false) => {
      if (signal.aborted) throw new Error('Browser operation cancelled')
      const budget = remaining()
      if (!budget) throw new Error(WAIT_DEADLINE_MESSAGE)
      const result = await withTimeout(
        this.browser.evaluate(
          label,
          script.replace('__WEWORK_WAIT_INPUT__', () => serializedInput),
          readOnly ? { readOnly: true } : undefined
        ),
        budget,
        WAIT_DEADLINE_MESSAGE,
        signal
      )
      if (signal.aborted) throw new Error('Browser operation cancelled')
      if (!remaining()) throw new Error(WAIT_DEADLINE_MESSAGE)
      return result
    }
    let lastResult: Record<string, unknown> = {
      ok: false,
      kind: 'browser.wait',
      backend: 'electron-webcontentsview-js',
      reason: 'not_started',
    }
    while (remaining()) {
      if (signal.aborted) throw new Error('Browser operation cancelled')
      if (!this.browser.has(label)) {
        waitState = undefined
        await pause()
        continue
      }
      let result: unknown
      let readOnly = false
      try {
        if (typeof expression === 'string' && expression) {
          if (!waitState) {
            const prepared = await probe(JSON.stringify({ ...input, probeMode: 'prepare' }))
            if (!prepared || typeof prepared !== 'object' || Array.isArray(prepared)) {
              throw new Error('Embedded browser wait preparation failed')
            }
            waitState = prepared as Record<string, unknown>
          }
          // Keep the expression and structured checks in one synchronous Chromium
          // evaluation. Initialization is trusted code and never receives the expression.
          readOnly = true
          const guardedInput = JSON.stringify({ ...input, probeMode: 'guarded', waitState })
          result = await probe(
            `${guardedInput.slice(0, -1)},"evaluateExpression":() => (${expression})}`,
            true
          )
        } else {
          result = await probe(JSON.stringify(input))
        }
      } catch (error) {
        if (signal.aborted) throw error
        if (errorMessage(error) === WAIT_DEADLINE_MESSAGE) break
        if (isRetryableWaitError(error, label)) {
          waitState = undefined
        } else if (readOnly && error instanceof BrowserExpressionError) {
          if (error.kind === 'read_only_rejected') return readOnlyExpressionRejectedResult()
          lastResult = { ...lastResult, ok: false, reason: 'expression_not_met' }
        } else throw error
        await pause()
        continue
      }
      if (result && typeof result === 'object' && !Array.isArray(result)) {
        lastResult = result as Record<string, unknown>
      }
      if (lastResult.ok === true) return lastResult
      if (lastResult.reason === 'observation_unavailable') waitState = undefined
      await pause()
    }
    return {
      ...lastResult,
      ok: false,
      reason: 'timeout',
      elapsedMs: performance.now() - startedAt,
      error: {
        code: 'wait_timeout',
        message: 'Timed out waiting for embedded browser condition.',
        recoverable: true,
        suggestedNextAction: 'inspect',
      },
    }
  }

  private async uploadFile(
    baseLabel: string,
    label: string,
    request: BrowserBridgeRequest,
    signal: AbortSignal,
    riskApproved: boolean,
    approvedUploadTarget?: ApprovedUploadTarget | null,
    fullControlGrant = false
  ): Promise<Record<string, unknown>> {
    const path = requiredString(request.path, 'path')
    if (!isAbsolute(path)) {
      throw new Error(`Embedded browser upload requires an absolute local file path: ${path}`)
    }
    const resolvedPath = await realpath(path).catch(() => null)
    const fileStat = resolvedPath
      ? await stat(resolvedPath, { bigint: true }).catch(() => null)
      : null
    if (!resolvedPath || !fileStat?.isFile()) {
      throw new Error(`Embedded browser upload file does not exist or is not a file: ${path}`)
    }
    if (request.ref || request.inspectId !== undefined || request.index !== undefined) {
      throw new Error(
        'Embedded browser upload targets file inputs by CSS selector only; omit the target to use the first file input on the page.'
      )
    }
    const selector = request.selector?.trim() || null
    if (!this.browser.has(label)) throw new Error(`Embedded browser is unavailable: ${label}`)
    if (!riskApproved) {
      const domTarget = await this.browser.inspectUploadTarget(label, selector)
      const url = domTarget.url
      const pending = browserApprovalRequired(
        request.action,
        `Allow this page to access the local file ${resolvedPath}?`,
        { path: resolvedPath, selector: domTarget.selector, url: url || null }
      )
      attachPendingApprovalTarget(pending, {
        kind: 'uploadFile',
        target: {
          realPath: resolvedPath,
          fileIdentity: uploadFileIdentity(fileStat),
          size: fileStat.size,
          domTarget,
        },
      })
      return pending
    }
    if (signal.aborted) throw new Error('Browser operation cancelled')
    if (this.browser.isAgentControlPaused(label)) return agentControlPausedResult(request.action)
    if (!fullControlGrant && !approvedUploadTarget) {
      return approvalTargetChangedResult(
        request.action,
        'The approved upload target could not be verified.'
      )
    }
    if (approvedUploadTarget) {
      if (
        resolvedPath !== approvedUploadTarget.realPath ||
        uploadFileIdentity(fileStat) !== approvedUploadTarget.fileIdentity
      ) {
        return approvalTargetChangedResult(
          request.action,
          'Browser upload target or local file changed before approval completed.'
        )
      }
    }
    let snapshot: ApprovedUploadSnapshot | undefined
    let dispatched = false
    try {
      const result = approvedUploadTarget
        ? await this.browser.uploadFiles(
            label,
            selector,
            [approvedUploadTarget.realPath],
            approvedUploadTarget.domTarget,
            async () => {
              this.assertApprovedDispatch(baseLabel, label, signal)
              snapshot = await this.browser.stageApprovedUpload(approvedUploadTarget, signal)
              this.assertApprovedDispatch(baseLabel, label, signal)
              return [snapshot.path]
            },
            () => {
              this.assertApprovedDispatch(baseLabel, label, signal)
              // The command may reach Chromium even if its response is lost.
              // Keep the private file until the browser manager stops once dispatched.
              dispatched = true
            }
          )
        : await this.browser.uploadFiles(label, selector, [path], undefined, async () => {
            if (fullControlGrant && !(await this.fullControlEnabled())) {
              throw Object.assign(new Error('Browser control settings changed before upload.'), {
                code: 'approval_target_changed',
              })
            }
            this.assertApprovedDispatch(baseLabel, label, signal)
          })
      return {
        ok: true,
        kind: 'browser.action',
        action: 'uploadFile',
        backend: 'electron-cdp-setFileInputFiles',
        selector: result.selector,
        fileCount: 1,
      }
    } catch (error) {
      if ((error as { code?: unknown })?.code === 'user_control') {
        return agentControlPausedResult(request.action)
      }
      if ((error as { code?: unknown })?.code === 'approval_target_changed') {
        return approvalTargetChangedResult(request.action, errorMessage(error))
      }
      if ((error as { code?: unknown })?.code === 'upload_snapshot_unavailable') {
        return {
          ok: false,
          kind: 'browser.action',
          action: request.action,
          error: {
            code: 'upload_snapshot_unavailable',
            message: errorMessage(error),
            recoverable: true,
          },
        }
      }
      throw error
    } finally {
      if (snapshot && !dispatched) {
        await snapshot
          .discard()
          .catch(() =>
            console.warn(
              '[embedded-browser-upload] Failed to remove an unused approved upload snapshot.'
            )
          )
      }
    }
  }

  private assertApprovedDispatch(baseLabel: string, label: string, signal: AbortSignal): void {
    if (signal.aborted) throw new Error('Browser operation cancelled')
    if (this.browser.isAgentControlPaused(label)) {
      throw Object.assign(new Error('User is controlling the embedded browser.'), {
        code: 'user_control',
      })
    }
    if (this.browser.activeLabel(baseLabel) !== label) {
      throw Object.assign(new Error('Active browser tab changed before execution.'), {
        code: 'approval_target_changed',
      })
    }
  }

  private async clearData(
    label: string,
    request: BrowserBridgeRequest,
    riskApproved: boolean
  ): Promise<Record<string, unknown>> {
    const optionKinds = request.options?.kinds
    const rawKinds = request.kinds ?? (Array.isArray(optionKinds) ? optionKinds : null)
    const kinds = rawKinds
      ?.map(kind => String(kind).trim().toLowerCase())
      .filter(kind => EMBEDDED_BROWSER_DATA_KINDS.includes(kind as EmbeddedBrowserDataKind))
    if (rawKinds && kinds?.length !== rawKinds.length) {
      throw new Error(
        `Embedded browser clearData kinds must be a subset of: ${EMBEDDED_BROWSER_DATA_KINDS.join(', ')}`
      )
    }
    const requestedKinds = kinds && kinds.length > 0 ? kinds : [...DEFAULT_CLEAR_DATA_KINDS]
    if (!riskApproved) {
      if (!this.browser.has(label)) throw new Error(`Embedded browser is unavailable: ${label}`)
      return browserApprovalRequired(
        request.action,
        `Clear browser data: ${requestedKinds.join(', ')}?`,
        { kinds: requestedKinds }
      )
    }
    await this.browser.clearData([...requestedKinds])
    return {
      ok: true,
      kind: 'browser.action',
      action: 'clearData',
      cleared: requestedKinds,
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

function isRetryableWaitError(error: unknown, label: string): boolean {
  const message = errorMessage(error)
  return (
    message === `Embedded browser is unavailable: ${label}` ||
    // A document navigation replaces the inspected target while the wait
    // condition is evaluated; the next poll evaluates against the new document.
    message.includes('Inspected target navigated or closed')
  )
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

function readOnlyExpressionRejectedResult(): Record<string, unknown> {
  return {
    ok: false,
    error: {
      code: 'read_only_expression_rejected',
      message: 'The browser expression could not be evaluated safely in read-only mode.',
      recoverable: true,
    },
  }
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
      fileUpload: {
        backend: 'electron-cdp-setFileInputFiles',
        multiple: false,
      },
      dataClearing: {
        kinds: [...EMBEDDED_BROWSER_DATA_KINDS],
        defaultKinds: [...DEFAULT_CLEAR_DATA_KINDS],
      },
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
    'nativeClick',
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
    'uploadFile',
    'clearData',
  ].includes(action)
}

function isMutatingAction(action: string): boolean {
  return [
    'open',
    'navigate',
    'click',
    'nativeClick',
    'typeText',
    'fill',
    'hover',
    'focus',
    'select',
    'setChecked',
    'scroll',
    'scrollIntoView',
    'press',
    'uploadFile',
    'clearData',
  ].includes(action)
}

function actionTarget(request: BrowserBridgeRequest): string | null {
  if (request.ref) return request.ref
  if (request.index !== undefined) return `index ${request.index}`
  if (request.selector) return request.selector
  return request.url ?? null
}

function requiredCoordinate(value: unknown, name: string): number {
  const coordinate = Number(value)
  if (!Number.isFinite(coordinate) || coordinate < 0) {
    throw new Error(`Embedded browser ${name} coordinate is invalid`)
  }
  return coordinate
}

function actionCursorPoint(
  request: BrowserBridgeRequest,
  preview: unknown
): { x: number; y: number } | null {
  if (!preview || typeof preview !== 'object' || Array.isArray(preview)) return null
  const result = preview as Record<string, unknown>
  if (result.ok !== true) return null
  if (Number.isFinite(request.x) && Number.isFinite(request.y)) {
    return { x: request.x as number, y: request.y as number }
  }
  const target = result.target
  if (!target || typeof target !== 'object' || Array.isArray(target)) return null
  const targetRecord = target as Record<string, unknown>
  const rect = targetRecord.viewportRect ?? targetRecord.rect
  if (!rect || typeof rect !== 'object' || Array.isArray(rect)) return null
  const values = rect as Record<string, unknown>
  const x = Number(values.x)
  const y = Number(values.y)
  const width = Number(values.width)
  const height = Number(values.height)
  if (![x, y, width, height].every(Number.isFinite)) return null
  return {
    x: x + width / 2,
    y: y + height / 2,
  }
}

interface ApprovedUploadTarget extends ApprovedUploadFile {
  domTarget: BrowserUploadTargetSnapshot
}

type ApprovedBrowserTarget =
  | { kind: 'uploadFile'; target: ApprovedUploadTarget }
  | { kind: 'nativeClick'; target: BrowserNativeClickTargetSnapshot }

const PENDING_APPROVAL_TARGET = Symbol('pendingApprovalTarget')

function attachPendingApprovalTarget(
  result: Record<string, unknown>,
  target: ApprovedBrowserTarget
): void {
  Object.defineProperty(result, PENDING_APPROVAL_TARGET, {
    value: target,
    enumerable: false,
    configurable: true,
  })
}

function takePendingApprovalTarget(result: Record<string, unknown>): ApprovedBrowserTarget | null {
  const value = (result as Record<symbol, ApprovedBrowserTarget | undefined>)[
    PENDING_APPROVAL_TARGET
  ]
  if (value) delete (result as Record<symbol, unknown>)[PENDING_APPROVAL_TARGET]
  return value ?? null
}

function approvalTargetChangedResult(action: string, message: string): Record<string, unknown> {
  return {
    ok: false,
    kind: 'browser.action',
    action,
    error: {
      code: 'approval_target_changed',
      message,
      recoverable: true,
      suggestedNextAction: 'inspect',
    },
  }
}

function browserApprovalRequired(
  action: string,
  reason: string,
  target: Record<string, unknown>
): Record<string, unknown> {
  return {
    ok: false,
    kind: 'browser.action',
    action,
    approval: { risk: 'high', actionKind: action, reason, target },
    error: {
      code: 'approval_required',
      message: 'Browser action requires user approval.',
      recoverable: true,
      suggestedNextAction: 'ask_user_to_confirm',
    },
  }
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

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
  signal?: AbortSignal
): Promise<T> {
  let timer: NodeJS.Timeout | undefined
  let abort: (() => void) | undefined
  return Promise.race([
    promise,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(message)), timeoutMs)
      if (signal) {
        abort = () => reject(new Error('Browser operation cancelled'))
        signal.addEventListener('abort', abort, { once: true })
        if (signal.aborted) abort()
      }
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer)
    if (abort) signal?.removeEventListener('abort', abort)
  })
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
