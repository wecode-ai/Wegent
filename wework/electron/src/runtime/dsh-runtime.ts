import type { ChildProcessWithoutNullStreams } from 'node:child_process'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { createInterface } from 'node:readline'
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
  private listeningUrl: string

  constructor(private readonly options: DshRuntimeOptions) {
    this.listeningUrl = options.url
    const args = options.args ? [...options.args] : undefined
    const browserAuthentication = options.env?.WEWORK_DSH_BROWSER_AUTH === '1'
    this.process = options.command
      ? new RuntimeSupervisor({
          command: options.command,
          args,
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
          ...(process.platform === 'win32' ? { stopTimeoutMs: 15_000 } : {}),
          startTimeoutMs: options.startTimeoutMs,
          probe: async (child, signal) => {
            if (new URL(options.url).port === '0') {
              this.listeningUrl = await waitForListeningUrl(child, signal)
              const portFlag = args?.indexOf('--port') ?? -1
              if (args && portFlag >= 0 && args[portFlag + 1] === '0') {
                args[portFlag + 1] = new URL(this.listeningUrl).port
              }
            }
            const request = browserAuthentication
              ? await authenticateBrowser(child, this.listeningUrl, signal)
              : fetch
            await waitForHttpEndpoints(
              runtimeProbeUrls(options, this.listeningUrl),
              signal,
              request
            )
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
    return this.listeningUrl
  }

  pid(): number | null {
    return this.process?.pid() ?? null
  }

  stop(): Promise<void> {
    if (this.child) this.options.hostPipe?.detachChild(this.child)
    return this.process?.stop() ?? Promise.resolve()
  }
}

function runtimeProbeUrls(options: DshRuntimeOptions, listeningUrl = options.url): string[] {
  const configured = options.probeUrls?.filter(Boolean)
  const urls = configured?.length ? configured : [options.probeUrl ?? options.url]
  return urls.map(url => {
    const probe = new URL(url)
    if (probe.origin === new URL(options.url).origin) {
      return new URL(`${probe.pathname}${probe.search}`, listeningUrl).href
    }
    return url
  })
}

function waitForListeningUrl(
  child: ChildProcessWithoutNullStreams,
  signal: AbortSignal
): Promise<string> {
  if (signal.aborted) return Promise.reject(signal.reason)
  return new Promise((resolve, reject) => {
    const lines = createInterface({ input: child.stdout })
    const cleanUp = () => {
      signal.removeEventListener('abort', abort)
      lines.removeAllListeners()
      lines.close()
      child.stdout.resume()
    }
    const abort = () => {
      cleanUp()
      reject(signal.reason)
    }
    lines.on('line', line => {
      const match = /^dsh web: (http:\/\/127\.0\.0\.1:(\d+))(?:[/?]|\s|$)/.exec(line)
      if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) return
      cleanUp()
      resolve(match[1])
    })
    lines.once('close', () => {
      cleanUp()
      reject(new Error('DSH exited without announcing its listening URL'))
    })
    signal.addEventListener('abort', abort, { once: true })
  })
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
