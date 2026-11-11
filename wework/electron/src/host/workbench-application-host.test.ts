import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { globalShortcut, type BrowserWindow, type WebContents } from 'electron'
import type { SmartAppInstallation, SmartAppManager } from './smart-app-manager.js'
import type { WorkbenchSurface } from './workbench-window.js'
import type { WorkbenchRoutes } from './workbench-routes.js'
import { WorkbenchDesktopShortcuts } from './workbench-shortcuts.js'

vi.mock('electron', () => ({
  app: { getLocale: () => 'en' },
  globalShortcut: { register: vi.fn(() => true), unregister: vi.fn() },
  BrowserWindow: class {},
  WebContentsView: class {},
  ipcMain: {},
  session: {},
  net: { fetch: globalThis.fetch },
  clipboard: {},
  dialog: {},
  shell: {},
  Notification: class {},
}))
import {
  WorkbenchApplicationHost,
  type WorkbenchApplicationHostOptions,
} from './workbench-application-host.js'

const roots: string[] = []
const hosts: WorkbenchApplicationHost[] = []
afterEach(async () => {
  await Promise.all(hosts.splice(0).map(host => host.dispose()))
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
  vi.restoreAllMocks()
  vi.mocked(globalShortcut.register).mockReset().mockReturnValue(true)
  vi.mocked(globalShortcut.unregister).mockReset()
})

function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(finish => {
    resolve = finish
  })
  return { promise, resolve }
}

async function fixture(ensureServices = async () => {}) {
  const root = await mkdtemp(join(tmpdir(), 'workbench-host-'))
  roots.push(root)
  let item: SmartAppInstallation = {
    id: 'notes',
    manifest: {
      name: 'notes',
      displayName: 'Notes',
      description: '',
      version: '1.0.0',
      type: 'deepseek-harness-plugin-bundle',
      entry: { installPackage: 'bundle', profile: 'web' },
      requirements: { dsh: '0.2.0-rc.2', node: '>=22' },
    },
    packagePath: '/source',
    sha256: 'hash',
    modelKey: null,
    resident: false,
    background: true,
    presentation: 'window',
    source: 'managed',
    state: 'installed',
    runtimeVersion: null,
    webUrl: null,
    error: null,
    grantedCapabilities: { decisionModel: false, native: [] },
  }
  const manager = {
    list: vi.fn(async () => [{ ...item }]),
    get: vi.fn(async () => ({ ...item })),
    update: vi.fn(async (_id: string, patch: object) => {
      item = { ...item, ...patch }
      return { ...item }
    }),
    start: vi.fn(async () => {
      item = { ...item, state: 'running', webUrl: 'http://127.0.0.1:1234/' }
      return { ...item }
    }),
    stop: vi.fn(async () => {
      item = { ...item, state: 'installed', webUrl: null }
    }),
    delete: vi.fn(async () => {}),
    preview: vi.fn(async () => ({ valid: true, manifest: item.manifest, sha256: 'hash' })),
    install: vi.fn(async () => ({ ...item })),
    installDirectory: vi.fn(
      async (
        _path: string,
        _native: string[],
        _previous: string | null,
        shortcut?: string | null
      ) => {
        item = { ...item, shortcut }
        return { ...item }
      }
    ),
    grantNativeCapabilities: vi.fn(async () => {
      item = { ...item, authorized: true }
    }),
  }
  const routes = {
    acquire: vi.fn(async () => ({})),
    release: vi.fn(async () => {}),
    dispose: vi.fn(async () => {}),
    invalidate: vi.fn(),
  }
  let onClose = () => {}
  let visible = false
  let nativeWindow: BrowserWindow | null = null
  const contents = {} as WebContents
  const parent = {
    isDestroyed: () => false,
    webContents: { getZoomFactor: () => 1 },
  } as unknown as BrowserWindow
  const surface: WorkbenchSurface = {
    contents,
    ready: Promise.resolve(),
    window: () => nativeWindow,
    showWindow: vi.fn(() => {
      nativeWindow = {
        isDestroyed: () => false,
        setAlwaysOnTop: vi.fn(),
      } as unknown as BrowserWindow
      visible = true
    }),
    showTab: vi.fn(() => {
      visible = true
    }),
    hide: vi.fn(() => {
      visible = false
    }),
    visible: () => visible,
    focused: () => false,
    dispose: vi.fn(() => {
      visible = false
      nativeWindow = null
    }),
  }
  const createSurface = vi.fn((_item: SmartAppInstallation, close: () => void) => {
    onClose = close
    return surface
  })
  const showTab = vi.fn<WorkbenchApplicationHostOptions['showTab']>(async () => {})
  const confirmInstall = vi.fn(async () => true)
  const host = new WorkbenchApplicationHost({
    manager: manager as unknown as SmartAppManager,
    routes: routes as unknown as WorkbenchRoutes,
    dataDirectory: root,
    desktopDirectory: join(root, 'Desktop'),
    desktopShortcutLaunch: {
      command: '/Wework',
      args: [],
      environment: { WEWORK_USER_DATA_DIR: root },
    },
    installationPreloadPath: '/preload',
    parent: () => parent,
    ensureServices,
    showTab,
    hideTab: async () => {},
    createTodoProject: async () => '/todo',
    createSurface,
    confirmInstall,
  })
  hosts.push(host)
  return {
    host,
    root,
    manager,
    routes,
    surface,
    createSurface,
    showTab,
    parent,
    contents,
    confirmInstall,
    close: () => onClose(),
  }
}

describe('unified workbench Host lifecycle', () => {
  async function legacyFixture() {
    const context = await fixture()
    const path = join(context.root, 'legacy')
    const manifest = {
      id: 'notes',
      name: 'Notes',
      description: '',
      entry: 'index.html',
      capabilities: [],
      window: { width: 380, height: 520, alwaysOnTop: false },
    }
    await mkdir(path)
    await writeFile(join(path, 'light-app.json'), JSON.stringify(manifest))
    await writeFile(join(path, 'index.html'), '<html><body>Legacy notes</body></html>')
    await mkdir(join(context.root, 'light-apps', 'data'), { recursive: true })
    await writeFile(
      join(context.root, 'light-apps', 'registry.json'),
      JSON.stringify([
        {
          manifest,
          packagePath: path,
          installedAt: new Date().toISOString(),
          shortcut: 'Control+Alt+N',
        },
      ])
    )
    await writeFile(
      join(context.root, 'light-apps', 'data', 'notes.json'),
      JSON.stringify({ state: { legacy: true }, reminders: [] })
    )
    return { ...context, path }
  }
  test('legacy data conflict fails before consent or replacing the installation', async () => {
    const { host, manager, confirmInstall, path } = await legacyFixture()
    await host.native.data.commit('notes', { newer: true })
    await expect(host.install(path)).rejects.toThrow('already exists')
    expect(confirmInstall).not.toHaveBeenCalled()
    expect(manager.installDirectory).not.toHaveBeenCalled()
    expect((await host.native.data.read('notes')).state).toEqual({ newer: true })
  })
  test('explicit legacy import preserves its data and global shortcut in the DSH installation', async () => {
    const { host, manager, path } = await legacyFixture()
    const result = await host.install(path)
    expect(result?.shortcut).toBe('Alt+Control+N')
    expect(manager.installDirectory).toHaveBeenCalledWith(
      expect.any(String),
      [],
      'hash',
      'Alt+Control+N'
    )
    expect((await host.native.data.read('notes')).state).toEqual({ legacy: true })
  })
  test('rejects replacement of a running installation before requesting consent', async () => {
    const { host, manager, confirmInstall } = await fixture()
    await host.open('notes')
    await expect(
      host.installArchive({ archivePath: '/app.zip', expectedSha256: 'hash' })
    ).rejects.toThrow('Stop the workbench')
    expect(confirmInstall).not.toHaveBeenCalled()
    expect(manager.stop).not.toHaveBeenCalled()
    expect(manager.install).not.toHaveBeenCalled()
  })
  test('the installation confirmation owns the launch gate until commit or cancellation', async () => {
    const { host, manager, confirmInstall } = await fixture()
    let finish!: (value: boolean) => void
    confirmInstall.mockImplementationOnce(
      async () =>
        new Promise<boolean>(resolve => {
          finish = resolve
        })
    )
    const installing = host.installArchive({ archivePath: '/app.zip', expectedSha256: 'hash' })
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(() => host.open('notes')).toThrow('being confirmed')
    await expect(host.preparePreview('notes')).rejects.toThrow('being confirmed')
    await expect(host.remove('notes')).rejects.toThrow('being confirmed')
    finish(false)
    expect(await installing).toBeNull()
    expect(manager.install).not.toHaveBeenCalled()
    await host.open('notes')
    expect(manager.start).toHaveBeenCalledOnce()
  })
  test('a newly linked installation cannot acquire routes before native consent', async () => {
    const { host, manager, routes } = await fixture()
    await manager.update('notes', { authorized: false })
    await expect(host.preparePreview('notes')).rejects.toThrow('native installation confirmation')
    expect(routes.acquire).not.toHaveBeenCalled()
    expect(manager.start).not.toHaveBeenCalled()
    await host.authorizeInstallation(await manager.get('notes'))
    await host.preparePreview('notes')
    expect(manager.grantNativeCapabilities).toHaveBeenCalledWith('notes', [])
    expect(manager.start).toHaveBeenCalledOnce()
  })
  test('a pending open followed immediately by stop and reopen starts a new generation', async () => {
    let finish!: () => void
    const readiness = new Promise<void>(resolve => {
      finish = resolve
    })
    let calls = 0
    const { host, manager } = await fixture(async () => {
      if (++calls === 1) await readiness
    })
    const first = host.open('notes')
    const canceled = expect(first).rejects.toThrow('canceled')
    const stopping = host.stop('notes')
    const reopened = host.open('notes')
    await canceled
    await stopping
    finish()
    expect((await reopened).state).toBe('running')
    expect(manager.start).toHaveBeenCalledOnce()
  })
  test('a new open waits for the previous stop to finish before reading runtime state', async () => {
    const { host, manager, routes } = await fixture()
    await host.open('notes')
    const original = manager.stop.getMockImplementation()!
    let finish!: () => void
    manager.stop.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => {
        finish = resolve
      })
      await original()
    })
    const stopping = host.stop('notes')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    const opening = host.open('notes')
    await Promise.resolve()
    expect(manager.start).toHaveBeenCalledOnce()
    finish()
    await stopping
    await opening
    expect(manager.start).toHaveBeenCalledTimes(2)
    expect(routes.acquire).toHaveBeenCalledTimes(2)
  })
  test('removing an installation rejects new launches until owned data cleanup finishes', async () => {
    const { host, manager } = await fixture()
    await host.open('notes')
    let finish!: () => void
    manager.delete.mockImplementationOnce(
      async () =>
        new Promise<void>(resolve => {
          finish = resolve
        })
    )
    const removing = host.remove('notes', false)
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    expect(() => host.open('notes')).toThrow('being removed')
    await expect(host.preparePreview('notes')).rejects.toThrow('being removed')
    await expect(host.createShortcut('notes')).rejects.toThrow('being removed')
    await expect(host.setShortcut('notes', 'Control+Alt+N')).rejects.toThrow('being removed')
    finish()
    await removing
    expect(manager.start).toHaveBeenCalledOnce()
  })
  test('tab layout applies native zoom and accepts an inactive zero-sized placeholder', async () => {
    const { host, surface, parent } = await fixture()
    parent.webContents.getZoomFactor = () => 1.5
    await host.open('notes', 'tab')
    await host.layout('notes', { x: 10, y: 20, width: 400, height: 300 }, true)
    expect(surface.showTab).toHaveBeenLastCalledWith(
      parent,
      { x: 15, y: 30, width: 600, height: 450 },
      true
    )
    await host.layout('notes', { x: 0, y: 0, width: 0, height: 0 }, false)
    expect(surface.showTab).toHaveBeenLastCalledWith(
      parent,
      { x: 0, y: 0, width: 1, height: 1 },
      false
    )
  })
  test('development preview prepares the shared DSH runtime without opening a product window', async () => {
    const { host, manager, createSurface } = await fixture()
    const [preview] = await Promise.all([
      host.preparePreview('notes'),
      host.preparePreview('notes'),
    ])
    expect(preview.state).toBe('running')
    expect(manager.start).toHaveBeenCalledOnce()
    expect(createSurface).not.toHaveBeenCalled()
    await host.open('notes')
    expect(manager.start).toHaveBeenCalledOnce()
    expect(createSurface).toHaveBeenCalledOnce()
  })
  test('a stale tab close cannot stop a new independent presentation', async () => {
    const { host, manager, surface } = await fixture()
    await host.open('notes', 'tab')
    const original = manager.get.getMockImplementation()!
    let finish!: () => void
    manager.get.mockImplementationOnce(async () => {
      await new Promise<void>(resolve => {
        finish = resolve
      })
      return original()
    })
    const closing = host.closeView('notes', 'tab')
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'))
    await host.open('notes', 'window')
    finish()
    await closing
    expect(manager.stop).not.toHaveBeenCalled()
    expect(surface.showWindow).toHaveBeenCalled()
  })
  test('closing a pending tab cancels its delayed presentation before it can reopen', async () => {
    let ready!: () => void
    const readiness = new Promise<void>(resolve => {
      ready = resolve
    })
    const { host, manager, showTab } = await fixture(() => readiness)
    const opening = host.open('notes', 'tab')
    const canceled = expect(opening).rejects.toThrow('canceled')
    await host.closeView('notes', 'tab')
    await canceled
    ready()
    await Promise.resolve()
    expect(showTab).not.toHaveBeenCalled()
    expect(manager.start).not.toHaveBeenCalled()
  })
  test('cloud identity changes stop cloud routes before another open while local-only workbenches stay available', async () => {
    const cloud = await fixture()
    await cloud.manager.update('notes', { modelKey: 'wework:public:default:2:remote' })
    await cloud.host.open('notes')
    await cloud.host.cloudConnectionChanged(
      JSON.stringify({ apiBaseUrl: 'https://cloud.example/api', user: { id: 2 } })
    )
    expect(cloud.manager.stop).toHaveBeenCalled()
    expect(cloud.surface.dispose).toHaveBeenCalled()
    expect(cloud.routes.release).toHaveBeenCalledWith('notes')
    const local = await fixture()
    await local.manager.update('notes', { modelKey: 'wework:runtime:::local' })
    await local.host.open('notes')
    await local.host.cloudConnectionChanged(
      JSON.stringify({ apiBaseUrl: 'https://cloud.example/api', user: { id: 2 } })
    )
    expect(local.manager.stop).not.toHaveBeenCalled()
    expect(local.surface.dispose).not.toHaveBeenCalled()
  })
  test('Executor replacement invalidates cached tokens and re-registers resident runtimes', async () => {
    const { host, manager, routes, surface } = await fixture()
    await host.open('notes')
    await host.configure('notes', { resident: true })
    await host.invalidateRuntime()
    expect(routes.invalidate).toHaveBeenCalledOnce()
    expect(surface.dispose).toHaveBeenCalledOnce()
    await host.resumeResident()
    expect(routes.acquire).toHaveBeenCalledTimes(2)
    expect(manager.start).toHaveBeenCalledTimes(2)
    expect((await host.list())[0]?.visible).toBe(false)
  })
  test('opens both flavors independently by default and reuses one page while moving into and out of a tab', async () => {
    const { host, manager, surface, createSurface, parent, contents } = await fixture()
    const opened = await host.open('notes')
    expect(opened.presentation).toBe('window')
    expect(opened.flavor).toBe('extended')
    expect(surface.showWindow).toHaveBeenCalledOnce()
    expect(host.contentsForId('notes')).toBe(contents)
    await host.open('notes', 'tab')
    await host.layout('notes', { x: 100, y: 50, width: 500, height: 400 }, true)
    expect(surface.showTab).toHaveBeenCalledWith(
      parent,
      { x: 100, y: 50, width: 500, height: 400 },
      true
    )
    await host.open('notes', 'window')
    expect(createSurface).toHaveBeenCalledOnce()
    expect(manager.start).toHaveBeenCalledOnce()
    expect(host.contentsForId('notes')).toBe(contents)
    expect(surface.dispose).not.toHaveBeenCalled()
  })
  test('deduplicates simultaneous opens and persists presentation independently of flavor', async () => {
    const { host, manager, createSurface } = await fixture()
    await manager.update('notes', {
      manifest: { ...(await manager.get()).manifest, flavor: 'lightweight' },
    })
    await Promise.all([host.open('notes'), host.open('notes')])
    expect(manager.start).toHaveBeenCalledOnce()
    expect(createSurface).toHaveBeenCalledOnce()
    expect((await host.configure('notes', { presentation: 'tab' })).flavor).toBe('lightweight')
    expect((await manager.get()).presentation).toBe('tab')
  })
  test('native close follows background policy while explicit hide preserves the runtime', async () => {
    const { host, manager, surface, close } = await fixture()
    await host.open('notes')
    close()
    await vi.waitFor(() => expect(surface.hide).toHaveBeenCalled())
    expect(manager.stop).not.toHaveBeenCalled()
    await host.open('notes')
    await host.configure('notes', { background: false, resident: true })
    await host.hide('notes')
    expect(manager.stop).not.toHaveBeenCalled()
    await host.open('notes')
    close()
    await vi.waitFor(() => expect(manager.stop).toHaveBeenCalled())
    expect(surface.dispose).toHaveBeenCalledOnce()
  })
  test('hiding an open waiting for services preserves its runtime without displaying it', async () => {
    const ready = deferred()
    const entered = deferred()
    const { host, manager, surface } = await fixture(async () => {
      entered.resolve()
      await ready.promise
    })
    const opening = host.open('notes')
    await entered.promise
    await host.hide('notes')
    ready.resolve()
    expect((await opening).visible).toBe(false)
    expect((await host.list())[0]?.state).toBe('running')
    expect(manager.stop).not.toHaveBeenCalled()
    expect(surface.showWindow).not.toHaveBeenCalled()
  })
  test('hiding a loading page keeps that page and ignores its late ready event', async () => {
    const ready = deferred()
    const { host, manager, surface, createSurface } = await fixture()
    Object.assign(surface, { ready: ready.promise })
    const opening = host.open('notes')
    await vi.waitFor(() => expect(createSurface).toHaveBeenCalledOnce())
    await host.hide('notes')
    ready.resolve()
    expect((await opening).visible).toBe(false)
    expect(surface.showWindow).not.toHaveBeenCalled()
    expect(surface.dispose).not.toHaveBeenCalled()
    await host.open('notes')
    expect(surface.showWindow).toHaveBeenCalledOnce()
    expect(createSurface).toHaveBeenCalledOnce()
    expect(manager.start).toHaveBeenCalledOnce()
  })
  test('hide cancels a delayed tab publication without stopping the running app', async () => {
    const ready = deferred()
    const entered = deferred()
    const { host, manager, showTab } = await fixture()
    let published = false
    showTab.mockImplementationOnce(async (...args) => {
      entered.resolve()
      await ready.promise
      args[1]?.throwIfAborted()
      published = true
    })
    const opening = host.open('notes', 'tab')
    await entered.promise
    await host.hide('notes')
    ready.resolve()
    expect((await opening).visible).toBe(false)
    expect(published).toBe(false)
    expect(manager.stop).not.toHaveBeenCalled()
    expect((await host.list())[0]?.state).toBe('running')
  })
  test('the latest open after a pending open and hide displays the retained runtime', async () => {
    const ready = deferred()
    const entered = deferred()
    const { host, manager, surface, createSurface } = await fixture(async () => {
      entered.resolve()
      await ready.promise
    })
    const first = host.open('notes')
    await entered.promise
    await host.hide('notes')
    const latest = host.open('notes')
    ready.resolve()
    await first
    expect((await latest).visible).toBe(true)
    expect(surface.showWindow).toHaveBeenCalledOnce()
    expect(createSurface).toHaveBeenCalledOnce()
    expect(manager.start).toHaveBeenCalledOnce()
  })
  test('a queued open before hide cannot restore the canceled display intent', async () => {
    const ready = deferred()
    const entered = deferred()
    const { host, surface, showTab } = await fixture(async () => {
      entered.resolve()
      await ready.promise
    })
    const first = host.open('notes')
    await entered.promise
    const queued = host.open('notes', 'tab')
    await host.hide('notes')
    ready.resolve()
    expect((await first).visible).toBe(false)
    expect((await queued).visible).toBe(false)
    expect(surface.showWindow).not.toHaveBeenCalled()
    expect(showTab).not.toHaveBeenCalled()
  })
  test('a queued window request makes a late close from the pending tab obsolete', async () => {
    const ready = deferred()
    const entered = deferred()
    const { host, manager, surface } = await fixture(async () => {
      entered.resolve()
      await ready.promise
    })
    const first = host.open('notes', 'tab')
    await entered.promise
    const latest = host.open('notes', 'window')
    await host.closeView('notes', 'tab')
    ready.resolve()
    await first
    expect((await latest).visible).toBe(true)
    expect(surface.showWindow).toHaveBeenCalledOnce()
    expect(manager.stop).not.toHaveBeenCalled()
  })
  test('a background close hides a loading tab and rejects late layout without killing its runtime', async () => {
    const ready = deferred()
    const { host, manager, surface, createSurface } = await fixture()
    Object.assign(surface, { ready: ready.promise })
    const opening = host.open('notes', 'tab')
    await vi.waitFor(() => expect(createSurface).toHaveBeenCalledOnce())
    await host.closeView('notes', 'tab')
    ready.resolve()
    expect((await opening).visible).toBe(false)
    await host.layout('notes', { x: 0, y: 0, width: 500, height: 400 }, true)
    expect(surface.showTab).not.toHaveBeenCalled()
    expect(manager.stop).not.toHaveBeenCalled()
    expect(surface.dispose).not.toHaveBeenCalled()
  })
  test('remove waits for a desktop shortcut write and deletes the completed file', async () => {
    const ready = deferred()
    const entered = deferred()
    const original = WorkbenchDesktopShortcuts.prototype.create
    vi.spyOn(WorkbenchDesktopShortcuts.prototype, 'create').mockImplementation(async function (
      this: WorkbenchDesktopShortcuts,
      id
    ) {
      entered.resolve()
      await ready.promise
      return original.call(this, id)
    })
    const { host, manager } = await fixture()
    const creating = host.createShortcut('notes')
    await entered.promise
    const removing = host.remove('notes', false)
    let path: string
    try {
      expect(manager.stop).not.toHaveBeenCalled()
    } finally {
      ready.resolve()
      path = await creating
      await removing
    }
    await expect(access(path)).rejects.toMatchObject({ code: 'ENOENT' })
  })
  test('remove waits for a global shortcut update before disposing its registration', async () => {
    const registered = new Set<string>()
    vi.mocked(globalShortcut.register).mockImplementation(key => {
      registered.add(key)
      return true
    })
    vi.mocked(globalShortcut.unregister).mockImplementation(key => {
      registered.delete(key)
    })
    const { host, manager } = await fixture()
    await host.setShortcut('notes', 'Control+Alt+N')
    const original = manager.get.getMockImplementation()!
    const ready = deferred()
    const entered = deferred()
    manager.get.mockImplementationOnce(async () => {
      const value = await original()
      entered.resolve()
      await ready.promise
      return value
    })
    const updating = host.setShortcut('notes', 'Control+Alt+M')
    await entered.promise
    const removing = host.remove('notes', false)
    try {
      expect(manager.stop).not.toHaveBeenCalled()
    } finally {
      ready.resolve()
      await Promise.all([updating, removing])
    }
    expect(registered.size).toBe(0)
  })
  test('remove waits for a failed shortcut write and its rollback before cleanup', async () => {
    const registered = new Set<string>()
    vi.mocked(globalShortcut.register).mockImplementation(key => {
      registered.add(key)
      return true
    })
    vi.mocked(globalShortcut.unregister).mockImplementation(key => {
      registered.delete(key)
    })
    const { host, manager } = await fixture()
    await host.setShortcut('notes', 'Control+Alt+N')
    const ready = deferred()
    const entered = deferred()
    manager.update.mockImplementationOnce(async () => {
      entered.resolve()
      await ready.promise
      throw new Error('Registry write failed')
    })
    const updating = host.setShortcut('notes', 'Control+Alt+M')
    const failed = expect(updating).rejects.toThrow('Registry write failed')
    await entered.promise
    const removing = host.remove('notes', false)
    try {
      expect(manager.stop).not.toHaveBeenCalled()
    } finally {
      ready.resolve()
      await failed
      await removing
    }
    expect(registered.size).toBe(0)
  })
  test('stop cancels an open waiting for core services without starting an orphan runtime', async () => {
    let finish!: () => void
    const ready = new Promise<void>(resolve => {
      finish = resolve
    })
    const { host, manager, routes, createSurface } = await fixture(() => ready)
    const opening = host.open('notes')
    const rejected = expect(opening).rejects.toThrow('canceled')
    await host.stop('notes')
    await rejected
    finish()
    await Promise.resolve()
    expect(manager.start).not.toHaveBeenCalled()
    expect(routes.acquire).not.toHaveBeenCalled()
    expect(createSurface).not.toHaveBeenCalled()
  })
  test('invalid presentations and layout bounds cannot change the surface', async () => {
    const { host, surface } = await fixture()
    expect(() => host.open('notes', 'popup' as never)).toThrow('Invalid workbench presentation')
    await host.open('notes', 'tab')
    await expect(
      host.layout('notes', { x: NaN, y: 0, width: 500, height: 300 }, true)
    ).rejects.toThrow('Invalid workbench bounds')
    expect(surface.showTab).not.toHaveBeenCalled()
  })
  test('tab native controls do not hide or pin the main window', async () => {
    const { host, surface } = await fixture()
    await host.open('notes', 'tab')
    await host.native.invoke('notes', 'window.hide')
    expect(surface.hide).toHaveBeenCalled()
    await expect(
      host.native.invoke('notes', 'window.setAlwaysOnTop', { value: true })
    ).rejects.toThrow('independent workbench window')
  })
})
