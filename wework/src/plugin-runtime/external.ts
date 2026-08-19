import { convertFileSrc, invoke, isTauri } from '@tauri-apps/api/core'
import type { Plugin } from '@deepseek-ai/cordis'
import { createElement } from 'react'

import type { WorkbenchRouteRegistry } from './routes'
import type { WorkbenchRightPanelRegistry } from './right-panels'
import type { WorkbenchSlotRegistry } from './slots'
import type { WorkbenchSettingsRegistry } from './settings'
import type { WorkbenchAppRegistry } from './apps'
import type { WorkbenchPluginRuntime } from './runtime'

export interface WorkbenchPluginManifest {
  name: string
  version?: string | null
  apiVersion: '1'
  required: boolean
  pinnedToClientVersion: boolean
  clientVersion?: string | null
  frontend?: {
    entry: string
    export?: string | null
    sha256: string
  } | null
  desktop?: {
    command: string
    args: string[]
    sha256: string
    capabilities: string[]
  } | null
}

export interface InspectedWorkbenchPlugin {
  root: string
  manifest: WorkbenchPluginManifest
  frontendPath?: string | null
  frontendSource?: string | null
  desktopPath?: string | null
}

export interface WorkbenchDesktopClient {
  authorize(capability: string): Promise<boolean>
  request<T = unknown>(method: string, params?: unknown): Promise<T>
  start(): Promise<void>
  stop(): Promise<void>
}

export interface WorkbenchPluginApi {
  id: string
  manifest: WorkbenchPluginManifest
  react: {
    createElement: typeof createElement
  }
  routes: WorkbenchRouteRegistry
  slots: WorkbenchSlotRegistry
  settings: WorkbenchSettingsRegistry
  apps: WorkbenchAppRegistry
  rightPanels: WorkbenchRightPanelRegistry
  desktop: WorkbenchDesktopClient | null
}

export interface WorkbenchFrontendPluginModule {
  activate(api: WorkbenchPluginApi): void | (() => void) | Promise<void | (() => void)>
}

type ModuleImporter = (source: string, sourcePath: string) => Promise<Record<string, unknown>>

function createDesktopClient(plugin: InspectedWorkbenchPlugin): WorkbenchDesktopClient | null {
  if (!plugin.manifest.desktop) return null
  return {
    authorize(capability) {
      return invoke<boolean>('workbench_plugin_authorize_capability', {
        pluginRoot: plugin.root,
        capability,
      })
    },
    request<T>(method: string, params: unknown = {}): Promise<T> {
      return invoke<T>('workbench_plugin_request', {
        pluginId: plugin.manifest.name,
        method,
        params,
      })
    },
    start() {
      return invoke<void>('workbench_plugin_start', {
        pluginId: plugin.manifest.name,
        pluginRoot: plugin.root,
      })
    },
    stop() {
      return invoke<void>('workbench_plugin_stop', {
        pluginId: plugin.manifest.name,
      })
    },
  }
}

async function defaultModuleImporter(source: string): Promise<Record<string, unknown>> {
  const url = `data:text/javascript;charset=utf-8,${encodeURIComponent(source)}`
  return import(/* @vite-ignore */ url) as Promise<Record<string, unknown>>
}

function resolveFrontendModule(
  namespace: Record<string, unknown>,
  exportName: string
): WorkbenchFrontendPluginModule {
  const candidate = namespace[exportName]
  if (
    !candidate ||
    typeof candidate !== 'object' ||
    typeof (candidate as { activate?: unknown }).activate !== 'function'
  ) {
    throw new Error(`Wework plugin export '${exportName}' must provide activate(api)`)
  }
  return candidate as WorkbenchFrontendPluginModule
}

export class ExternalWorkbenchPluginLoader {
  private readonly loaded = new Map<string, () => Promise<void>>()
  private readonly loading = new Map<string, Promise<void>>()
  private readonly runtime: WorkbenchPluginRuntime
  private readonly importer: ModuleImporter

  constructor(runtime: WorkbenchPluginRuntime, importer: ModuleImporter = defaultModuleImporter) {
    this.runtime = runtime
    this.importer = importer
  }

  async load(plugin: InspectedWorkbenchPlugin): Promise<void> {
    const id = plugin.manifest.name
    if (this.loaded.has(id)) return
    const pending = this.loading.get(id)
    if (pending) return pending
    const loading = this.loadPlugin(plugin).finally(() => {
      if (this.loading.get(id) === loading) this.loading.delete(id)
    })
    this.loading.set(id, loading)
    return loading
  }

  private async loadPlugin(plugin: InspectedWorkbenchPlugin): Promise<void> {
    const id = plugin.manifest.name
    if (plugin.manifest.apiVersion !== '1') {
      throw new Error(`Unsupported Wework plugin apiVersion '${plugin.manifest.apiVersion}'`)
    }
    if (
      plugin.manifest.pinnedToClientVersion &&
      plugin.manifest.clientVersion !== __WEWORK_APP_VERSION__
    ) {
      throw new Error(
        `Wework plugin '${id}' requires client ${plugin.manifest.clientVersion ?? 'unknown'}, ` +
          `current client is ${__WEWORK_APP_VERSION__}`
      )
    }
    const desktop = createDesktopClient(plugin)
    if (!plugin.frontendPath || !plugin.manifest.frontend) {
      if (!desktop) {
        throw new Error(`Wework plugin '${id}' does not declare a loadable component`)
      }
      await desktop.start()
      this.loaded.set(id, async () => desktop.stop())
      return
    }
    if (plugin.frontendSource == null) {
      throw new Error(`Wework plugin '${id}' frontend source was not verified by the host`)
    }

    const namespace = await this.importer(
      plugin.frontendSource,
      convertFileSrc(plugin.frontendPath)
    )
    const module = resolveFrontendModule(
      namespace,
      plugin.manifest.frontend.export?.trim() || 'default'
    )
    const cordisPlugin: Plugin.Object<void> = {
      name: `external:${id}`,
      inject: [
        'workbenchRoutes',
        'workbenchSlots',
        'workbenchSettings',
        'workbenchApps',
        'workbenchRightPanels',
      ],
      async apply(ctx) {
        const dispose = await module.activate({
          id,
          manifest: plugin.manifest,
          react: { createElement },
          routes: ctx.workbenchRoutes,
          slots: ctx.workbenchSlots,
          settings: ctx.workbenchSettings,
          apps: ctx.workbenchApps,
          rightPanels: ctx.workbenchRightPanels,
          desktop,
        })
        return async () => {
          dispose?.()
          await desktop?.stop()
        }
      },
    }
    this.loaded.set(id, await this.runtime.install(cordisPlugin))
  }

  async unload(id: string): Promise<void> {
    const dispose = this.loaded.get(id)
    if (!dispose) return
    this.loaded.delete(id)
    await dispose()
  }

  async reconcile(plugins: readonly InspectedWorkbenchPlugin[]): Promise<void> {
    const desired = new Set(plugins.map(plugin => plugin.manifest.name))
    await Promise.all(
      Array.from(this.loaded.keys())
        .filter(id => !desired.has(id))
        .map(id => this.unload(id))
    )
    const results = await Promise.allSettled(plugins.map(plugin => this.load(plugin)))
    const failures = results.flatMap((result, index) =>
      result.status === 'rejected'
        ? [`${plugins[index].manifest.name}: ${String(result.reason)}`]
        : []
    )
    if (failures.length > 0) {
      throw new AggregateError(failures, `Failed to load ${failures.length} Wework plugin(s)`)
    }
  }

  async dispose(): Promise<void> {
    await Promise.allSettled(this.loading.values())
    await Promise.all(Array.from(this.loaded.keys()).map(id => this.unload(id)))
  }
}

export async function listDeviceWorkbenchPlugins(): Promise<InspectedWorkbenchPlugin[]> {
  if (!isTauri()) return []
  return invoke<InspectedWorkbenchPlugin[]>('workbench_plugin_list')
}
