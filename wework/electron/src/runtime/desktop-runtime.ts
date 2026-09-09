import { createServer } from 'node:net'
import { resolve } from 'node:path'
import type { HostPipeServer } from '../host/host-pipe.js'
import { prepareCoreDshLaunch } from './core-dsh-runtime.js'
import { resolveDesktopDeviceId } from './desktop-device-id.js'
import { resolveDesktopDeviceName } from './desktop-device-name.js'
import {
  CoreDshPluginManager,
  type CoreDshDevelopmentPlugin,
  type CoreDshPlugin,
} from './core-dsh-plugin-manager.js'
import { DshRuntime, type DshRuntimeOptions } from './dsh-runtime.js'
import { ManagedExecutorRuntime, managedExecutorHome } from './managed-executor-runtime.js'
import {
  WorkbenchRuntimeManager,
  type WorkbenchRuntimeLaunch,
  type WorkbenchRuntimeSnapshot,
} from './workbench-runtime.js'
import { applyWorkbenchModeToCorePlugins, type WorkbenchMode } from './workbench-mode.js'

const CORE_APP_PATH = '/'
const CORE_DSH_START_TIMEOUT_MS = 120_000

export interface DesktopRuntimeOptions {
  environment: NodeJS.ProcessEnv
  dataDirectory: string
  logDirectory: string
  hostPipe: HostPipeServer
  readWorkbenchMode?: () => Promise<WorkbenchMode>
  createWorkbenchHostPipe?: (tabId: string) => {
    hostPipe: HostPipeServer
    principal: string
  }
  onExecutorEvent?: (event: string, payload: Record<string, unknown>) => void
  createCoreDsh?: (options: DshRuntimeOptions) => CoreDshHandle
}

export interface CoreDshHandle {
  start(timeoutMs?: number): Promise<void>
  stop(): Promise<void>
  url(): string
  pid(): number | null
}

export interface DesktopRuntimeState {
  coreDshUrl: string | null
  executorConfigured: boolean
  workbenchRuntimeCount: number
  ready: boolean
}

export interface DesktopRuntimeDiagnostics {
  coreDshPid: number | null
  developmentPlugin: CoreDshDevelopmentPlugin | null
  executorPid: number | null
  workbenchRuntimes: WorkbenchRuntimeSnapshot[]
}

export class DesktopRuntime {
  private executor: ManagedExecutorRuntime | null = null
  private coreDsh: CoreDshHandle | null = null
  private coreDshPlugins: CoreDshPluginManager | null = null
  private coreDshPort: number | null = null
  private developmentPlugin: CoreDshDevelopmentPlugin | null = null
  private readonly workbench = new WorkbenchRuntimeManager()
  private started = false
  private lifecycleGeneration = 0
  private startOperation: { generation: number; promise: Promise<void> } | null = null
  private restartOperation: { generation: number; promise: Promise<void> } | null = null

  constructor(private readonly options: DesktopRuntimeOptions) {}

  start(): Promise<void> {
    if (this.started) return Promise.resolve()
    const generation = this.lifecycleGeneration
    const current = this.startOperation
    if (current?.generation === generation) return current.promise
    const promise = this.performStart(generation).finally(() => {
      if (this.startOperation?.promise === promise) this.startOperation = null
    })
    this.startOperation = { generation, promise }
    return promise
  }

  private async performStart(generation: number): Promise<void> {
    try {
      await this.startExecutor()
      if (this.lifecycleGeneration !== generation) return
      await this.startCoreDsh()
      if (this.lifecycleGeneration !== generation) return
      this.started = true
    } catch (error) {
      if (this.lifecycleGeneration === generation) await this.stop()
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
      developmentPlugin: this.developmentPlugin,
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
    const existing = this.workbench.get(launch.tabId)
    if (existing) return Promise.resolve(existing)
    return this.workbench.open(this.enrichWorkbenchLaunch(launch))
  }

  private enrichWorkbenchLaunch(launch: WorkbenchRuntimeLaunch): WorkbenchRuntimeLaunch {
    if (launch.hostPipe) return launch
    const host = this.options.createWorkbenchHostPipe?.(launch.tabId)
    if (!host) return launch
    return {
      ...launch,
      hostPipe: host.hostPipe,
      hostPrincipal: host.principal,
    }
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

  restartCoreDsh(): Promise<void> {
    if (!this.started) throw new Error('Core desktop runtime is not ready')
    const generation = this.lifecycleGeneration
    const current = this.restartOperation
    if (current?.generation === generation) return current.promise
    const promise = this.performRestartCoreDsh().finally(() => {
      // Clear only this operation's registration: a stale generation's
      // settled flight must never drop a newer generation's authority.
      if (this.restartOperation?.promise === promise) this.restartOperation = null
    })
    this.restartOperation = { generation, promise }
    return promise
  }

  private async performRestartCoreDsh(): Promise<void> {
    const generation = this.lifecycleGeneration
    const previous = this.coreDsh
    this.coreDsh = null
    this.coreDshPlugins = null
    await previous?.stop()
    if (this.lifecycleGeneration !== generation) return
    try {
      await this.startCoreDsh()
    } catch (error) {
      if (this.lifecycleGeneration === generation) this.coreDsh = null
      throw error
    }
  }

  async stop(): Promise<void> {
    this.lifecycleGeneration += 1
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
    const generation = this.lifecycleGeneration
    const deviceId = await resolveDesktopDeviceId({
      environment: this.options.environment,
      dataDirectory: this.options.dataDirectory,
      executorHome: managedExecutorHome(this.options),
    })
    if (this.lifecycleGeneration !== generation) return
    const deviceName = await resolveDesktopDeviceName({
      environment: this.options.environment,
    })
    if (this.lifecycleGeneration !== generation) return
    const executor = new ManagedExecutorRuntime({
      command: executorPath,
      args: jsonArrayEnvironment(this.options.environment, 'WEWORK_EXECUTOR_ARGS_JSON'),
      environment: this.options.environment,
      dataDirectory: this.options.dataDirectory,
      logDirectory: this.options.logDirectory,
      deviceId,
      deviceName,
      onEvent: this.options.onExecutorEvent,
    })
    this.executor = executor
    try {
      await executor.start()
      if (this.lifecycleGeneration !== generation) {
        await executor.stop().catch(() => {})
        if (this.executor === executor) this.executor = null
        return
      }
    } catch (error) {
      if (this.executor === executor) this.executor = null
      throw error
    }
  }

  private async startCoreDsh(): Promise<void> {
    const generation = this.lifecycleGeneration
    const externalDshUrl = this.options.environment.WEWORK_CORE_DSH_URL?.trim()
    const dshCommand = this.options.environment.WEWORK_CORE_DSH_COMMAND?.trim()
    const managedRoot = this.options.environment.WEWORK_HARNESS_RUNTIME_ROOT?.trim()
    const port = externalDshUrl ? null : await freePort(this.coreDshPort)
    if (this.lifecycleGeneration !== generation) return
    const dshUrl = externalDshUrl || `http://127.0.0.1:${port as number}`
    let command = dshCommand
    let args = jsonArrayEnvironment(this.options.environment, 'WEWORK_CORE_DSH_ARGS_JSON')
    let cwd: string | undefined
    let dshHome: string | undefined
    let runtimeEnvironment = this.options.environment
    let plugins: CoreDshPluginManager | null = null
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
      if (this.lifecycleGeneration !== generation) return
      command = launch.command
      args = launch.args
      cwd = launch.cwd
      dshHome = launch.dshHome
      runtimeEnvironment = launch.environment
      plugins = new CoreDshPluginManager({
        dshHome: launch.dshHome,
        runtimeRoot: launch.cwd,
        dshEntry: launch.entry,
        nodeCommand: launch.command,
        environment: launch.environment,
      })
      if (this.options.readWorkbenchMode) {
        await applyWorkbenchModeToCorePlugins(await this.options.readWorkbenchMode(), plugins)
        if (this.lifecycleGeneration !== generation) return
      }
      const developmentRoot = this.options.environment.WEWORK_PLUGIN_DEVELOPMENT_ROOT?.trim()
      if (developmentRoot && this.developmentPlugin?.sourceRoot !== resolve(developmentRoot)) {
        const developmentPlugin = await plugins.ensureDevelopmentPlugin(developmentRoot)
        if (this.lifecycleGeneration !== generation) return
        this.developmentPlugin = developmentPlugin
      }
    }
    const runtime = this.createCoreDsh({
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
      startTimeoutMs: CORE_DSH_START_TIMEOUT_MS,
      env: {
        ...runtimeEnvironment,
        ...this.options.hostPipe.environment(),
        ...(dshHome ? { DSH_HOME: dshHome } : {}),
        ...this.executor?.environment(),
      },
      hostPipe: this.options.hostPipe,
    })
    if (this.lifecycleGeneration !== generation) return
    this.coreDsh = runtime
    if (plugins) this.coreDshPlugins = plugins
    try {
      await runtime.start()
      if (this.lifecycleGeneration !== generation) {
        await runtime.stop().catch(() => {})
        if (this.coreDsh === runtime) this.coreDsh = null
        if (this.coreDshPlugins === plugins) this.coreDshPlugins = null
        return
      }
      this.coreDshPort = port
    } catch (error) {
      if (this.coreDsh === runtime) this.coreDsh = null
      if (this.coreDshPlugins === plugins) this.coreDshPlugins = null
      await runtime.stop().catch(() => {})
      throw error
    }
  }

  private createCoreDsh(options: DshRuntimeOptions): CoreDshHandle {
    return this.options.createCoreDsh
      ? this.options.createCoreDsh(options)
      : new DshRuntime(options)
  }

  private requiredCoreDshPlugins(): CoreDshPluginManager {
    if (!this.coreDshPlugins) {
      throw new Error('Core DSH plugin management requires the managed desktop runtime')
    }
    return this.coreDshPlugins
  }
}

function freePort(excludedPort: number | null = null): Promise<number> {
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
        if (error) {
          reject(error)
        } else if (address.port === excludedPort) {
          void freePort(excludedPort).then(resolve, reject)
        } else {
          resolve(address.port)
        }
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
