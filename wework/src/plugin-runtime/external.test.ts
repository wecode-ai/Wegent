import { describe, expect, test, vi } from 'vitest'

import { WorkbenchPluginRuntime } from './runtime'
import { ExternalWorkbenchPluginLoader, type InspectedWorkbenchPlugin } from './external'

vi.mock('@tauri-apps/api/core', () => ({
  convertFileSrc: (path: string) => `asset://localhost/${path}`,
  invoke: vi.fn(),
  isTauri: () => true,
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
  test('loads and unloads same-realm frontend contributions transactionally', async () => {
    const runtime = new WorkbenchPluginRuntime()
    await runtime.initialize({ id: 'test', entries: [] })
    const dispose = vi.fn()
    const receivedReactFactory = vi.fn()
    const importer = vi.fn(async () => ({
      default: {
        activate: ({
          apps,
          react,
          routes,
          settings,
        }: {
          apps: typeof runtime.apps
          react: { createElement: (...args: unknown[]) => unknown }
          routes: typeof runtime.routes
          settings: typeof runtime.settings
        }) => {
          receivedReactFactory(react.createElement)
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
    expect(importer).toHaveBeenCalledWith('asset://localhost//plugins/example/frontend.js')
    expect(receivedReactFactory).toHaveBeenCalledWith(expect.any(Function))

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
})
