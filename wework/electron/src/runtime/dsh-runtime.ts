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
  authenticateBrowserSession?: (url: string) => Promise<void>
}

export class DshRuntime {
  private readonly process: RuntimeSupervisor | null
  private child: ChildProcessWithoutNullStreams | null = null
  private output = ''
  private authenticationUrl: string | null = null
  private authentication: Promise<string> | null = null

  constructor(private readonly options: DshRuntimeOptions) {
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
          probe: (_child, signal) =>
            waitForHttpEndpoints(runtimeProbeUrls(options), signal, () =>
              this.authenticate(signal)
            ),
        })
      : null
    this.process?.on('spawn', () => {
      this.output = ''
      this.authenticationUrl = null
      this.authentication = null
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
    return this.options.url
  }

  pid(): number | null {
    return this.process?.pid() ?? null
  }

  stop(): Promise<void> {
    if (this.child) this.options.hostPipe?.detachChild(this.child)
    return this.process?.stop() ?? Promise.resolve()
  }

  private captureAuthenticationUrl(chunk: string): void {
    this.output += chunk
    const lines = this.output.split('\n')
    this.output = lines.pop()?.slice(-8192) ?? ''
    for (const line of lines) {
      const announcement = line.match(/^dsh web: (http:\/\/[^\s]+)/)?.[1]
      if (!announcement || !URL.canParse(announcement)) continue
      const url = new URL(announcement)
      if (url.origin !== new URL(this.options.url).origin || !url.searchParams.has('token')) {
        continue
      }
      this.authenticationUrl = url.toString()
    }
  }

  private async authenticate(signal: AbortSignal): Promise<string> {
    const url = this.authenticationUrl
    if (!url) return ''
    this.authentication ??= this.exchangeBrowserSession(url, signal)
    return this.authentication
  }

  private async exchangeBrowserSession(url: string, signal: AbortSignal): Promise<string> {
    const response = await fetch(url, { signal, redirect: 'manual' })
    const cookies = response.headers.getSetCookie()
    if (response.status !== 303 || cookies.length === 0) {
      throw new Error('DSH browser session authentication failed')
    }
    await this.options.authenticateBrowserSession?.(url)
    return cookies.map(cookie => cookie.split(';')[0]).join('; ')
  }
}

function runtimeProbeUrls(options: DshRuntimeOptions): string[] {
  const configured = options.probeUrls?.filter(Boolean)
  return configured?.length ? configured : [options.probeUrl ?? options.url]
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
    const cookie = (await authenticate?.()) ?? ''
    try {
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
    const timer = setTimeout(resolve, milliseconds)
    timer.unref()
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(signal.reason)
      },
      { once: true }
    )
  })
}
