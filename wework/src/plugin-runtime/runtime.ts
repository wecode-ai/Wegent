import { Context, type Fiber, type Plugin } from '@deepseek-ai/cordis'

import { WorkbenchRouteRegistry } from './routes'
import { WorkbenchSlotRegistry } from './slots'
import { setActiveWorkbenchAppRegistry, WorkbenchAppRegistry } from './apps'
import { setActiveWorkbenchSettingsRegistry, WorkbenchSettingsRegistry } from './settings'

declare module '@deepseek-ai/cordis' {
  interface Context {
    workbenchRoutes: WorkbenchRouteRegistry
    workbenchSlots: WorkbenchSlotRegistry
    workbenchApps: WorkbenchAppRegistry
    workbenchSettings: WorkbenchSettingsRegistry
  }
}

const routeServicePlugin: Plugin.Object<void> = {
  name: 'wework-route-service',
  provide: 'workbenchRoutes',
  apply(ctx: Context) {
    ctx.provide('workbenchRoutes', new WorkbenchRouteRegistry())
  },
}

const slotServicePlugin: Plugin.Object<void> = {
  name: 'wework-slot-service',
  provide: 'workbenchSlots',
  apply(ctx: Context) {
    ctx.provide('workbenchSlots', new WorkbenchSlotRegistry())
  },
}

const appServicePlugin: Plugin.Object<void> = {
  name: 'wework-app-service',
  provide: 'workbenchApps',
  apply(ctx: Context) {
    const registry = new WorkbenchAppRegistry()
    const restore = setActiveWorkbenchAppRegistry(registry)
    ctx.provide('workbenchApps', registry)
    return restore
  },
}

const settingsServicePlugin: Plugin.Object<void> = {
  name: 'wework-settings-service',
  provide: 'workbenchSettings',
  apply(ctx: Context) {
    const registry = new WorkbenchSettingsRegistry()
    const restore = setActiveWorkbenchSettingsRegistry(registry)
    ctx.provide('workbenchSettings', registry)
    return restore
  },
}

export interface WorkbenchPluginProfile {
  id: string
  entries: readonly WorkbenchPluginProfileEntry[]
}

export interface WorkbenchPluginProfileEntry {
  id: string
  plugin: Plugin
  required: boolean
  clientVersion?: string
}

export class WorkbenchPluginRuntime {
  readonly context = new Context()
  private readonly fibers: Fiber[] = []
  private initialized = false

  get routes(): WorkbenchRouteRegistry {
    const routes = this.context.get('workbenchRoutes')
    if (!routes) {
      throw new Error('Workbench route service is not active')
    }
    return routes
  }

  get slots(): WorkbenchSlotRegistry {
    const slots = this.context.get('workbenchSlots')
    if (!slots) {
      throw new Error('Workbench slot service is not active')
    }
    return slots
  }

  get apps(): WorkbenchAppRegistry {
    const apps = this.context.get('workbenchApps')
    if (!apps) {
      throw new Error('Workbench app service is not active')
    }
    return apps
  }

  get settings(): WorkbenchSettingsRegistry {
    const settings = this.context.get('workbenchSettings')
    if (!settings) {
      throw new Error('Workbench settings service is not active')
    }
    return settings
  }

  async initialize(profile: WorkbenchPluginProfile): Promise<void> {
    if (this.initialized) {
      throw new Error('Workbench plugin runtime is already initialized')
    }
    this.initialized = true

    try {
      this.fibers.push(this.context.plugin(routeServicePlugin))
      this.fibers.push(this.context.plugin(slotServicePlugin))
      this.fibers.push(this.context.plugin(appServicePlugin))
      this.fibers.push(this.context.plugin(settingsServicePlugin))
      for (const entry of profile.entries) {
        if (entry.required && entry.clientVersion !== __WEWORK_APP_VERSION__) {
          throw new Error(
            `Required plugin '${entry.id}' is pinned to client ` +
              `${entry.clientVersion ?? 'unknown'}, current client is ${__WEWORK_APP_VERSION__}`
          )
        }
        this.fibers.push(this.context.plugin(entry.plugin))
      }
      await Promise.all(this.fibers.map(fiber => fiber.await()))
    } catch (error) {
      await this.dispose()
      throw new Error(`Failed to initialize Wework plugin profile '${profile.id}'`, {
        cause: error,
      })
    }
  }

  async install(plugin: Plugin): Promise<() => Promise<void>> {
    if (!this.initialized) {
      throw new Error('Workbench plugin runtime is not initialized')
    }
    const fiber = this.context.plugin(plugin)
    this.fibers.push(fiber)
    try {
      await fiber.await()
    } catch (error) {
      const index = this.fibers.indexOf(fiber)
      if (index >= 0) this.fibers.splice(index, 1)
      await fiber.dispose()
      throw error
    }
    return async () => {
      const index = this.fibers.indexOf(fiber)
      if (index >= 0) this.fibers.splice(index, 1)
      await fiber.dispose()
    }
  }

  async dispose(): Promise<void> {
    const fibers = this.fibers.splice(0).reverse()
    await Promise.allSettled(fibers.map(fiber => fiber.dispose()))
    this.initialized = false
  }
}
