import { describe, expect, test, vi } from 'vitest'

import { WorkbenchPluginRuntime } from './runtime'
import { ExternalWorkbenchPluginLoader, type InspectedWorkbenchPlugin } from './external'

const desktopInvoke = vi.hoisted(() => vi.fn())

vi.mock('@/api/dsh/desktopHost', () => ({
  invokeDesktopHost: desktopInvoke,
}))

function inspectedPlugin(): InspectedWorkbenchPlugin {
  return {
    root: '/plugins/example',
    frontendPath: '/plugins/example/frontend.js',
    desktopPath: null,
    manifest: {
      name: 'example',
      apiVersion: '1',
      required: false,
      pinnedToClientVersion: false,
      frontend: {
        entry: 'frontend.js',
        export: 'default',
        sha256: '0'.repeat(64),
      },
      desktop: null,
    },
  }
}

describe('ExternalWorkbenchPluginLoader', () => {
  test('runs and stops a desktop-only plugin without importing a frontend module', async () => {
    const runtime = new WorkbenchPluginRuntime()
    await runtime.initialize({ id: 'test', entries: [] })
    const importer = vi.fn()
    const loader = new ExternalWorkbenchPluginLoader(runtime, importer)
    const plugin = inspectedPlugin()
    plugin.frontendPath = null
    plugin.manifest.frontend = null
    plugin.desktopPath = '/plugins/example/sidecar'
    plugin.manifest.desktop = {
      command: 'sidecar',
      args: [],
      sha256: '1'.repeat(64),
      capabilities: ['workspace.read'],
    }

    await loader.load(plugin)
    expect(importer).not.toHaveBeenCalled()
    expect(desktopInvoke).toHaveBeenCalledWith('plugins.start', {
      pluginId: 'example',
      pluginRoot: '/plugins/example',
    })

    await loader.unload('example')
    expect(desktopInvoke).toHaveBeenCalledWith('plugins.stop', {
      pluginId: 'example',
    })
  })

  test('loads and unloads same-realm frontend contributions transactionally', async () => {
    const runtime = new WorkbenchPluginRuntime()
    await runtime.initialize({ id: 'test', entries: [] })
    const dispose = vi.fn()
    const importer = vi.fn(async () => ({
      default: {
        activate: ({
          apps,
          routes,
          settings,
        }: {
          apps: typeof runtime.apps
          routes: typeof runtime.routes
          settings: typeof runtime.settings
        }) => {
          const disposeRoute = routes.register({
            id: 'external.route',
            path: '/external',
            telemetryFeature: 'test',
            render: () => null,
          })
          const disposeApp = apps.register({
            key: 'external',
            mode: 'native',
            path: '/external',
            labelKey: 'external.label',
            label: 'External',
            descriptionKey: 'external.description',
            description: 'External application',
          })
          const disposeSettings = settings.register({
            key: 'external',
            path: '/settings/external',
            icon: () => null,
            labelKey: 'external.settings',
            label: 'External',
            category: 'plugins',
            categoryLabelKey: 'external.category',
            categoryLabel: 'Plugins',
            render: () => null,
          })
          return () => {
            disposeSettings()
            disposeApp()
            disposeRoute()
            dispose()
          }
        },
      },
    }))
    const loader = new ExternalWorkbenchPluginLoader(runtime, importer)

    await loader.load(inspectedPlugin())
    expect(runtime.routes.resolve('/external')?.id).toBe('external.route')
    expect(runtime.apps.resolve('external')?.path).toBe('/external')
    expect(runtime.settings.resolve('external')?.path).toBe('/settings/external')
    expect(importer).toHaveBeenCalledWith('file:///plugins/example/frontend.js')

    await loader.unload('example')
    expect(runtime.routes.resolve('/external')).toBeNull()
    expect(runtime.apps.resolve('external')).toBeNull()
    expect(runtime.settings.resolve('external')).toBeNull()
    expect(dispose).toHaveBeenCalledOnce()
  })

  test('rejects a frontend plugin pinned to a different client version', async () => {
    const runtime = new WorkbenchPluginRuntime()
    await runtime.initialize({ id: 'test', entries: [] })
    const importer = vi.fn()
    const loader = new ExternalWorkbenchPluginLoader(runtime, importer)
    const plugin = inspectedPlugin()
    plugin.manifest.pinnedToClientVersion = true
    plugin.manifest.clientVersion = '0.0.0-invalid'

    await expect(loader.load(plugin)).rejects.toThrow(
      `Wework plugin 'example' requires client 0.0.0-invalid`
    )
    expect(importer).not.toHaveBeenCalled()
  })

  test('continues reconciling after one plugin fails to load', async () => {
    const runtime = new WorkbenchPluginRuntime()
    await runtime.initialize({ id: 'test', entries: [] })
    const importer = vi.fn(async (url: string) => {
      if (url.includes('/broken/')) throw new Error('broken module')
      return { default: { activate: vi.fn() } }
    })
    const loader = new ExternalWorkbenchPluginLoader(runtime, importer)
    const broken = inspectedPlugin()
    broken.root = '/plugins/broken'
    broken.frontendPath = '/plugins/broken/frontend.js'
    broken.manifest.name = 'broken'
    const healthy = inspectedPlugin()
    healthy.root = '/plugins/healthy'
    healthy.frontendPath = '/plugins/healthy/frontend.js'
    healthy.manifest.name = 'healthy'

    await loader.reconcile([broken, healthy])

    expect(importer).toHaveBeenCalledTimes(2)
    await loader.unload('healthy')
  })
})
