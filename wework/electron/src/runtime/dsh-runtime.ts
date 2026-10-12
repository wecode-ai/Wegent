import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import type { HostPipeServer } from '../host/host-pipe.js'
import { RuntimeSupervisor } from './runtime-supervisor.js'

const LOCAL_READINESS_RETRY_INTERVAL_MS = 25

export interface DshRuntimeOptions {
  url: string
  name?: string
  probeUrl?: string
  probeUrls?: string[]
  command?: string
  args?: string[]
  cwd?: string
  env?: NodeJS.ProcessEnv
  logDirectory?: string
  logFileName?: string
  hostPipe?: HostPipeServer
  startTimeoutMs?: number
  authenticateBrowserSession?: (url: string, cookie: string) => Promise<void>
  onRestarted?: () => Promise<void>
}

export class DshRuntime {
  private readonly process: RuntimeSupervisor | null
  private child: ChildProcessWithoutNullStreams | null = null
  private output = ''
  private authenticationUrl: string | null = null
  private authentication: Promise<string> | null = null
  private runtimeUrl: string
  private becameReady = false
  private readonly receiveRuntimeEndpoint = (
    child: ChildProcessWithoutNullStreams | null,
    url: string
  ): void => {
    if (this.child && this.child === child) this.acceptAuthenticationUrl(url)
  }

  constructor(private readonly options: DshRuntimeOptions) {
    this.runtimeUrl = options.url
    this.process = options.command
      ? new RuntimeSupervisor({
          command: options.command,
          args: options.args,
          cwd: options.cwd,
          env: options.env,
          name: options.name ?? 'dsh-web',
          ...(options.logDirectory
            ? {
                log: {
                  path: join(options.logDirectory, options.logFileName ?? 'dsh-runtime.log'),
                },
              }
            : {}),
          ...(options.hostPipe ? { extraPipeCount: 2 } : {}),
          startTimeoutMs: options.startTimeoutMs,
          probe: async (_child, signal) => {
            while (new URL(this.runtimeUrl).port === '0') {
              await abortableDelay(LOCAL_READINESS_RETRY_INTERVAL_MS, signal)
            }
            await waitForHttpEndpoints(runtimeProbeUrls(options, this.runtimeUrl), signal, () =>
              this.authenticate(signal)
            )
            if (this.becameReady) await options.onRestarted?.()
            this.becameReady = true
          },
        })
      : null
    this.process?.on('spawn', () => {
      this.output = ''
      this.authenticationUrl = null
      this.authentication = null
      this.runtimeUrl = options.url
    })
    this.process?.on('stdout', chunk => this.captureAuthenticationUrl(chunk))
    if (this.process && options.hostPipe) {
      this.process.on('spawn', child => {
        this.child = child
        options.hostPipe?.attach(child)
      })
    }
  }

  async start(timeoutMs = 30_000): Promise<void> {
    if (this.process) {
      this.options.hostPipe?.off('runtimeEndpoint', this.receiveRuntimeEndpoint)
      this.options.hostPipe?.on('runtimeEndpoint', this.receiveRuntimeEndpoint)
      await this.process.start()
      return
    }
    const controller = new AbortController()
    const timeout = setTimeout(
      () => controller.abort(new Error('DSH startup timed out')),
      timeoutMs
    )
    timeout.unref()
    try {
      await waitForHttpEndpoints(runtimeProbeUrls(this.options), controller.signal)
    } finally {
      clearTimeout(timeout)
    }
  }

  url(): string {
    return this.runtimeUrl
  }

  pid(): number | null {
    return this.process?.pid() ?? null
  }

  stop(): Promise<void> {
    this.becameReady = false
    this.options.hostPipe?.off('runtimeEndpoint', this.receiveRuntimeEndpoint)
    if (this.child) this.options.hostPipe?.detachChild(this.child)
    return this.process?.stop() ?? Promise.resolve()
  }

  private captureAuthenticationUrl(chunk: string): void {
    this.output += chunk
    const lines = this.output.split('\n')
    this.output = lines.pop()?.slice(-8192) ?? ''
    for (const line of lines) {
      const announcement = line.match(/^dsh web: (http:\/\/[^\s]+)/)?.[1]
      if (announcement) this.acceptAuthenticationUrl(announcement)
    }
  }

  private acceptAuthenticationUrl(announcement: string): void {
    if (!URL.canParse(announcement)) return
    const url = new URL(announcement)
    const configured = new URL(this.options.url)
    const dynamicPort = configured.port === '0'
    const matchesOrigin = dynamicPort
      ? url.protocol === configured.protocol &&
        url.hostname === configured.hostname &&
        !url.username &&
        !url.password &&
        Number(url.port) > 0 &&
        Number(url.port) <= 65535
      : url.origin === configured.origin
    if (!matchesOrigin || !url.searchParams.has('token')) {
      return
    }
    if (dynamicPort) this.runtimeUrl = url.origin
    this.authenticationUrl = url.toString()
  }

  private async authenticate(signal: AbortSignal): Promise<string> {
    const url = this.authenticationUrl
    if (!url) return ''
    this.authentication ??= this.exchangeBrowserSession(url, signal).catch(error => {
      this.authentication = null
      throw error
    })
    return this.authentication
  }

  private async exchangeBrowserSession(url: string, signal: AbortSignal): Promise<string> {
    const response = await fetch(url, { signal, redirect: 'manual' })
    const cookies = response.headers.getSetCookie()
    if (response.status !== 303 || cookies.length === 0) {
      throw new Error('DSH browser session authentication failed')
    }
    const cookie = cookies.map(value => value.split(';')[0]).join('; ')
    await this.options.authenticateBrowserSession?.(url, cookie)
    return cookie
  }
}

function runtimeProbeUrls(options: DshRuntimeOptions, runtimeUrl = options.url): string[] {
  const configured = options.probeUrls?.filter(Boolean)
  const urls = configured?.length ? configured : [options.probeUrl ?? options.url]
  return urls.map(value => {
    const url = new URL(value)
    if (url.origin !== new URL(options.url).origin) return value
    return new URL(`${url.pathname}${url.search}`, runtimeUrl).toString()
  })
}

async function waitForHttpEndpoints(
  urls: string[],
  signal: AbortSignal,
  authenticate?: () => Promise<string>
): Promise<void> {
  for (const url of urls) {
    await waitForHttp(url, signal, authenticate)
  }
}

async function waitForHttp(
  url: string,
  signal: AbortSignal,
  authenticate?: () => Promise<string>
): Promise<void> {
  let lastError: unknown
  while (!signal.aborted) {
    try {
      const cookie = (await authenticate?.()) ?? ''
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
        headers: { cookie },
      })
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      if (signal.aborted) break
      lastError = error
    }
    await abortableDelay(LOCAL_READINESS_RETRY_INTERVAL_MS, signal)
  }
  if (signal.reason instanceof Error) throw signal.reason
  throw new Error(`DSH did not become reachable at ${url}`, {
    cause: signal.reason ?? lastError,
  })
}

function abortableDelay(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer)
      signal.removeEventListener('abort', abort)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort)
      resolve()
    }, milliseconds)
    timer.unref()
    signal.addEventListener('abort', abort, { once: true })
  })
}
