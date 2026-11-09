import { fileURLToPath } from 'node:url'
import { fork, type ChildProcess } from 'node:child_process'
import type { ToolResult } from '@trycua/cua-driver'
import type { DriverRequest, DriverResponse } from './computer-use-driver-protocol.js'

const LIFECYCLE_TIMEOUT_MS = 10_000
const CANCELLATION_TIMEOUT_MS = 5_000
type Result = string | ToolResult | undefined

// Native AX calls against this app must cross a process boundary so AppKit
// dispatches them on the app's main thread instead of the driver's Rust worker.
export class ComputerUseDriverProcess {
  private nextId = 0
  private stopped = false
  private failure: Error | null = null
  private readonly exited: Promise<void>
  private readonly pending = new Map<
    number,
    { resolve: (result: Result) => void; reject: (error: Error) => void }
  >()

  /** Bind generation-scoped replies and observe native worker termination. */
  private constructor(
    private readonly child: ChildProcess,
    private readonly onExit: (error: Error) => void
  ) {
    child.on('message', (message: DriverResponse) => {
      const pending = this.pending.get(message.id)
      if (!pending) return
      this.pending.delete(message.id)
      if (message.ok) pending.resolve(message.result)
      else pending.reject(new Error(message.error))
    })
    this.exited = new Promise(resolve => {
      child.once('close', () => resolve())
      child.once('exit', (code, signal) => {
        resolve()
        this.fail(
          new Error(`Computer use driver exited (${signal ?? code}); action outcome is unknown`)
        )
      })
    })
    child.once('disconnect', () => {
      this.fail(new Error('Computer use driver IPC disconnected; action outcome is unknown'))
    })
    child.on('error', error => this.fail(error))
  }

  /** Start a host-owned native process and wait until its driver is ready. */
  static async create(onExit: (error: Error) => void): Promise<ComputerUseDriverProcess> {
    const execPath = (process as NodeJS.Process & { helperExecPath: string }).helperExecPath
    if (!execPath) throw new Error('Electron Node helper is unavailable')
    const child = fork(
      fileURLToPath(new URL('./computer-use-driver-worker.js', import.meta.url)),
      [],
      {
        execPath,
        execArgv: [],
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        serialization: 'advanced',
      }
    )
    const driver = new ComputerUseDriverProcess(child, onExit)
    try {
      await driver.lifecycle('start')
      return driver
    } catch (error) {
      driver.stopped = true
      child.kill('SIGKILL')
      await driver.exited
      throw error
    }
  }

  /** Read the SDK catalog without maintaining a second tool registry. */
  async listToolsJson(options?: { signal?: AbortSignal }): Promise<string> {
    return (await this.requestWithSignal(
      { id: ++this.nextId, method: 'listTools' },
      options?.signal
    )) as string
  }

  /** Forward cancellation to this request and await the native call's result. */
  async callTool(
    name: string,
    argumentsJson: string,
    options?: { signal?: AbortSignal }
  ): Promise<ToolResult> {
    return (await this.requestWithSignal(
      { id: ++this.nextId, method: 'callTool', name, argumentsJson },
      options?.signal
    )) as ToolResult
  }

  get pid(): number | undefined {
    return this.child.pid
  }

  /** A blocked native worker must not keep cancellation pending indefinitely. */
  private async requestWithSignal(message: DriverRequest, signal?: AbortSignal): Promise<Result> {
    signal?.throwIfAborted()
    let cancellationTimer: ReturnType<typeof setTimeout> | undefined
    const abort = () => {
      if (this.failure) return
      cancellationTimer = setTimeout(() => {
        this.fail(
          new Error('Computer use driver cancellation timed out; action outcome is unknown')
        )
        this.child.kill('SIGKILL')
      }, CANCELLATION_TIMEOUT_MS)
      this.send({ id: message.id, method: 'abort' })
    }
    signal?.addEventListener('abort', abort, { once: true })
    try {
      return await this.request(message)
    } finally {
      clearTimeout(cancellationTimer)
      signal?.removeEventListener('abort', abort)
    }
  }

  /** Stop the runtime and terminate its process even when native cleanup fails. */
  async shutdown(): Promise<void> {
    if (this.stopped) return this.exited
    this.stopped = true
    try {
      if (!this.failure) await this.lifecycle('shutdown')
    } finally {
      this.child.kill('SIGKILL')
      await this.exited
    }
  }

  /** Bound lifecycle operations without imposing that budget on desktop actions. */
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

  /** Correlate a trusted worker reply with its caller within this generation. */
  private request(message: DriverRequest): Promise<Result> {
    if (this.failure) return Promise.reject(this.failure)
    if (this.stopped && message.method !== 'shutdown') {
      return Promise.reject(new Error('Computer use driver is stopped'))
    }
    return new Promise((resolve, reject) => {
      this.pending.set(message.id, { resolve, reject })
      this.send(message)
    })
  }

  /** Node IPC reports closed channels through callbacks rather than native host crashes. */
  private send(message: DriverRequest): void {
    const onError = (error: Error | null) => {
      if (!error) return
      this.fail(new Error(`${error.message}; action outcome is unknown`))
      this.child.kill()
    }
    try {
      this.child.send(message, onError)
    } catch (error) {
      onError(error instanceof Error ? error : new Error(String(error)))
    }
  }

  /** Reject outstanding work once, preserving unknown outcomes without replay. */
  private fail(error: Error): void {
    if (this.failure) return
    this.failure = error
    for (const pending of this.pending.values()) pending.reject(error)
    this.pending.clear()
    if (!this.stopped) this.onExit(error)
  }
}
