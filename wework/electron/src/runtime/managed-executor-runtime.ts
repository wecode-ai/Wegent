import { randomBytes, randomUUID } from 'node:crypto'
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { rm } from 'node:fs/promises'
import { createConnection } from 'node:net'
import type { Socket } from 'node:net'
import { join, resolve } from 'node:path'
import { RuntimeSupervisor } from './runtime-supervisor.js'

export interface ManagedExecutorRuntimeOptions {
  command: string
  args: string[]
  environment: NodeJS.ProcessEnv
  dataDirectory: string
  logDirectory: string
  deviceId: string
  onEvent?: (event: string, payload: Record<string, unknown>) => void
}

export class ManagedExecutorRuntime {
  private readonly endpoint: string
  private readonly token = randomBytes(32).toString('base64url')
  private readonly process: RuntimeSupervisor
  private eventSocket: Socket | null = null

  constructor(private readonly options: ManagedExecutorRuntimeOptions) {
    this.endpoint = localExecutorEndpoint()
    const environment = prepareManagedExecutorEnvironment(options)
    this.process = new RuntimeSupervisor({
      command: options.command,
      args: options.args,
      env: {
        ...environment,
        WEGENT_APP_IPC_DEVICE_ID: options.deviceId,
        WEGENT_APP_IPC_ENDPOINT: this.endpoint,
        WEGENT_APP_IPC_TOKEN: this.token,
      },
      name: 'wegent-executor',
      log: { path: join(options.logDirectory, 'executor-runtime.log') },
      probe: (_child, signal) => waitForEndpointAuthentication(this.endpoint, this.token, signal),
    })
  }

  async start(): Promise<void> {
    await this.process.start()
    if (this.options.onEvent) {
      this.eventSocket = await connectEventStream(this.endpoint, this.token, this.options.onEvent)
    }
  }

  environment(): NodeJS.ProcessEnv {
    return {
      WEWORK_EXECUTOR_ENDPOINT: this.endpoint,
      WEWORK_EXECUTOR_TOKEN: this.token,
    }
  }

  pid(): number | null {
    return this.process.pid()
  }

  async stop(): Promise<void> {
    this.eventSocket?.destroy()
    this.eventSocket = null
    await this.process.stop()
    if (process.platform !== 'win32') {
      await rm(this.endpoint, { force: true })
    }
  }
}

export function prepareManagedExecutorEnvironment(
  options: Pick<ManagedExecutorRuntimeOptions, 'environment' | 'dataDirectory'>
): NodeJS.ProcessEnv {
  const executorHome =
    options.environment.WEGENT_EXECUTOR_HOME?.trim() || join(options.dataDirectory, 'executor')
  const codexHome = options.environment.WEGENT_CODEX_HOME?.trim() || join(executorHome, 'codex')
  const nativeCodexHome = resolveNativeCodexHome(options.environment, codexHome)
  if (nativeCodexHome) prepareCodexAuth(nativeCodexHome, codexHome)
  return {
    ...options.environment,
    CODEX_HOME: codexHome,
    WEGENT_CODEX_HOME: codexHome,
    WEGENT_EXECUTOR_HOME: executorHome,
  }
}

function resolveNativeCodexHome(
  environment: NodeJS.ProcessEnv,
  managedCodexHome: string
): string | null {
  if (environment.VITE_WEWORK_E2E === 'true') {
    return environment.WEWORK_E2E_NATIVE_CODEX_HOME?.trim() || null
  }
  const configured = environment.CODEX_HOME?.trim()
  if (configured && resolve(configured) !== resolve(managedCodexHome)) return configured
  const home = environment.HOME?.trim() || homedir()
  return join(home, '.codex')
}

function prepareCodexAuth(nativeCodexHome: string, managedCodexHome: string): void {
  const source = join(nativeCodexHome, 'auth.json')
  const target = join(managedCodexHome, 'auth.json')
  mkdirSync(managedCodexHome, { recursive: true, mode: 0o700 })
  if (samePath(source, target) || !existsSync(source)) return
  if (existsSync(target)) return
  try {
    const metadata = lstatSync(target)
    if (!metadata.isSymbolicLink()) return
    const linked = resolve(managedCodexHome, readlinkSync(target))
    if (linked === resolve(source)) return
    rmSync(target, { force: true })
  } catch {
    // Missing targets are expected on first launch.
  }
  if (process.platform === 'win32') {
    copyFileSync(source, target)
    return
  }
  symlinkSync(source, target)
}

function samePath(left: string, right: string): boolean {
  return resolve(left) === resolve(right)
}

function connectEventStream(
  endpoint: string,
  token: string,
  onEvent: (event: string, payload: Record<string, unknown>) => void
): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let authenticated = false
    let settled = false
    let buffer = ''
    socket.setEncoding('utf8')
    socket.once('connect', () => {
      socket.write(
        `${JSON.stringify({
          type: 'authenticate',
          protocol_version: 1,
          token,
        })}\n`
      )
    })
    socket.on('data', chunk => {
      buffer += chunk
      for (;;) {
        const newline = buffer.indexOf('\n')
        if (newline < 0) break
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        try {
          const message = JSON.parse(line) as {
            type?: unknown
            ok?: unknown
            protocol_version?: unknown
            event?: unknown
            payload?: unknown
          }
          if (!authenticated) {
            if (
              message.type !== 'authenticated' ||
              message.ok !== true ||
              message.protocol_version !== 1
            ) {
              throw new Error('Executor rejected event stream authentication')
            }
            authenticated = true
            settled = true
            resolve(socket)
            continue
          }
          if (message.type !== 'event' || typeof message.event !== 'string') continue
          const payload =
            message.payload &&
            typeof message.payload === 'object' &&
            !Array.isArray(message.payload)
              ? (message.payload as Record<string, unknown>)
              : {}
          onEvent(message.event, payload)
        } catch (error) {
          socket.destroy(error instanceof Error ? error : new Error(String(error)))
        }
      }
    })
    socket.once('error', error => {
      if (!settled) reject(error)
    })
    socket.once('close', () => {
      if (!settled) reject(new Error('Executor event stream closed before authentication'))
    })
  })
}

function localExecutorEndpoint(): string {
  const nonce = randomUUID()
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\wegent-executor-${nonce}`
  }
  const user = process.getuid?.() ?? 'user'
  return join('/tmp', `wegent-executor-${user}`, `${nonce}.sock`)
}

export async function waitForEndpointAuthentication(
  endpoint: string,
  token: string,
  signal: AbortSignal
): Promise<void> {
  let lastError: unknown
  while (!signal.aborted) {
    try {
      await authenticate(endpoint, token, signal)
      return
    } catch (error) {
      if (signal.aborted) break
      lastError = error
    }
    await abortableDelay(50, signal)
  }
  throw new Error('Executor local endpoint did not become ready', {
    cause: signal.reason ?? lastError,
  })
}

function authenticate(endpoint: string, token: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(endpoint)
    let buffer = ''
    const onAbort = () => {
      socket.destroy()
      reject(signal.reason)
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    socket.setEncoding('utf8')
    socket.once('connect', () => {
      socket.write(
        `${JSON.stringify({
          type: 'authenticate',
          protocol_version: 1,
          token,
        })}\n`
      )
    })
    socket.on('data', chunk => {
      buffer += chunk
      const newline = buffer.indexOf('\n')
      if (newline < 0) {
        if (Buffer.byteLength(buffer) > 4096) {
          socket.destroy(new Error('Executor authentication response is too large'))
        }
        return
      }
      try {
        const message = JSON.parse(buffer.slice(0, newline)) as {
          type?: unknown
          ok?: unknown
          protocol_version?: unknown
        }
        if (
          message.type !== 'authenticated' ||
          message.ok !== true ||
          message.protocol_version !== 1
        ) {
          throw new Error('Executor rejected local endpoint authentication')
        }
        cleanup()
        socket.end()
        resolve()
      } catch (error) {
        socket.destroy(error instanceof Error ? error : new Error(String(error)))
      }
    })
    socket.once('error', error => {
      cleanup()
      reject(error)
    })
    socket.once('close', () => cleanup())
  })
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds)
    timeout.unref()
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timeout)
        reject(signal.reason)
      },
      { once: true }
    )
  })
}
