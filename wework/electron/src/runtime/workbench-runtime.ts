import type { DshRuntimeOptions } from './dsh-runtime.js'
import type { HostPipeServer } from '../host/host-pipe.js'
import { DshRuntime } from './dsh-runtime.js'

const FORBIDDEN_ENVIRONMENT_PREFIXES = [
  'WEWORK_ELECTRON_HOST_',
  'WEWORK_EXECUTOR_',
  'WEGENT_APP_IPC_',
] as const

export interface WorkbenchRuntimeLaunch {
  tabId: string
  url: string
  command: string
  args?: string[]
  cwd?: string
  environment?: NodeJS.ProcessEnv
  logDirectory?: string
  hostPipe?: HostPipeServer
  hostPrincipal?: string
}

export interface WorkbenchRuntimeSnapshot {
  tabId: string
  url: string
  pid: number | null
}

export interface WorkbenchRuntimeHandle {
  start(): Promise<void>
  stop(): Promise<void>
  url(): string
  pid(): number | null
}

export type WorkbenchRuntimeFactory = (options: DshRuntimeOptions) => WorkbenchRuntimeHandle

/**
 * Owns isolated DSH processes embedded by dynamic workbench tabs.
 *
 * Workbench runtimes are presentation/application carriers. They do not
 * inherit the core Electron Host pipe or Wegent executor credentials.
 */
export class WorkbenchRuntimeManager {
  private readonly runtimes = new Map<string, WorkbenchRuntimeHandle>()

  constructor(
    private readonly createRuntime: WorkbenchRuntimeFactory = options => new DshRuntime(options)
  ) {}

  async open(launch: WorkbenchRuntimeLaunch): Promise<WorkbenchRuntimeSnapshot> {
    const tabId = requiredTabId(launch.tabId)
    const existing = this.runtimes.get(tabId)
    if (existing) return snapshot(tabId, existing)

    const runtime = this.createRuntime({
      name: `dsh-workbench-${safeName(tabId)}`,
      url: launch.url,
      probeUrl: launch.url,
      command: launch.command,
      args: launch.args,
      cwd: launch.cwd,
      env: workbenchEnvironment(launch),
      logDirectory: launch.logDirectory,
      logFileName: `dsh-workbench-${safeName(tabId)}.log`,
      ...(launch.hostPipe ? { hostPipe: launch.hostPipe } : {}),
    })
    this.runtimes.set(tabId, runtime)
    try {
      await runtime.start()
      return snapshot(tabId, runtime)
    } catch (error) {
      this.runtimes.delete(tabId)
      await runtime.stop().catch(() => {})
      throw error
    }
  }

  get(tabId: string): WorkbenchRuntimeSnapshot | null {
    const runtime = this.runtimes.get(tabId)
    return runtime ? snapshot(tabId, runtime) : null
  }

  list(): WorkbenchRuntimeSnapshot[] {
    return [...this.runtimes.entries()].map(([tabId, runtime]) => snapshot(tabId, runtime))
  }

  async close(tabId: string): Promise<void> {
    const runtime = this.runtimes.get(tabId)
    if (!runtime) return
    this.runtimes.delete(tabId)
    await runtime.stop()
  }

  async stop(): Promise<void> {
    const runtimes = [...this.runtimes.values()]
    this.runtimes.clear()
    await Promise.allSettled(runtimes.map(runtime => runtime.stop()))
  }
}

function workbenchEnvironment(launch: WorkbenchRuntimeLaunch): NodeJS.ProcessEnv {
  const environment = isolatedWorkbenchEnvironment(launch.environment)
  if (!launch.hostPipe) return environment
  if (!launch.hostPrincipal?.trim()) throw new Error('Workbench Host principal is required')
  return {
    ...environment,
    ...launch.hostPipe.environment(),
    WEWORK_ELECTRON_HOST_PRINCIPAL: launch.hostPrincipal,
  }
}

export function isolatedWorkbenchEnvironment(
  environment: NodeJS.ProcessEnv = {}
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name]) => !FORBIDDEN_ENVIRONMENT_PREFIXES.some(prefix => name.startsWith(prefix))
    )
  )
}

function snapshot(tabId: string, runtime: WorkbenchRuntimeHandle): WorkbenchRuntimeSnapshot {
  return { tabId, url: runtime.url(), pid: runtime.pid() }
}

function requiredTabId(tabId: string): string {
  const value = tabId.trim()
  if (!value) throw new Error('Workbench runtime tabId is required')
  return value
}

function safeName(value: string): string {
  return value.replace(/[^0-9A-Za-z.-]/g, '-').slice(0, 80)
}
