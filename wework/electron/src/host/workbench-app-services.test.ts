import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { WorkbenchAppManifest } from '../runtime/workbench-dsh-runtime.js'

const native = vi.hoisted(() => ({
  readClipboard: vi.fn(() => 'secret'),
  writeClipboard: vi.fn(),
  external: vi.fn(async () => {}),
  notifications: [] as unknown[],
  picker: vi.fn(),
  save: vi.fn(),
}))
vi.mock('electron', () => ({
  clipboard: { readText: native.readClipboard, writeText: native.writeClipboard },
  dialog: { showOpenDialog: native.picker, showSaveDialog: native.save },
  shell: { openExternal: native.external },
  Notification: class {
    static isSupported() {
      return true
    }
    constructor(readonly value: unknown) {}
    once() {}
    show() {
      native.notifications.push(this.value)
    }
  },
}))
import { WorkbenchAppServices } from './workbench-app-services.js'

const roots: string[] = []
let services: WorkbenchAppServices | undefined
beforeEach(() => {
  vi.clearAllMocks()
  native.notifications.length = 0
})
afterEach(async () => {
  services?.dispose()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wework-scoped-services-'))
  roots.push(root)
  const manifest: WorkbenchAppManifest = {
    name: 'todo',
    displayName: 'TODO',
    version: '1.0.0',
    type: 'deepseek-harness-plugin-bundle',
    flavor: 'lightweight',
    description: '',
    entry: { installPackage: 'bundle', profile: 'web' },
    requirements: { dsh: '0.2.0-rc.2', node: '>=22' },
    capabilities: { native: ['notifications', 'clipboard.read', 'files.read', 'files.write'] },
  }
  const installation = {
    id: 'todo',
    manifest,
    grantedCapabilities: {
      native: ['notifications', 'clipboard.read', 'files.read', 'files.write'],
    },
  }
  const other = { ...installation, id: 'other' }
  const window = {
    isDestroyed: () => false,
    hide: vi.fn(),
    setAlwaysOnTop: vi.fn(),
  } as unknown as BrowserWindow
  const open = vi.fn(async () => {})
  let active: BrowserWindow | null = window
  services = new WorkbenchAppServices(root, {
    get: async id => {
      if (id === installation.id) return installation
      if (id === other.id) return other
      throw new Error('Not installed')
    },
    open,
    window: () => active,
  })
  return {
    root,
    service: services,
    installation,
    window,
    open,
    setWindow: (value: BrowserWindow | null) => {
      active = value
    },
  }
}

describe('installation-scoped workbench services', () => {
  test.each(['reminders.list', 'reminders.schedule', 'reminders.cancel', 'storage.commit'])(
    'rejects removed scheduled-reminder API %s without changing ordinary state',
    async method => {
      const { service } = await fixture()
      await service.invoke('todo', 'storage.set', { value: { tasks: ['keep'] } })
      await expect(
        service.invoke('todo', method, {
          id: 'alarm',
          title: 'Removed',
          at: new Date(Date.now() + 60_000).toISOString(),
          value: { tasks: ['replace'] },
        })
      ).rejects.toThrow('Unknown workbench method')
      expect(await service.invoke('todo', 'storage.get')).toEqual({ tasks: ['keep'] })
      expect(native.notifications).toHaveLength(0)
    }
  )

  test('revocation blocks an already pending authorization and prevents data resurrection after uninstall', async () => {
    const { service } = await fixture()
    const pending = service.invoke('todo', 'storage.set', { value: { orphan: true } })
    const rejected = expect(pending).rejects.toThrow('services are stopped')
    service.revoke('todo')
    await service.removeData('todo')
    await rejected
    expect((await service.data.read('todo')).state).toBeNull()
    await expect(service.invoke('todo', 'storage.set', { value: 1 })).rejects.toThrow(
      'services are stopped'
    )
    service.activate('todo')
    await service.invoke('todo', 'storage.set', { value: 2 })
    expect(await service.invoke('todo', 'storage.get')).toBe(2)
  })

  test('revokes a pending native file selection before reading the selected file', async () => {
    const { service } = await fixture()
    let select!: (value: { canceled: boolean; filePaths: string[] }) => void
    native.picker.mockImplementation(
      () =>
        new Promise(resolve => {
          select = resolve
        })
    )
    const operation = service.invoke('todo', 'files.openText')
    await vi.waitFor(() => expect(select).toBeTypeOf('function'))
    service.revoke('todo')
    select({ canceled: false, filePaths: ['/should-not-be-read'] })
    await expect(operation).rejects.toThrow('services are stopped')
  })

  test('storage ignores client-supplied identities and persists under the existing DSH installation', async () => {
    const { service } = await fixture()
    await service.invoke('todo', 'storage.set', { value: { count: 7 }, installationId: 'other' })
    expect(await service.invoke('todo', 'storage.get')).toEqual({ count: 7 })
    expect(await service.invoke('other', 'storage.get')).toBeNull()
    expect(service.data.path('todo')).toMatch(/harness-apps\/instances\/todo\/wework-app\.json$/)
    await expect(service.invoke('../other', 'storage.get')).rejects.toThrow()
  })

  test('requires both persisted native consent and the current manifest declaration', async () => {
    const { service, installation } = await fixture()
    installation.grantedCapabilities.native = []
    await expect(service.invoke('todo', 'clipboard.readText')).rejects.toThrow('denied')
    expect(native.readClipboard).not.toHaveBeenCalled()
    installation.grantedCapabilities.native = ['clipboard.read']
    expect(await service.invoke('todo', 'clipboard.readText')).toBe('secret')
    installation.manifest.capabilities!.native = []
    await expect(service.invoke('todo', 'clipboard.readText')).rejects.toThrow('denied')
  })

  test('shows a granted notification without any native view', async () => {
    const { service, setWindow } = await fixture()
    setWindow(null)
    await expect(
      service.invoke('todo', 'notifications.show', { title: 'Resident', body: 'Ready' })
    ).resolves.toBeNull()
    expect(native.notifications).toEqual([{ title: 'TODO · Resident', body: 'Ready' }])
  })

  test.each(['grant', 'declaration', 'revocation'])(
    'a missing %s denies notifications from a workbench without a view',
    async denial => {
      const { service, setWindow, installation } = await fixture()
      setWindow(null)
      if (denial === 'grant') installation.grantedCapabilities.native = []
      else if (denial === 'declaration') installation.manifest.capabilities!.native = []
      else service.revoke('todo')
      await expect(
        service.invoke('todo', 'notifications.show', { title: 'Denied' })
      ).rejects.toThrow(denial === 'revocation' ? 'services are stopped' : 'denied')
      expect(native.notifications).toHaveLength(0)
    }
  )

  test('granted clipboard and external capabilities remain available without a view', async () => {
    const { service, setWindow, installation } = await fixture()
    setWindow(null)
    installation.manifest.capabilities!.native!.push('clipboard.write', 'external.open')
    installation.grantedCapabilities.native.push('clipboard.write', 'external.open')
    expect(await service.invoke('todo', 'clipboard.readText')).toBe('secret')
    await service.invoke('todo', 'clipboard.writeText', { text: 'background' })
    expect(native.writeClipboard).toHaveBeenCalledWith('background')
    await service.invoke('todo', 'external.open', { url: 'https://example.com/help' })
    expect(native.external).toHaveBeenCalledWith('https://example.com/help')
  })

  test.each(['files.openText', 'files.saveText'])(
    '%s clearly fails without a native parent view',
    async method => {
      const { service, setWindow } = await fixture()
      setWindow(null)
      await expect(
        service.invoke('todo', method, { name: 'notes.txt', text: 'private' })
      ).rejects.toThrow('Workbench view is unavailable for file dialogs')
      expect(native.picker).not.toHaveBeenCalled()
      expect(native.save).not.toHaveBeenCalled()
    }
  )

  test('ordinary state needs no notification grant and rejects invalid saves without mutation', async () => {
    const { service, installation } = await fixture()
    installation.grantedCapabilities.native = []
    await service.invoke('todo', 'storage.set', { value: { tasks: ['keep'] } })
    await expect(
      service.invoke('todo', 'storage.set', { value: 'x'.repeat(1024 * 1024) })
    ).rejects.toThrow('1 MiB')
    expect(await service.invoke('todo', 'storage.get')).toEqual({ tasks: ['keep'] })
  })

  test('corrupted ordinary state is isolated to its owning installation', async () => {
    const { service } = await fixture()
    await service.invoke('other', 'storage.set', { value: { count: 3 } })
    await mkdir(join(service.data.path('todo'), '..'), { recursive: true })
    await writeFile(service.data.path('todo'), 'malformed')
    await expect(service.invoke('todo', 'storage.get')).rejects.toThrow()
    expect(await service.invoke('other', 'storage.get')).toEqual({ count: 3 })
  })

  test('revalidates permission after an asynchronous native picker instead of returning selected data', async () => {
    const { service, installation } = await fixture()
    let resolvePicker!: (value: unknown) => void
    native.picker.mockImplementation(
      () =>
        new Promise(resolve => {
          resolvePicker = resolve
        })
    )
    const pending = service.invoke('todo', 'files.openText')
    await vi.waitFor(() => expect(native.picker).toHaveBeenCalled())
    installation.grantedCapabilities.native = []
    resolvePicker({ canceled: false, filePaths: ['/private/selected-file'] })
    await expect(pending).rejects.toThrow('denied')
  })

  test('revalidates the owner view after a native save dialog before writing a file', async () => {
    const { service, setWindow } = await fixture()
    let resolvePicker!: (value: unknown) => void
    native.save.mockImplementation(
      () =>
        new Promise(resolve => {
          resolvePicker = resolve
        })
    )
    const pending = service.invoke('todo', 'files.saveText', { name: 'notes.txt', text: 'private' })
    await vi.waitFor(() => expect(native.save).toHaveBeenCalled())
    setWindow({ isDestroyed: () => false } as BrowserWindow)
    resolvePicker({ canceled: false, filePath: '/private/must-not-write' })
    await expect(pending).rejects.toThrow('view changed')
  })
})
