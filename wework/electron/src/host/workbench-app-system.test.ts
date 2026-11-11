import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { BrowserWindow } from 'electron'
const native = vi.hoisted(() => ({
  open: vi.fn(),
  save: vi.fn(),
  external: vi.fn<(url: string) => Promise<void>>(async () => {}),
  clipboardRead: vi.fn(() => 'clipboard value'),
  clipboardWrite: vi.fn(),
}))
vi.mock('electron', () => ({
  clipboard: { readText: native.clipboardRead, writeText: native.clipboardWrite },
  dialog: { showOpenDialog: native.open, showSaveDialog: native.save },
  Notification: class {
    static isSupported() {
      return false
    }
  },
  shell: { openExternal: native.external },
}))
import { invokeWorkbenchSystem } from './workbench-app-system.js'
import { workbenchMethodCapability } from './workbench-app-capabilities.js'

let root: string
const window = { isDestroyed: () => false } as unknown as BrowserWindow
const authorize = vi.fn()
const invoke = (method: string, params: Record<string, unknown> = {}) =>
  invokeWorkbenchSystem(method, params, window, 'TODO', vi.fn(), authorize)
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'workbench-app-system-'))
  vi.clearAllMocks()
  authorize.mockImplementation(() => {})
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('Workbench system capabilities', () => {
  test('requires explicit capability grants for every sensitive SDK method', () => {
    const methods = {
      'notifications.show': 'notifications',
      'reminders.list': 'notifications',
      'reminders.schedule': 'notifications',
      'reminders.cancel': 'notifications',
      'clipboard.readText': 'clipboard.read',
      'clipboard.writeText': 'clipboard.write',
      'files.openText': 'files.read',
      'files.saveText': 'files.write',
      'external.open': 'external.open',
    }
    for (const [method, capability] of Object.entries(methods))
      expect(workbenchMethodCapability(method)).toBe(capability)
  })
  test('reads only a user-selected file and rechecks authorization after the native dialog', async () => {
    const path = join(root, 'selected.txt')
    await writeFile(path, 'selected content')
    native.open.mockResolvedValue({ canceled: false, filePaths: [path] })
    expect(await invoke('files.openText')).toEqual({
      name: 'selected.txt',
      text: 'selected content',
    })
    expect(authorize).toHaveBeenCalledTimes(4)
    authorize.mockImplementationOnce(() => {
      throw new Error('Application stopped')
    })
    await expect(invoke('files.openText')).rejects.toThrow('Application stopped')
  })
  test('writes only after save confirmation and refuses path components in suggested names', async () => {
    const path = join(root, 'saved.txt')
    native.save.mockResolvedValue({ canceled: false, filePath: path })
    expect(await invoke('files.saveText', { name: 'saved.txt', text: 'my note' })).toBe(true)
    expect(await readFile(path, 'utf8')).toBe('my note')
    for (const name of ['../escape.txt', '/tmp/escape.txt', '..', 'folder\\escape.txt']) {
      await expect(invoke('files.saveText', { name, text: 'bad' })).rejects.toThrow('file name')
    }
    native.save.mockResolvedValue({ canceled: true })
    expect(await invoke('files.saveText', { name: 'cancel.txt', text: 'nothing' })).toBe(false)
  })
  test('rejects external application schemes, local file links and embedded credentials', async () => {
    for (const url of [
      'file:///etc/passwd',
      'javascript:alert(1)',
      'wework://tasks/any',
      'https://user:secret@example.com',
    ]) {
      await expect(invoke('external.open', { url })).rejects.toThrow('Only HTTP')
    }
    expect(native.external).not.toHaveBeenCalled()
    await invoke('external.open', { url: 'https://example.com/help' })
    expect(native.external).toHaveBeenCalledWith('https://example.com/help')
  })
  test('supports clipboard operations and rejects unknown methods', async () => {
    expect(await invoke('clipboard.readText')).toBe('clipboard value')
    await invoke('clipboard.writeText', { text: '' })
    expect(native.clipboardWrite).toHaveBeenCalledWith('')
    await expect(invoke('shell.execute', { command: 'anything' })).rejects.toThrow('Unknown')
  })

  test.each(['files.openText', 'files.saveText'])(
    '%s requires a live native parent without opening an unowned dialog',
    async method => {
      for (const parent of [null, { isDestroyed: () => true } as BrowserWindow]) {
        await expect(
          invokeWorkbenchSystem(method, {}, parent, 'TODO', vi.fn(), authorize)
        ).rejects.toThrow('file dialogs')
      }
      expect(native.open).not.toHaveBeenCalled()
      expect(native.save).not.toHaveBeenCalled()
    }
  )

  test('revalidates authorization after an asynchronous external-open operation', async () => {
    native.external.mockImplementationOnce(async () => {
      authorize.mockRejectedValueOnce(new Error('Capability revoked'))
    })
    await expect(
      invokeWorkbenchSystem(
        'external.open',
        { url: 'https://example.com/' },
        null,
        'TODO',
        vi.fn(),
        authorize
      )
    ).rejects.toThrow('Capability revoked')
  })
})
