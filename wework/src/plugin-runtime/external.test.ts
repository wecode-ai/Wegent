import { invoke } from '@tauri-apps/api/core'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

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
    frontendSource: 'export default {}',
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
  const runtimes: WorkbenchPluginRuntime[] = []

  beforeEach(() => {
    vi.mocked(invoke).mockReset()
  })

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map(runtime => runtime.dispose()))
  })

  async function createRuntime() {
    const runtime = new WorkbenchPluginRuntime()
    runtimes.push(runtime)
    await runtime.initialize({ id: 'test', entries: [] })
    return runtime
  }

  test('loads and unloads same-realm frontend contributions transactionally', async () => {
    const runtime = await createRuntime()
    const dispose = vi.fn()
    const receivedReactFactory = vi.fn()
    const importer = vi.fn(async () => ({
      default: {
        activate: ({
          apps,
          react,
          rightPanels,
          routes,
          settings,
        }: {
          apps: typeof runtime.apps
          react: { createElement: (...args: unknown[]) => unknown }
          rightPanels: typeof runtime.rightPanels
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
          const disposeRightPanel = rightPanels.register({
            key: 'external',
            label: 'External',
            icon: () => null,
            render: () => null,
          })
          return () => {
            disposeRightPanel()
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
    expect(runtime.rightPanels.resolve('external')?.label).toBe('External')
    expect(importer).toHaveBeenCalledWith(
      'export default {}',
      'asset://localhost//plugins/example/frontend.js'
    )
    expect(receivedReactFactory).toHaveBeenCalledWith(expect.any(Function))

    await loader.unload('example')
    expect(runtime.routes.resolve('/external')).toBeNull()
    expect(runtime.apps.resolve('external')).toBeNull()
    expect(runtime.settings.resolve('external')).toBeNull()
    expect(runtime.rightPanels.resolve('external')).toBeNull()
    expect(dispose).toHaveBeenCalledOnce()
  })

  test('rejects a frontend plugin pinned to a different client version', async () => {
    const runtime = await createRuntime()
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

  test('starts and stops desktop-only plugins', async () => {
    const runtime = await createRuntime()
    const loader = new ExternalWorkbenchPluginLoader(runtime, vi.fn())
    const plugin = inspectedPlugin()
    plugin.frontendPath = null
    plugin.frontendSource = null
    plugin.manifest.frontend = null
    plugin.desktopPath = '/plugins/example/sidecar'
    plugin.manifest.desktop = {
      command: 'sidecar',
      args: [],
      sha256: '0'.repeat(64),
      capabilities: ['example.ping'],
    }
    vi.mocked(invoke).mockResolvedValue(undefined)

    await loader.load(plugin)
    expect(invoke).toHaveBeenCalledWith('workbench_plugin_start', {
      pluginId: 'example',
      pluginRoot: '/plugins/example',
    })

    await loader.unload('example')
    expect(invoke).toHaveBeenLastCalledWith('workbench_plugin_stop', {
      pluginId: 'example',
    })
  })

  test('attempts every plugin and reports aggregate load failures', async () => {
    const runtime = await createRuntime()
    const importer = vi.fn(async (_source: string, sourcePath: string) => {
      if (sourcePath.includes('/broken/')) throw new Error('broken module')
      return { default: { activate: () => undefined } }
    })
    const loader = new ExternalWorkbenchPluginLoader(runtime, importer)
    const broken = inspectedPlugin()
    broken.root = '/plugins/broken'
    broken.frontendPath = '/plugins/broken/frontend.js'
    broken.manifest.name = 'broken'
    const working = inspectedPlugin()
    working.root = '/plugins/working'
    working.frontendPath = '/plugins/working/frontend.js'
    working.manifest.name = 'working'

    await expect(loader.reconcile([broken, working])).rejects.toThrow(
      'Failed to load 1 Wework plugin'
    )
    expect(importer).toHaveBeenCalledTimes(2)

    await loader.unload('working')
  })
})
