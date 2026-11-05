import { fileURLToPath } from 'node:url'
import { utilityProcess, type UtilityProcess } from 'electron'
import type { ToolResult } from '@trycua/cua-driver'
import type { DriverRequest, DriverResponse } from './computer-use-driver-protocol.js'

const LIFECYCLE_TIMEOUT_MS = 10_000
type Result = string | ToolResult | undefined

// Native AX calls against this app must cross a process boundary so AppKit
// dispatches them on the app's main thread instead of the driver's Rust worker.
export class ComputerUseDriverProcess {
  private nextId = 0
  private stopped = false
  private failure: Error | null = null
  private readonly pending = new Map<
    number,
    { resolve: (result: Result) => void; reject: (error: Error) => void }
  >()

  private constructor(
    private readonly child: UtilityProcess,
    private readonly onExit: (error: Error) => void
  ) {
    child.on('message', (message: DriverResponse) => {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.ok) pending.resolve(message.result)
      else pending.reject(new Error(message.error))
    })
    child.once('exit', code => {
      this.fail(new Error(`Computer use driver exited (${code}); action outcome is unknown`))
    })
    child.on('error', (type, location) => {
      this.fail(new Error(`Computer use driver ${type} at ${location}; action outcome is unknown`))
    })
  }

  static async create(onExit: (error: Error) => void): Promise<ComputerUseDriverProcess> {
    const child = utilityProcess.fork(
      fileURLToPath(new URL('./computer-use-driver-worker.js', import.meta.url)),
      [],
      { serviceName: 'Wework Computer Use', stdio: 'ignore', disclaim: false }
    )
    const driver = new ComputerUseDriverProcess(child, onExit)
    try {
      await driver.lifecycle('start')
      return driver
    } catch (error) {
      driver.stopped = true
      child.kill()
      throw error
    }
  }

  async listToolsJson(): Promise<string> {
    return (await this.request({ id: ++this.nextId, method: 'listTools' })) as string
  }

  async callTool(
    name: string,
    argumentsJson: string,
    options?: { signal?: AbortSignal }
  ): Promise<ToolResult> {
    const signal = options?.signal
    signal?.throwIfAborted()
    const id = ++this.nextId
    const abort = () => {
      if (this.failure) return
      try {
        this.child.postMessage({ id, method: 'abort' } satisfies DriverRequest)
      } catch (error) {
        this.fail(error instanceof Error ? error : new Error(String(error)))
        this.child.kill()
      }
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      return (await this.request({ id, method: 'callTool', name, argumentsJson })) as ToolResult
    } finally {
      signal?.removeEventListener('abort', abort)
    }
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    try {
      if (!this.failure) await this.lifecycle('shutdown')
    } finally {
      this.child.kill()
    }
  }

  private async lifecycle(method: 'start' | 'shutdown'): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await Promise.race([
        this.request({ id: ++this.nextId, method }),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Computer use driver ${method} timed out`)),
            LIFECYCLE_TIMEOUT_MS
          )
        }),
      ])
    } finally {
      clearTimeout(timer)
    }
  }

  private request(message: DriverRequest): Promise<Result> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.stopped && message.method !== 'shutdown') {
      return Promise.reject(new Error('Computer use driver is stopped'))
    }
    return new Promise((resolve, reject) => {
      this.pending.set(message.id, { resolve, reject })
      try {
        this.child.postMessage(message)
      } catch (error) {
        this.pending.delete(message.id)
        reject(error)
      }
    })
  }

  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    if (!this.stopped) this.onExit(error)
  }
}
