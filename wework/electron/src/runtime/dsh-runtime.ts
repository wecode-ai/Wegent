import { join } from 'node:path'
import type { HostPipeServer } from '../host/host-pipe.js'
import { RuntimeSupervisor } from './runtime-supervisor.js'

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
          probe: (_child, signal) => waitForHttpEndpoints(runtimeProbeUrls(options), signal),
        })
      : null
    if (this.process && options.hostPipe) {
      this.process.on('spawn', child => options.hostPipe?.attach(child))
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
    this.options.hostPipe?.stop()
    return this.process?.stop() ?? Promise.resolve()
  }
}

function runtimeProbeUrls(options: DshRuntimeOptions): string[] {
  const configured = options.probeUrls?.filter(Boolean)
  return configured?.length ? configured : [options.probeUrl ?? options.url]
}

async function waitForHttpEndpoints(urls: string[], signal: AbortSignal): Promise<void> {
  for (const url of urls) {
    await waitForHttp(url, signal)
  }
}

async function waitForHttp(url: string, signal: AbortSignal): Promise<void> {
  let lastError: unknown
  while (!signal.aborted) {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
      })
      if (response.ok) return
      lastError = new Error(`HTTP ${response.status}`)
    } catch (error) {
      if (signal.aborted) break
      lastError = error
    }
    await abortableDelay(250, signal)
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
