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
  vi.useRealTimers()
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
    list: async () => [installation],
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
  test('isolates a corrupted installation reminder file while restoring other installations', async () => {
    const { root, service, installation, window } = await fixture()
    service.dispose()
    vi.useFakeTimers()
    const good = {
      ...installation,
      id: 'good',
      manifest: { ...installation.manifest, displayName: 'Good' },
    }
    const report = vi.fn()
    services = new WorkbenchAppServices(root, {
      list: async () => [installation, good],
      get: async id => (id === 'good' ? good : installation),
      open: async () => {},
      window: () => window,
      report,
    })
    await services.data.commit('good', null, [
      { id: 'due', title: 'Good reminder', body: '', at: new Date(Date.now() + 100).toISOString() },
    ])
    await mkdir(join(root, 'harness-apps/instances/todo'), { recursive: true })
    await writeFile(services.data.path('todo'), 'malformed')
    await services.start()
    expect(report).toHaveBeenCalledOnce()
    await vi.advanceTimersByTimeAsync(100)
    await vi.waitFor(() =>
      expect(native.notifications).toEqual([{ title: 'Good · Good reminder', body: '' }])
    )
  })

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

  test('state and reminder replacement commit together; a failed schedule cannot mutate state', async () => {
    const { service } = await fixture()
    const reminder = {
      id: 'alarm',
      title: 'Due',
      body: '',
      at: new Date(Date.now() + 60_000).toISOString(),
    }
    await service.invoke('todo', 'storage.commit', {
      value: { task: 'original' },
      reminders: [reminder],
    })
    await expect(
      service.invoke('todo', 'storage.commit', {
        value: { task: 'broken' },
        reminders: [{ ...reminder, at: new Date(0).toISOString() }],
      })
    ).rejects.toThrow('future')
    expect(await service.data.read('todo')).toEqual({
      state: { task: 'original' },
      reminders: [reminder],
    })
    await service.invoke('todo', 'storage.set', { value: { task: 'updated' } })
    expect(await service.invoke('todo', 'reminders.list')).toEqual([reminder])
  })

  test('empty reminder replacement still requires native consent; oversized state is rejected', async () => {
    const { service, installation } = await fixture()
    installation.grantedCapabilities.native = []
    await expect(
      service.invoke('todo', 'storage.commit', { value: {}, reminders: [] })
    ).rejects.toThrow('denied')
    await expect(
      service.invoke('todo', 'storage.set', { value: 'x'.repeat(1024 * 1024) })
    ).rejects.toThrow('1 MiB')
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

  test('restores durable alarms without running a view and consumes each alarm once', async () => {
    const { service } = await fixture()
    vi.useFakeTimers()
    await service.data.importLegacy('todo', {
      state: { task: 'keep' },
      reminders: [
        { id: 'alarm', title: 'Due', body: '', at: new Date(Date.now() + 1000).toISOString() },
      ],
    })
    await service.start()
    await vi.advanceTimersByTimeAsync(1000)
    await vi.waitFor(() => expect(native.notifications).toHaveLength(1))
    await vi.waitFor(async () => expect((await service.data.read('todo')).reminders).toEqual([]))
    expect(native.notifications).toHaveLength(1)
    expect((await service.data.read('todo')).reminders).toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(native.notifications).toHaveLength(1)
  })

  test('a late refresh cannot replace a newer committed reminder with the same id', async () => {
    const { service } = await fixture()
    vi.useFakeTimers()
    const oldReminder = {
      id: 'alarm',
      title: 'Old',
      body: '',
      at: new Date(Date.now() + 1000).toISOString(),
    }
    await service.data.commit('todo', { version: 'old' }, [oldReminder])
    const oldData = await service.data.read('todo')
    let release!: (value: typeof oldData) => void
    let entered!: () => void
    const enteredRead = new Promise<void>(resolve => {
      entered = resolve
    })
    const pendingRead = new Promise<typeof oldData>(resolve => {
      release = resolve
    })
    vi.spyOn(service.data, 'read').mockImplementationOnce(() => {
      entered()
      return pendingRead
    })
    const oldRefresh = service.refresh('todo')
    await enteredRead
    const newReminder = {
      ...oldReminder,
      title: 'New',
      at: new Date(Date.now() + 2000).toISOString(),
    }
    await service.invoke('todo', 'storage.commit', {
      value: { version: 'new' },
      reminders: [newReminder],
    })
    release(oldData)
    await oldRefresh
    await vi.advanceTimersByTimeAsync(2000)
    await vi.waitFor(() =>
      expect(native.notifications).toEqual([{ title: 'TODO · New', body: '' }])
    )
    await vi.waitFor(async () => expect((await service.data.read('todo')).reminders).toEqual([]))
    expect((await service.data.read('todo')).state).toEqual({ version: 'new' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(native.notifications).toHaveLength(1)
  })

  test.each(['remove', 'revoke', 'dispose'] as const)(
    '%s invalidates a reminder refresh whose persisted read is still pending',
    async action => {
      const { service } = await fixture()
      vi.useFakeTimers()
      await service.data.commit('todo', null, [
        {
          id: 'alarm',
          title: 'Due',
          body: '',
          at: new Date(Date.now() + 1000).toISOString(),
        },
      ])
      const oldData = await service.data.read('todo')
      let release!: (value: typeof oldData) => void
      let entered!: () => void
      const enteredRead = new Promise<void>(resolve => {
        entered = resolve
      })
      const pendingRead = new Promise<typeof oldData>(resolve => {
        release = resolve
      })
      vi.spyOn(service.data, 'read').mockImplementationOnce(() => {
        entered()
        return pendingRead
      })
      const refresh = service.refresh('todo')
      await enteredRead
      if (action === 'remove') await service.removeData('todo')
      else if (action === 'dispose') service.dispose()
      else {
        service.revoke('todo')
        service.activate('todo')
      }
      release(oldData)
      await refresh
      expect(vi.getTimerCount()).toBe(0)
      expect((await service.data.read('todo')).reminders).toHaveLength(action === 'remove' ? 0 : 1)
      expect(native.notifications).toHaveLength(0)
    }
  )

  test('revoked grants prevent a scheduled notification from being shown', async () => {
    const { service, installation } = await fixture()
    vi.useFakeTimers()
    await service.invoke('todo', 'reminders.schedule', {
      id: 'alarm',
      title: 'Due',
      at: new Date(Date.now() + 1000).toISOString(),
    })
    installation.grantedCapabilities.native = []
    await vi.advanceTimersByTimeAsync(1000)
    expect(native.notifications).toHaveLength(0)
    expect((await service.data.read('todo')).reminders).toHaveLength(1)
  })
})
