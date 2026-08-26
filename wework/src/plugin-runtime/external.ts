import type { Plugin } from '@deepseek-ai/cordis'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'
import { normalizeBrowserUrl } from '@/lib/browser-url'

import type { WorkbenchRouteRegistry } from './routes'
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
  desktopPath?: string | null
}

export interface WorkbenchDesktopClient {
  authorize(capability: string): Promise<boolean>
  request<T = unknown>(capability: string, method: string, params?: unknown): Promise<T>
  start(): Promise<void>
  stop(): Promise<void>
}

export interface WorkbenchPluginApi {
  id: string
  manifest: WorkbenchPluginManifest
  routes: WorkbenchRouteRegistry
  slots: WorkbenchSlotRegistry
  settings: WorkbenchSettingsRegistry
  apps: WorkbenchAppRegistry
  desktop: WorkbenchDesktopClient | null
}

export interface WorkbenchFrontendPluginModule {
  activate(api: WorkbenchPluginApi): void | (() => void) | Promise<void | (() => void)>
}

type ModuleImporter = (url: string) => Promise<Record<string, unknown>>

function createDesktopClient(plugin: InspectedWorkbenchPlugin): WorkbenchDesktopClient | null {
  if (!plugin.manifest.desktop) return null
  return {
    authorize(capability) {
      return invokeDesktopHost<boolean>('plugins.authorizeCapability', {
        pluginRoot: plugin.root,
        capability,
      })
    },
    request<T>(capability: string, method: string, params: unknown = {}): Promise<T> {
      return invokeDesktopHost<T>('plugins.request', {
        pluginId: plugin.manifest.name,
        capability,
        method,
        params,
      })
    },
    start() {
      return invokeDesktopHost<void>('plugins.start', {
        pluginId: plugin.manifest.name,
        pluginRoot: plugin.root,
      })
    },
    stop() {
      return invokeDesktopHost<void>('plugins.stop', {
        pluginId: plugin.manifest.name,
      })
    },
  }
}

async function defaultModuleImporter(url: string): Promise<Record<string, unknown>> {
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
  private readonly runtime: WorkbenchPluginRuntime
  private readonly importer: ModuleImporter

  constructor(runtime: WorkbenchPluginRuntime, importer: ModuleImporter = defaultModuleImporter) {
    this.runtime = runtime
    this.importer = importer
  }

  async load(plugin: InspectedWorkbenchPlugin): Promise<void> {
    const id = plugin.manifest.name
    if (this.loaded.has(id)) return
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
    const module =
      plugin.frontendPath && plugin.manifest.frontend
        ? resolveFrontendModule(
            await this.importer(
              normalizeBrowserUrl(plugin.frontendPath) ??
                (() => {
                  throw new Error(`Invalid plugin frontend path: ${plugin.frontendPath}`)
                })()
            ),
            plugin.manifest.frontend.export?.trim() || 'default'
          )
        : null
    if (!module && !desktop) return
    const cordisPlugin: Plugin.Object<void> = {
      name: `external:${id}`,
      inject: ['workbenchRoutes', 'workbenchSlots', 'workbenchSettings', 'workbenchApps'],
      async apply(ctx) {
        await desktop?.start()
        let dispose: void | (() => void)
        try {
          dispose = module
            ? await module.activate({
                id,
                manifest: plugin.manifest,
                routes: ctx.workbenchRoutes,
                slots: ctx.workbenchSlots,
                settings: ctx.workbenchSettings,
                apps: ctx.workbenchApps,
                desktop,
              })
            : undefined
        } catch (error) {
          await desktop?.stop()
          throw error
        }
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
    for (const plugin of plugins) {
      try {
        await this.load(plugin)
      } catch (error) {
        console.error(`[Wework] Failed to load plugin '${plugin.manifest.name}':`, error)
      }
    }
  }

  async dispose(): Promise<void> {
    await Promise.all(Array.from(this.loaded.keys()).map(id => this.unload(id)))
  }
}

export async function listDeviceWorkbenchPlugins(): Promise<InspectedWorkbenchPlugin[]> {
  return invokeDesktopHost<InspectedWorkbenchPlugin[]>('plugins.list')
}
