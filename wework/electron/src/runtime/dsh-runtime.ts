import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { Readable } from 'node:stream'
import { join } from 'node:path'
import type { HostPipeServer } from '../host/host-pipe.js'
import { RuntimeSupervisor } from './runtime-supervisor.js'

type HttpRequest = (url: string, init?: RequestInit) => Promise<Response>

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
}

export class DshRuntime {
  private readonly process: RuntimeSupervisor | null
  private child: ChildProcessWithoutNullStreams | null = null

  constructor(private readonly options: DshRuntimeOptions) {
    const browserAuthentication = options.env?.WEWORK_DSH_BROWSER_AUTH === '1'
    this.process = options.command
      ? new RuntimeSupervisor({
          command: options.command,
          args: options.args,
          cwd: options.cwd,
          env: {
            ...options.env,
            ...(browserAuthentication ? { WEWORK_DSH_BROWSER_AUTH_FD: '5' } : {}),
          },
          name: options.name ?? 'dsh-web',
          ...(options.logDirectory
            ? {
                log: {
                  path: join(options.logDirectory, options.logFileName ?? 'dsh-runtime.log'),
                },
              }
            : {}),
          ...(browserAuthentication
            ? { extraPipeCount: 3 }
            : options.hostPipe
              ? { extraPipeCount: 2 }
              : {}),
          startTimeoutMs: options.startTimeoutMs,
          probe: async (child, signal) => {
            const request = browserAuthentication
              ? await authenticateBrowser(child, options.url, signal)
              : fetch
            await waitForHttpEndpoints(runtimeProbeUrls(options), signal, request)
          },
        })
      : null
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
}

function runtimeProbeUrls(options: DshRuntimeOptions): string[] {
  const configured = options.probeUrls?.filter(Boolean)
  return configured?.length ? configured : [options.probeUrl ?? options.url]
}

async function waitForHttpEndpoints(
  urls: string[],
  signal: AbortSignal,
  request: HttpRequest = fetch
): Promise<void> {
  for (const url of urls) {
    await waitForHttp(url, signal, request)
  }
}

async function waitForHttp(url: string, signal: AbortSignal, request: HttpRequest): Promise<void> {
  let lastError: unknown
  while (!signal.aborted) {
    try {
      const response = await request(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
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

async function authenticateBrowser(
  child: ChildProcessWithoutNullStreams,
  baseUrl: string,
  signal: AbortSignal
): Promise<HttpRequest> {
  const pipe = child.stdio.at(5) as Readable | null | undefined
  if (!pipe) throw new Error('DSH browser authentication pipe is unavailable')
  const lines = createInterface({ input: pipe })
  const authenticatedUrl = await new Promise<string>((resolve, reject) => {
    const abort = () => {
      reject(signal.reason)
      lines.close()
    }
    if (signal.aborted) return abort()
    signal.addEventListener('abort', abort, { once: true })
    lines.once('line', line => {
      signal.removeEventListener('abort', abort)
      try {
        const url = new URL(JSON.parse(line).url)
        if (
          url.origin !== new URL(baseUrl).origin ||
          url.pathname !== '/' ||
          !url.searchParams.get('token')
        ) {
          throw new Error('Invalid DSH browser authentication URL')
        }
        resolve(url.href)
      } catch {
        reject(new Error('Invalid DSH browser authentication response'))
      } finally {
        lines.close()
      }
    })
    lines.once('close', () => {
      signal.removeEventListener('abort', abort)
      reject(new Error('DSH browser authentication pipe closed'))
    })
  })
  const { session } = await import('electron')
  const request = session.defaultSession.fetch.bind(session.defaultSession)
  const response = await request(authenticatedUrl, { signal })
  if (!response.ok) throw new Error(`DSH browser authentication failed: HTTP ${response.status}`)
  return request
}
