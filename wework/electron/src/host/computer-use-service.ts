import { randomBytes } from 'node:crypto'
import { createServer, type Server } from 'node:http'
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const RUNTIME_FILE = 'computer-use-bridge.json'
const MAX_BODY_BYTES = 8 * 1024 * 1024

interface CuaDriver {
  callTool(
    name: string,
    argumentsJson: string,
    options?: { signal?: AbortSignal }
  ): Promise<{
    text: string
    images: Array<{ mimeType: string; dataBase64: string }>
    structuredJson?: string
    isError: boolean
    errorCode?: string
    degraded: boolean
    rawJson: string
  }>
  listToolsJson(): Promise<string>
  shutdown(): Promise<void>
  uniffiDestroy?: () => void
}

interface PermissionStatus {
  accessibility: boolean
  screenRecording: boolean
}

export interface ComputerUseStatus {
  supported: boolean
  requiresPermissions: boolean
  enabled: boolean
  running: boolean
  accessibilityPermissionGranted: boolean
  screenRecordingPermissionGranted: boolean
  currentTool: string | null
  error: string | null
}

export class ComputerUseService {
  private driver: CuaDriver | null = null
  private server: Server | null = null
  private runtimePath: string | null = null
  private currentTool: string | null = null
  private currentActionController: AbortController | null = null
  private error: string | null = null
  private enabled = false
  private operation = Promise.resolve()

  constructor(
    private readonly executorHome: string,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  async status(): Promise<ComputerUseStatus> {
    if (this.enabled && !this.driver && !this.server) {
      await this.serial(() => this.start())
    }
    return this.snapshot()
  }

  private async snapshot(): Promise<ComputerUseStatus> {
    const permissions = await this.permissions()
    return {
      supported: isSupportedPlatform(this.platform),
      requiresPermissions: this.platform === 'darwin',
      enabled: this.enabled,
      running: Boolean(this.driver && this.server),
      accessibilityPermissionGranted: permissions.accessibility,
      screenRecordingPermissionGranted: permissions.screenRecording,
      currentTool: this.currentTool,
      error: this.error,
    }
  }

  setEnabled(enabled: boolean): Promise<ComputerUseStatus> {
    return this.serial(async () => {
      this.enabled = enabled
      if (enabled) await this.start()
      else await this.stopInternal()
      return this.snapshot()
    })
  }

  async requestPermissions(): Promise<ComputerUseStatus> {
    if (this.platform !== 'darwin') return this.status()
    const { requestMacOSPermissions } = await import('@trycua/cua-driver/electron')
    requestMacOSPermissions()
    return this.enabled ? this.setEnabled(true) : this.snapshot()
  }

  async openScreenRecordingSettings(): Promise<void> {
    if (this.platform !== 'darwin') return
    const { openMacOSScreenRecordingSettings } = await import('@trycua/cua-driver/electron')
    await openMacOSScreenRecordingSettings()
  }

  async stopCurrentAction(): Promise<ComputerUseStatus> {
    this.currentActionController?.abort()
    this.currentTool = null
    return this.snapshot()
  }

  stop(): Promise<void> {
    return this.serial(() => this.stopInternal())
  }

  private async start(): Promise<void> {
    if (this.driver && this.server) return
    this.error = null
    const runtimePath = this.runtimeRecordPath()
    let driver: CuaDriver | null = null
    let server: Server | null = null
    try {
      await rm(runtimePath, { force: true })
      if (!isSupportedPlatform(this.platform)) {
        this.error = `Computer use is not supported on ${this.platform}`
        return
      }
      const permissions = await this.permissions()
      if (!permissions.accessibility || !permissions.screenRecording) return
      const { CuaDriver } = await import('@trycua/cua-driver')
      const createdDriver = CuaDriver.create(undefined) as CuaDriver
      driver = createdDriver
      const token = randomBytes(32).toString('base64url')
      const createdServer = createServer((request, response) => {
        void this.handleRequest(request, response, token, createdDriver)
      })
      server = createdServer
      await new Promise<void>((resolve, reject) => {
        createdServer.once('error', reject)
        createdServer.listen(0, '127.0.0.1', () => {
          createdServer.off('error', reject)
          resolve()
        })
      })
      const address = createdServer.address()
      if (!address || typeof address === 'string') throw new Error('Computer use address missing')
      await writeRuntimeRecord(runtimePath, {
        schemaVersion: 1,
        pid: process.pid,
        address: `127.0.0.1:${address.port}`,
        token,
        startedAtUnixMs: Date.now(),
      })
      this.driver = createdDriver
      this.server = createdServer
      this.runtimePath = runtimePath
    } catch (error) {
      this.error = errorMessage(error)
      await Promise.allSettled([
        rm(runtimePath, { force: true }),
        server ? closeServer(server) : Promise.resolve(),
        driver?.shutdown(),
      ])
      driver?.uniffiDestroy?.()
    }
  }

  private async stopInternal(): Promise<void> {
    const driver = this.driver
    const server = this.server
    const runtimePath = this.runtimePath ?? this.runtimeRecordPath()
    this.driver = null
    this.server = null
    this.runtimePath = null
    this.currentTool = null
    this.currentActionController?.abort()
    this.currentActionController = null
    await Promise.allSettled([
      runtimePath ? rm(runtimePath, { force: true }) : Promise.resolve(),
      server ? closeServer(server) : Promise.resolve(),
      driver?.shutdown(),
    ])
    driver?.uniffiDestroy?.()
  }

  private async permissions(): Promise<PermissionStatus> {
    if (this.platform !== 'darwin') {
      const supported = isSupportedPlatform(this.platform)
      return { accessibility: supported, screenRecording: supported }
    }
    try {
      const { currentMacOsPermissionStatus } = await import('@trycua/cua-driver')
      return currentMacOsPermissionStatus()
    } catch (error) {
      this.error = errorMessage(error)
      return { accessibility: false, screenRecording: false }
    }
  }

  private async handleRequest(
    request: import('node:http').IncomingMessage,
    response: import('node:http').ServerResponse,
    token: string,
    driver: CuaDriver
  ): Promise<void> {
    response.setHeader('content-type', 'application/json')
    if (request.headers.authorization !== `Bearer ${token}`) {
      writeResponse(response, 401, { ok: false, error: 'Unauthorized computer use request' })
      return
    }
    if (request.method !== 'POST' || request.url !== '/computer') {
      writeResponse(response, 404, { ok: false, error: 'Unknown computer use endpoint' })
      return
    }
    let actionController: AbortController | null = null
    try {
      const body = await readJsonBody(request)
      if (body.action === 'listTools') {
        const catalog = JSON.parse(await driver.listToolsJson()) as { tools?: unknown }
        if (!Array.isArray(catalog.tools)) throw new Error('CUA tool catalog is invalid')
        writeResponse(response, 200, { ok: true, data: catalog.tools })
        return
      }
      if (body.action !== 'callTool' || typeof body.name !== 'string') {
        throw new Error('Invalid computer use action')
      }
      if (this.currentActionController) {
        throw new Error('Another computer use action is already running')
      }
      this.currentTool = body.name
      const controller = new AbortController()
      actionController = controller
      this.currentActionController = controller
      const result = await driver.callTool(body.name, JSON.stringify(body.arguments ?? {}), {
        signal: controller.signal,
      })
      writeResponse(response, 200, { ok: true, data: result })
    } catch (error) {
      this.error = errorMessage(error)
      writeResponse(response, 200, { ok: false, error: this.error })
    } finally {
      if (actionController && this.currentActionController === actionController) {
        this.currentActionController = null
        this.currentTool = null
      }
    }
  }

  private serial<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.operation.then(operation, operation)
    this.operation = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }

  private runtimeRecordPath(): string {
    return join(this.executorHome, 'runtime', RUNTIME_FILE)
  }
}

function closeServer(server: Server): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()))
}

async function readJsonBody(
  request: import('node:http').IncomingMessage
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    size += buffer.length
    if (size > MAX_BODY_BYTES) throw new Error('Computer use request is too large')
    chunks.push(buffer)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Computer use request must be an object')
  }
  return value as Record<string, unknown>
}

async function writeRuntimeRecord(path: string, record: Record<string, unknown>): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600 })
  await rename(temporary, path)
  await chmod(path, 0o600)
}

function writeResponse(
  response: import('node:http').ServerResponse,
  status: number,
  body: Record<string, unknown>
): void {
  response.statusCode = status
  response.end(JSON.stringify(body))
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isSupportedPlatform(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'linux' || platform === 'win32'
}
