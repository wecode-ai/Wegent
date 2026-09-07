import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const MAX_BODY_BYTES = 1024 * 1024
const DEFAULT_TIMEOUT_MS = 10_000

interface DesktopControlRequest {
  action: string
  selector?: string
  text?: string
  key?: string
  timeoutMs?: number
  inspectId?: string
  index?: number
  ref?: string
  options?: Record<string, unknown>
}

interface DesktopContents {
  capturePage: () => Promise<{ toDataURL: () => string }>
  executeJavaScript: (code: string, userGesture?: boolean) => Promise<unknown>
  getTitle: () => string
  getURL: () => string
  isDestroyed: () => boolean
}

interface DesktopWindow {
  focus: () => void
  isFocused: () => boolean
  isMinimized: () => boolean
  isVisible: () => boolean
  restore: () => void
  show: () => void
  webContents: DesktopContents
}

export interface WeworkDesktopControlBridgeOptions {
  instanceId: string
  instanceKind: 'main' | 'core-dsh-plugin-development'
  displayName: string
  projectRoot: string | null
  registryDirectory: string
  window: () => DesktopWindow | null
}

interface RuntimeRecord {
  schemaVersion: 1
  instanceId: string
  instanceKind: WeworkDesktopControlBridgeOptions['instanceKind']
  displayName: string
  projectRoot: string | null
  pid: number
  address: string
  token: string
  startedAtUnixMs: number
}

export class WeworkDesktopControlBridge {
  private server: Server | null = null
  private runtimePath: string | null = null
  private readonly scripts = new Map<string, string>()

  constructor(private readonly options: WeworkDesktopControlBridgeOptions) {}

  async start(): Promise<void> {
    if (this.server) return
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
      throw new Error('Failed to read Wework desktop control address')
    }
    const runtimePath = join(
      this.options.registryDirectory,
      `${safeInstanceFilename(this.options.instanceId)}.json`
    )
    try {
      await writeRuntimeRecord(runtimePath, {
        schemaVersion: 1,
        instanceId: this.options.instanceId,
        instanceKind: this.options.instanceKind,
        displayName: this.options.displayName,
        projectRoot: this.options.projectRoot,
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
  }

  async stop(): Promise<void> {
    const server = this.server
    const runtimePath = this.runtimePath
    this.server = null
    this.runtimePath = null
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
    response.setHeader('content-type', 'application/json; charset=utf-8')
    if (request.headers.authorization !== `Bearer ${token}`) {
      writeResponse(response, 401, { ok: false, error: 'Unauthorized Wework desktop request' })
      return
    }
    try {
      if (request.method === 'GET' && request.url === '/status') {
        writeResponse(response, 200, { ok: true, data: this.status() })
        return
      }
      if (request.method !== 'POST' || request.url !== '/desktop') {
        writeResponse(response, 404, { ok: false, error: 'Unknown Wework desktop endpoint' })
        return
      }
      const input = await readJsonBody(request)
      writeResponse(response, 200, { ok: true, data: await this.dispatch(input) })
    } catch (error) {
      writeResponse(response, 200, { ok: false, error: errorMessage(error) })
    }
  }

  private status(): Record<string, unknown> {
    const target = this.options.window()
    return {
      instanceId: this.options.instanceId,
      instanceKind: this.options.instanceKind,
      displayName: this.options.displayName,
      projectRoot: this.options.projectRoot,
      pid: process.pid,
      ready: Boolean(target && !target.webContents.isDestroyed()),
      focused: target?.isFocused() ?? false,
      visible: target?.isVisible() ?? false,
      title: target?.webContents.getTitle() ?? null,
      url: target?.webContents.getURL() ?? null,
    }
  }

  private async dispatch(request: DesktopControlRequest): Promise<unknown> {
    if (request.action === 'focus') {
      const target = this.requiredWindow()
      if (target.isMinimized()) target.restore()
      target.show()
      target.focus()
      return { ok: true }
    }
    if (request.action === 'screenshot') {
      const image = await this.requiredContents().capturePage()
      return { ok: true, dataUrl: image.toDataURL() }
    }
    if (request.action === 'inspect') {
      return this.evaluate(
        (await this.loadScript('embedded_browser_inspect.js')).replace(
          '__WEWORK_INSPECT_OPTIONS__',
          JSON.stringify(request.options ?? {})
        )
      )
    }
    if (request.action === 'wait') return this.waitFor(request)
    if (['click', 'fill', 'press'].includes(request.action)) {
      const input = {
        action: request.action,
        selector: request.selector ?? null,
        text: request.text ?? null,
        key: request.key ?? null,
        inspectId: request.inspectId ?? null,
        index: request.index ?? null,
        ref: request.ref ?? null,
        options: request.options ?? null,
        previewOnly: false,
      }
      return this.evaluate(
        (await this.loadScript('embedded_browser_action.js')).replace(
          '__WEWORK_ACTION_INPUT__',
          JSON.stringify(input)
        ),
        true
      )
    }
    throw new Error(`Unknown Wework desktop action: ${request.action}`)
  }

  private async waitFor(request: DesktopControlRequest): Promise<unknown> {
    const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const startedAt = Date.now()
    const waitId = `wework-desktop-${randomBytes(8).toString('hex')}`
    let lastResult: unknown = null
    while (Date.now() - startedAt <= timeoutMs) {
      const input = {
        waitId,
        selector: request.selector ?? null,
        text: request.text ?? null,
        timeoutMs,
        options: request.options ?? null,
      }
      lastResult = await this.evaluate(
        (await this.loadScript('embedded_browser_wait.js')).replace(
          '__WEWORK_WAIT_INPUT__',
          JSON.stringify(input)
        )
      )
      if (
        lastResult &&
        typeof lastResult === 'object' &&
        !Array.isArray(lastResult) &&
        (lastResult as { ok?: unknown }).ok === true
      ) {
        return lastResult
      }
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    return lastResult
  }

  private requiredWindow(): DesktopWindow {
    const target = this.options.window()
    if (!target || target.webContents.isDestroyed()) {
      throw new Error('Wework desktop window is not ready')
    }
    return target
  }

  private requiredContents(): DesktopContents {
    return this.requiredWindow().webContents
  }

  private evaluate(code: string, userGesture = false): Promise<unknown> {
    return this.requiredContents().executeJavaScript(code, userGesture)
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

function safeInstanceFilename(instanceId: string): string {
  return instanceId.replace(/[^a-zA-Z0-9._-]+/g, '-')
}

async function writeRuntimeRecord(path: string, record: RuntimeRecord): Promise<void> {
  const directory = dirname(path)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  await chmod(directory, 0o700)
  const temporary = join(
    directory,
    `.${safeInstanceFilename(record.instanceId)}.${process.pid}.tmp`
  )
  await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 })
  await chmod(temporary, 0o600)
  await rename(temporary, path)
}

async function readJsonBody(
  request: import('node:http').IncomingMessage
): Promise<DesktopControlRequest> {
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_BODY_BYTES) throw new Error('Wework desktop request is too large')
    chunks.push(buffer)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Wework desktop request must be an object')
  }
  return value as DesktopControlRequest
}

function writeResponse(
  response: import('node:http').ServerResponse,
  status: number,
  value: unknown
): void {
  response.writeHead(status)
  response.end(`${JSON.stringify(value)}\n`)
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
