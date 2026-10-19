import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { migrateWorkbenchDesktopData } from './workbench-desktop-data.js'
import { initializeWorkbenchDesktopData } from './workbench-desktop-startup.js'
import { migrateWorkbenchDataEntry } from './workbench-data-migration.js'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync), symlinkSync: vi.fn(actual.symlinkSync) }
})
const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
let root: string
beforeEach(() => {
  vi.mocked(fs.renameSync).mockImplementation(actual.renameSync)
  vi.mocked(fs.symlinkSync).mockImplementation(actual.symlinkSync)
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'desktop-data-startup-')))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function fixture(platform: NodeJS.Platform = 'win32') {
  const source = join(root, 'appData/app')
  const desktop = join(root, 'workbench/wework/app')
  const logs = join(source, 'logs')
  let singletonHeld = false
  let migrationHeld = false
  let singletonPath = ''
  const additionalData = { workspaceOpenRequest: { path: 'synthetic-workspace' } }
  const app = {
    getPath: vi.fn(() => logs),
    setPath: vi.fn((_name: string, path: string) => {
      singletonPath = path
    }),
    requestSingleInstanceLock: vi.fn((data: unknown) => {
      expect(data).toEqual(additionalData)
      expect(singletonPath).toBe(source)
      expect(fs.statSync(source).isDirectory()).toBe(true)
      singletonHeld = true
      return true
    }),
    releaseSingleInstanceLock: vi.fn(() => {
      singletonHeld = false
    }),
  }
  const lock = {
    assertHeld: vi.fn(() => expect(migrationHeld).toBe(true)),
    release: vi.fn(async () => {
      migrationHeld = false
    }),
  }
  const acquireLock = vi.fn(async (resources: string[]) => {
    expect(resources).toEqual([source, desktop])
    migrationHeld = true
    return lock
  })
  vi.mocked(fs.renameSync).mockImplementation((from, to) => {
    if (from === source && platform === 'win32' && singletonHeld) {
      throw Object.assign(new Error('EPERM: directory contains an open lockfile'), {
        code: 'EPERM',
      })
    }
    if (from === source && platform === 'win32') expect(migrationHeld).toBe(true)
    return actual.renameSync(from, to)
  })
  const options = { app, source, desktop, additionalData, acquireLock, platform }
  return { ...options, logs, lock, options, singletonHeld: () => singletonHeld }
}

test.each(['existing', 'new'])(
  'Windows %s installation moves userData without its own lockfile',
  async installation => {
    const input = fixture()
    fs.mkdirSync(input.source, { recursive: true })
    if (installation === 'existing') {
      fs.mkdirSync(join(input.source, 'Partitions/browser'), { recursive: true })
      fs.writeFileSync(join(input.source, 'Partitions/browser/Cookies'), 'original-cookies')
      fs.writeFileSync(join(input.source, 'preferences.json'), 'original-preferences')
    }
    const inode = fs.statSync(input.source).ino
    input.app.setPath('userData', input.source)
    input.app.requestSingleInstanceLock(input.additionalData)
    expect(() => migrateWorkbenchDesktopData(input)).toThrow('EPERM')
    input.app.releaseSingleInstanceLock()
    vi.clearAllMocks()

    const result = await initializeWorkbenchDesktopData(input.options)

    expect(result).toEqual({
      userData: join(input.desktop, 'user-data'),
      logs: join(input.desktop, 'user-data/logs'),
    })
    expect(fs.statSync(result!.userData).ino).toBe(inode)
    expect(fs.realpathSync(input.source)).toBe(result!.userData)
    if (installation === 'existing') {
      expect(fs.readFileSync(join(result!.userData, 'Partitions/browser/Cookies'), 'utf8')).toBe(
        'original-cookies'
      )
      expect(fs.readFileSync(join(result!.userData, 'preferences.json'), 'utf8')).toBe(
        'original-preferences'
      )
    }
    expect(input.acquireLock).toHaveBeenCalledWith([input.source, input.desktop])
    expect(input.app.releaseSingleInstanceLock).toHaveBeenCalledOnce()
    expect(input.app.requestSingleInstanceLock.mock.calls).toEqual([
      [input.additionalData],
      [input.additionalData],
    ])
    expect(input.singletonHeld()).toBe(true)
    expect(input.lock.release).toHaveBeenCalledOnce()
  }
)

test('an existing primary is notified without moving its data', async () => {
  const input = fixture()
  fs.mkdirSync(input.source, { recursive: true })
  fs.writeFileSync(join(input.source, 'preferences.json'), 'original')
  input.app.requestSingleInstanceLock.mockReturnValue(false)

  expect(await initializeWorkbenchDesktopData(input.options)).toBeNull()

  expect(fs.readFileSync(join(input.source, 'preferences.json'), 'utf8')).toBe('original')
  expect(fs.existsSync(join(input.desktop, 'user-data'))).toBe(false)
  expect(input.app.releaseSingleInstanceLock).not.toHaveBeenCalled()
  expect(input.lock.release).toHaveBeenCalledOnce()
})

test('a legacy build winning the handoff stops startup after notification', async () => {
  const input = fixture()
  input.app.requestSingleInstanceLock.mockImplementationOnce(() => true).mockReturnValueOnce(false)

  expect(await initializeWorkbenchDesktopData(input.options)).toBeNull()

  expect(fs.realpathSync(input.source)).toBe(join(input.desktop, 'user-data'))
  expect(input.app.requestSingleInstanceLock.mock.calls).toEqual([
    [input.additionalData],
    [input.additionalData],
  ])
  expect(input.lock.release).toHaveBeenCalledOnce()
})

test('a failed native lock leaves userData and its journal untouched', async () => {
  const input = fixture()
  input.acquireLock.mockRejectedValueOnce(new Error('native lock unavailable'))

  await expect(initializeWorkbenchDesktopData(input.options)).rejects.toThrow(
    'native lock unavailable'
  )

  expect(fs.existsSync(input.source)).toBe(false)
  expect(fs.existsSync(input.desktop)).toBe(false)
  expect(input.app.requestSingleInstanceLock).not.toHaveBeenCalled()
})

test('an interrupted bridge recovers under the native lock before claiming the singleton', async () => {
  const input = fixture()
  fs.mkdirSync(input.source, { recursive: true })
  fs.writeFileSync(join(input.source, 'preferences.json'), 'original')
  vi.mocked(fs.symlinkSync).mockImplementation((target, path, type) => {
    if (path === input.source) throw new Error('bridge interrupted')
    return actual.symlinkSync(target, path, type)
  })

  await expect(initializeWorkbenchDesktopData(input.options)).rejects.toThrow('bridge interrupted')
  expect(input.singletonHeld()).toBe(false)
  expect(input.lock.release).toHaveBeenCalledOnce()
  expect(fs.existsSync(input.source)).toBe(false)
  vi.mocked(fs.symlinkSync).mockImplementation(actual.symlinkSync)
  const journalPath = join(input.desktop, 'migrations/desktop-user-data-v1.json')
  const journal = fs.readFileSync(journalPath, 'utf8')

  const result = await initializeWorkbenchDesktopData(input.options)

  expect(fs.readFileSync(join(result!.userData, 'preferences.json'), 'utf8')).toBe('original')
  expect(fs.readFileSync(journalPath, 'utf8')).toBe(journal)
  expect(fs.realpathSync(input.source)).toBe(result!.userData)
  expect(input.singletonHeld()).toBe(true)
})

test.each(['darwin', 'linux'] as const)(
  '%s retains its singleton throughout migration',
  async platform => {
    const input = fixture(platform)

    expect(await initializeWorkbenchDesktopData(input.options)).not.toBeNull()

    expect(input.acquireLock).not.toHaveBeenCalled()
    expect(input.app.releaseSingleInstanceLock).not.toHaveBeenCalled()
    expect(input.app.requestSingleInstanceLock).toHaveBeenCalledOnce()
    expect(input.singletonHeld()).toBe(true)
  }
)

test.each(['recreated-source', 'replaced-target', 'dangling-bridge', 'invalid-journal'])(
  'startup and restarts preserve user data with a %s updater cache',
  async state => {
    const input = fixture('darwin')
    const cache = {
      source: join(root, 'Library/Caches/com.weibo.wework-updater'),
      target: join(input.desktop, 'updater-cache'),
      journal: join(input.desktop, 'migrations/desktop-updater-cache-v1.json'),
    }
    fs.mkdirSync(cache.source, { recursive: true })
    fs.writeFileSync(join(cache.source, 'update.zip'), 'cached-update')
    migrateWorkbenchDataEntry(cache)
    if (state === 'recreated-source') {
      fs.unlinkSync(cache.source)
      fs.mkdirSync(cache.source)
    } else if (state === 'replaced-target' || state === 'dangling-bridge') {
      fs.renameSync(cache.target, `${cache.target}.backup`)
      if (state === 'replaced-target') fs.mkdirSync(cache.target)
    } else fs.writeFileSync(cache.journal, 'invalid JSON')
    const journal = fs.readFileSync(cache.journal, 'utf8')
    fs.mkdirSync(input.source, { recursive: true })
    fs.writeFileSync(join(input.source, 'preferences.json'), 'original-preferences')

    for (let launch = 0; launch < 2; launch++) {
      const result = await initializeWorkbenchDesktopData(input.options)

      expect(fs.readFileSync(join(result!.userData, 'preferences.json'), 'utf8')).toBe(
        'original-preferences'
      )
      expect(fs.readFileSync(cache.journal, 'utf8')).toBe(journal)
      expect(input.singletonHeld()).toBe(true)
      input.app.releaseSingleInstanceLock()
    }
  }
)

test('persistent user-data conflicts still stop startup', async () => {
  const input = fixture('darwin')
  const result = await initializeWorkbenchDesktopData(input.options)
  input.app.releaseSingleInstanceLock()
  fs.unlinkSync(input.source)
  fs.mkdirSync(input.source)
  fs.writeFileSync(join(input.source, 'preferences.json'), 'independent-preferences')

  await expect(initializeWorkbenchDesktopData(input.options)).rejects.toThrow(
    'Application data migration conflict'
  )

  expect(fs.readFileSync(join(input.source, 'preferences.json'), 'utf8')).toBe(
    'independent-preferences'
  )
  expect(fs.statSync(result!.userData).isDirectory()).toBe(true)
  expect(input.singletonHeld()).toBe(false)
})
