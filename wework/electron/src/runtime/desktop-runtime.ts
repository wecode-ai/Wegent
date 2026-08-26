import { createServer } from 'node:net'
import type { HostPipeServer } from '../host/host-pipe.js'
import { prepareCoreDshLaunch } from './core-dsh-runtime.js'
import { resolveDesktopDeviceId } from './desktop-device-id.js'
import { CoreDshPluginManager, type CoreDshPlugin } from './core-dsh-plugin-manager.js'
import { DshRuntime } from './dsh-runtime.js'
import { ManagedExecutorRuntime, managedExecutorHome } from './managed-executor-runtime.js'
import {
  WorkbenchRuntimeManager,
  type WorkbenchRuntimeLaunch,
  type WorkbenchRuntimeSnapshot,
} from './workbench-runtime.js'

const CORE_APP_PATH = '/wework/app/'

export interface DesktopRuntimeOptions {
  environment: NodeJS.ProcessEnv
  dataDirectory: string
  logDirectory: string
  hostPipe: HostPipeServer
  onExecutorEvent?: (event: string, payload: Record<string, unknown>) => void
}

export interface DesktopRuntimeState {
  coreDshUrl: string | null
  executorConfigured: boolean
  workbenchRuntimeCount: number
  ready: boolean
}

export interface DesktopRuntimeDiagnostics {
  coreDshPid: number | null
  executorPid: number | null
  workbenchRuntimes: WorkbenchRuntimeSnapshot[]
}

export class DesktopRuntime {
  private executor: ManagedExecutorRuntime | null = null
  private coreDsh: DshRuntime | null = null
  private coreDshPlugins: CoreDshPluginManager | null = null
  private readonly workbench = new WorkbenchRuntimeManager()
  private started = false

  constructor(private readonly options: DesktopRuntimeOptions) {}

  async start(): Promise<void> {
    if (this.started) return
    try {
      await this.startExecutor()
      await this.startCoreDsh()
      this.started = true
    } catch (error) {
      await this.stop()
      throw error
    }
  }

  state(): DesktopRuntimeState {
    return {
      coreDshUrl: this.coreDsh ? this.coreDshUrl() : null,
      executorConfigured: this.executor !== null,
      workbenchRuntimeCount: this.workbench.list().length,
      ready: this.started && this.coreDsh !== null,
    }
  }

  coreDshUrl(): string {
    return new URL(CORE_APP_PATH, this.coreDshOrigin()).toString()
  }

  coreDshOrigin(): string {
    const url = this.coreDsh?.url()
    if (!url) throw new Error('Core DSH runtime is unavailable')
    return new URL('/', url).toString()
  }

  diagnostics(): DesktopRuntimeDiagnostics {
    return {
      coreDshPid: this.coreDsh?.pid() ?? null,
      executorPid: this.executor?.pid() ?? null,
      workbenchRuntimes: this.workbench.list(),
    }
  }

  requestExecutor<Result>(method: string, params: Record<string, unknown> = {}): Promise<Result> {
    if (!this.executor) {
      return Promise.reject(new Error('Managed executor is unavailable'))
    }
    return this.executor.request<Result>(method, params)
  }

  openWorkbenchRuntime(launch: WorkbenchRuntimeLaunch): Promise<WorkbenchRuntimeSnapshot> {
    if (!this.started) {
      return Promise.reject(new Error('Core desktop runtime is not ready'))
    }
    return this.workbench.open(launch)
  }

  listCoreDshPlugins(): Promise<CoreDshPlugin[]> {
    return this.requiredCoreDshPlugins().list()
  }

  installCoreDshPlugin(spec: string): Promise<CoreDshPlugin[]> {
    return this.requiredCoreDshPlugins().install(spec)
  }

  updateCoreDshPlugin(name: string): Promise<CoreDshPlugin[]> {
    return this.requiredCoreDshPlugins().update(name)
  }

  setCoreDshPluginEnabled(name: string, enabled: boolean): Promise<CoreDshPlugin[]> {
    return this.requiredCoreDshPlugins().setEnabled(name, enabled)
  }

  uninstallCoreDshPlugin(name: string): Promise<CoreDshPlugin[]> {
    return this.requiredCoreDshPlugins().uninstall(name)
  }

  closeWorkbenchRuntime(tabId: string): Promise<void> {
    return this.workbench.close(tabId)
  }

  async restartCoreDsh(): Promise<void> {
    if (!this.started) throw new Error('Core desktop runtime is not ready')
    const previous = this.coreDsh
    this.coreDsh = null
    this.coreDshPlugins = null
    await previous?.stop()
    try {
      await this.startCoreDsh()
    } catch (error) {
      this.coreDsh = null
      throw error
    }
  }

  async stop(): Promise<void> {
    this.started = false
    const coreDsh = this.coreDsh
    const executor = this.executor
    this.coreDsh = null
    this.coreDshPlugins = null
    this.executor = null
    await Promise.allSettled([this.workbench.stop(), coreDsh?.stop(), executor?.stop()])
  }

  private async startExecutor(): Promise<void> {
    const executorPath = this.options.environment.WEWORK_EXECUTOR_PATH?.trim()
    if (!executorPath) return
    const deviceId = await resolveDesktopDeviceId({
      environment: this.options.environment,
      dataDirectory: this.options.dataDirectory,
      executorHome: managedExecutorHome(this.options),
    })
    this.executor = new ManagedExecutorRuntime({
      command: executorPath,
      args: jsonArrayEnvironment(this.options.environment, 'WEWORK_EXECUTOR_ARGS_JSON'),
      environment: this.options.environment,
      dataDirectory: this.options.dataDirectory,
      logDirectory: this.options.logDirectory,
      deviceId,
      onEvent: this.options.onExecutorEvent,
    })
    await this.executor.start()
  }

  private async startCoreDsh(): Promise<void> {
    const externalDshUrl = this.options.environment.WEWORK_CORE_DSH_URL?.trim()
    const dshCommand = this.options.environment.WEWORK_CORE_DSH_COMMAND?.trim()
    const managedRoot = this.options.environment.WEWORK_HARNESS_RUNTIME_ROOT?.trim()
    const port = externalDshUrl ? null : await freePort()
    const dshUrl = externalDshUrl || `http://127.0.0.1:${port as number}`
    let command = dshCommand
    let args = jsonArrayEnvironment(this.options.environment, 'WEWORK_CORE_DSH_ARGS_JSON')
    let cwd: string | undefined
    let dshHome: string | undefined
    let runtimeEnvironment = this.options.environment
    if (!externalDshUrl && !dshCommand) {
      if (!managedRoot) {
        throw new Error(
          'WEWORK_HARNESS_RUNTIME_ROOT is required when DSH is not externally managed'
        )
      }
      const launch = await prepareCoreDshLaunch({
        runtimeRoot: managedRoot,
        dataDirectory: this.options.dataDirectory,
        environment: this.options.environment,
        port: port as number,
      })
      command = launch.command
      args = launch.args
      cwd = launch.cwd
      dshHome = launch.dshHome
      runtimeEnvironment = launch.environment
      this.coreDshPlugins = new CoreDshPluginManager({
        dshHome: launch.dshHome,
        runtimeRoot: launch.cwd,
        dshEntry: launch.args[0],
        nodeCommand: launch.command,
        environment: launch.environment,
      })
    }
    const runtime = new DshRuntime({
      name: 'dsh-core',
      url: dshUrl,
      probeUrls: [
        `${dshUrl}/wework/electron-host/v1`,
        `${dshUrl}/wework/executor/v1`,
        `${dshUrl}/wework/terminal/v1`,
        `${dshUrl}${CORE_APP_PATH}`,
      ],
      ...(command ? { command } : {}),
      args,
      ...(cwd ? { cwd } : {}),
      logDirectory: this.options.logDirectory,
      logFileName: 'dsh-core-runtime.log',
      env: {
        ...runtimeEnvironment,
        ...this.options.hostPipe.environment(),
        ...(dshHome ? { DSH_HOME: dshHome } : {}),
        ...this.executor?.environment(),
      },
      hostPipe: this.options.hostPipe,
    })
    this.coreDsh = runtime
    try {
      await runtime.start()
    } catch (error) {
      if (this.coreDsh === runtime) this.coreDsh = null
      this.coreDshPlugins = null
      await runtime.stop().catch(() => {})
      throw error
    }
  }

  private requiredCoreDshPlugins(): CoreDshPluginManager {
    if (!this.coreDshPlugins) {
      throw new Error('Core DSH plugin management requires the managed desktop runtime')
    }
    return this.coreDshPlugins
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      if (!address || typeof address === 'string') {
        server.close()
        reject(new Error('Failed to allocate a DSH port'))
        return
      }
      server.close(error => {
        if (error) reject(error)
        else resolve(address.port)
      })
    })
  })
}

function jsonArrayEnvironment(environment: NodeJS.ProcessEnv, name: string): string[] {
  const raw = environment[name]?.trim()
  if (!raw) return []
  const value = JSON.parse(raw) as unknown
  if (!Array.isArray(value) || !value.every(item => typeof item === 'string')) {
    throw new Error(`${name} must be a JSON string array`)
  }
  return value
}
