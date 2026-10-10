import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import {
  migrateWorkbenchDataEntry,
  recoverWorkbenchDataBridge,
} from './workbench-data-migration.js'
import { migrateWorkbenchExecutorData } from './workbench-executor-data.js'
import {
  migrateWorkbenchDesktopData,
  prepareDesktopDataSource,
  migrateDesktopControlRegistry,
  packagedUpdaterCache,
} from './workbench-desktop-data.js'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, renameSync: vi.fn(actual.renameSync), symlinkSync: vi.fn(actual.symlinkSync) }
})
const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
let root: string
beforeEach(() => {
  vi.mocked(fs.renameSync).mockImplementation(actual.renameSync)
  vi.mocked(fs.symlinkSync).mockImplementation(actual.symlinkSync)
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'workbench-data-')))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function write(path: string, value = 'fixture') {
  fs.mkdirSync(join(path, '..'), { recursive: true })
  fs.writeFileSync(path, value)
}
function entry() {
  return {
    source: join(root, 'old/data'),
    target: join(root, 'new/data'),
    journal: join(root, 'new/migrations/data.json'),
  }
}

test('moves a directory once and preserves internal, external and dangling links', () => {
  const options = entry()
  write(join(options.source, 'config.json'))
  write(join(root, 'external.txt'))
  fs.symlinkSync('config.json', join(options.source, 'internal'))
  fs.symlinkSync('../../external.txt', join(options.source, 'external'))
  fs.symlinkSync('missing-cookie', join(options.source, 'SingletonCookie'))
  const inode = fs.statSync(options.source).ino
  migrateWorkbenchDataEntry(options)
  expect(fs.lstatSync(options.source).isSymbolicLink()).toBe(true)
  expect(fs.statSync(options.target).ino).toBe(inode)
  expect(fs.readFileSync(join(options.target, 'internal'), 'utf8')).toBe('fixture')
  expect(fs.realpathSync(join(options.target, 'external'))).toBe(join(root, 'external.txt'))
  const journal = fs.statSync(options.journal)
  migrateWorkbenchDataEntry(options)
  expect(fs.statSync(options.journal).mtimeMs).toBe(journal.mtimeMs)
})

test.each(['rename', 'bridge'])('recovers an interrupted %s without a second copy', stage => {
  const options = entry()
  write(join(options.source, 'tasks.sqlite'), 'original')
  if (stage === 'rename')
    vi.mocked(fs.renameSync).mockImplementationOnce(() => {
      throw Error('interrupted')
    })
  else
    vi.mocked(fs.symlinkSync).mockImplementation((target, path, type) => {
      if (path === options.source) throw Error('interrupted')
      return actual.symlinkSync(target, path, type)
    })
  expect(() => migrateWorkbenchDataEntry(options)).toThrow('interrupted')
  vi.mocked(fs.renameSync).mockImplementation(actual.renameSync)
  vi.mocked(fs.symlinkSync).mockImplementation(actual.symlinkSync)
  recoverWorkbenchDataBridge(options)
  migrateWorkbenchDataEntry(options)
  expect(fs.readFileSync(join(options.target, 'tasks.sqlite'), 'utf8')).toBe('original')
  expect(fs.realpathSync(options.source)).toBe(options.target)
})

test('accepts a completed directory bridge after the device number changes', () => {
  const options = entry()
  write(join(options.source, 'tasks.sqlite'), 'original')
  migrateWorkbenchDataEntry(options)
  const journal = JSON.parse(fs.readFileSync(options.journal, 'utf8'))
  journal.device = (BigInt(journal.device) + 1n).toString()
  fs.writeFileSync(options.journal, JSON.stringify(journal))
  const before = fs.readFileSync(options.journal, 'utf8')
  migrateWorkbenchDataEntry(options)
  expect(fs.readFileSync(options.journal, 'utf8')).toBe(before)
  expect(fs.realpathSync(options.source)).toBe(options.target)
  expect(fs.readFileSync(join(options.target, 'tasks.sqlite'), 'utf8')).toBe('original')
})

test.each(['replacement', 'redirect'])('rejects a completed bridge with a %s directory', change => {
  const options = entry()
  write(join(options.source, 'tasks.sqlite'), 'original')
  migrateWorkbenchDataEntry(options)
  const other = join(root, 'other')
  if (change === 'replacement') {
    fs.renameSync(options.target, other)
    write(join(options.target, 'tasks.sqlite'), 'unrelated')
  } else {
    write(join(other, 'tasks.sqlite'), 'unrelated')
    fs.unlinkSync(options.source)
    fs.symlinkSync(other, options.source, 'junction')
  }
  expect(() => migrateWorkbenchDataEntry(options)).toThrow('conflict')
  expect(fs.readFileSync(join(other, 'tasks.sqlite'), 'utf8')).toBe(
    change === 'replacement' ? 'original' : 'unrelated'
  )
})

test('refuses to merge two existing directories', () => {
  const options = entry()
  write(join(options.source, 'keep'), 'old')
  write(join(options.target, 'keep'), 'new')
  expect(() => migrateWorkbenchDataEntry(options)).toThrow('conflict')
  expect(fs.readFileSync(join(options.source, 'keep'), 'utf8')).toBe('old')
  expect(fs.readFileSync(join(options.target, 'keep'), 'utf8')).toBe('new')
})

test('migrates a real WAL database and credentials; historical artifacts stay in place', () => {
  const source = join(root, 'old')
  const target = join(root, 'new')
  const state = join(target, 'migrations')
  const preparation = join(root, 'seed.sqlite')
  const seed = new DatabaseSync(preparation)
  seed.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE tasks(id TEXT); INSERT INTO tasks VALUES ('old-task')"
  )
  fs.mkdirSync(join(source, 'data'), { recursive: true })
  for (const suffix of ['', '-wal', '-shm'])
    fs.copyFileSync(preparation + suffix, join(source, 'data/tasks.sqlite') + suffix)
  seed.close()
  const paths = [
    'workspace/worktrees/task/repo/file',
    'workspace/attachments/runtime/task/turn/image',
    'workspace/attachments/draft/upload/image',
    'data/cache/gitlab-attachments/task/attachment/image',
    'data/objects/attachments/attachment/image',
  ]
  for (const path of [
    ...paths,
    'workspace/projects/repo/file',
    'credentials/master.key',
    'device-config.json',
  ])
    write(join(source, path))
  const historical = paths.map(path => fs.statSync(join(source, path)).ino)
  migrateWorkbenchExecutorData(source, target, state)
  const db = new DatabaseSync(join(target, 'data/tasks.sqlite'))
  expect(db.prepare('SELECT id FROM tasks').get()?.id).toBe('old-task')
  db.exec("INSERT INTO tasks VALUES ('new-task')")
  db.close()
  const viaLegacy = new DatabaseSync(join(source, 'data/tasks.sqlite'))
  expect(viaLegacy.prepare('SELECT count(*) AS total FROM tasks').get()?.total).toBe(2)
  viaLegacy.close()
  expect(fs.readFileSync(join(target, 'credentials/master.key'), 'utf8')).toBe('fixture')
  for (const [index, path] of paths.entries()) {
    expect(fs.realpathSync(join(source, path))).toBe(join(source, path))
    expect(fs.statSync(join(source, path)).ino).toBe(historical[index])
    expect(fs.realpathSync(join(target, path))).toBe(join(source, path))
  }
  expect(fs.realpathSync(join(source, 'workspace/projects'))).toBe(
    join(target, 'workspace/projects')
  )
  for (const path of [
    'workspace/attachments/runtime/new-task/turn/image',
    'workspace/attachments/draft/new-upload/image',
    'data/objects/attachments/new-id/image',
  ]) {
    write(join(target, path), 'new attachment')
    expect(fs.existsSync(join(source, path))).toBe(false)
    expect(fs.realpathSync(join(target, path))).toBe(join(target, path))
  }
  migrateWorkbenchExecutorData(source, target, state)
})

test('moves browser partitions, preferences, logs and updater cache before stores open', () => {
  const source = join(root, 'appData/app')
  const desktop = join(root, 'workbench/wework/app')
  const logs = join(root, 'logs/app')
  const updaterCache = join(root, 'cache/updater')
  for (const path of [
    join(source, 'Partitions/browser/Cookies'),
    join(source, 'preferences.json'),
    join(logs, 'app.log'),
    join(updaterCache, 'pending/update.zip'),
  ])
    write(path)
  prepareDesktopDataSource(source, desktop)
  const result = migrateWorkbenchDesktopData({ source, desktop, logs, updaterCache })
  expect(result.userData).toBe(join(desktop, 'user-data'))
  expect(fs.readFileSync(join(result.userData, 'Partitions/browser/Cookies'), 'utf8')).toBe(
    'fixture'
  )
  expect(fs.realpathSync(updaterCache)).toBe(join(desktop, 'updater-cache'))
  prepareDesktopDataSource(source, desktop)
  expect(migrateWorkbenchDesktopData({ source, desktop, logs, updaterCache })).toEqual(result)
})

test('branded packages reuse the configured updater cache and its existing migration journal', () => {
  const resources = join(root, 'Resources')
  write(join(resources, 'app-update.yml'), 'updaterCacheDirName: "@fixtureexecutor-updater"\n')
  const updaterCache = join(root, 'Library/Caches/@fixtureexecutor-updater')
  const options = {
    source: join(root, 'appData/branded.app'),
    desktop: join(root, 'workbench/branded.app'),
    logs: join(root, 'Library/Logs/Branded App'),
    updaterCache,
  }
  write(join(updaterCache, 'pending/update.zip'))
  prepareDesktopDataSource(options.source, options.desktop)
  migrateWorkbenchDesktopData(options)
  const journalPath = join(options.desktop, 'migrations/desktop-updater-cache-v1.json')
  const journal = fs.readFileSync(journalPath, 'utf8')
  const configuredCache = packagedUpdaterCache(root, resources, {}, 'darwin')
  expect(configuredCache).toBe(updaterCache)
  migrateWorkbenchDesktopData({ ...options, updaterCache: configuredCache })
  expect(fs.readFileSync(journalPath, 'utf8')).toBe(journal)
  expect(fs.readFileSync(join(configuredCache, 'pending/update.zip'), 'utf8')).toBe('fixture')
})

test.each(['../other', '/absolute', '..', ''])('rejects unsafe configured cache path %j', name => {
  const resources = join(root, 'Resources')
  write(join(resources, 'app-update.yml'), `updaterCacheDirName: ${JSON.stringify(name)}\n`)
  expect(() => packagedUpdaterCache(root, resources, {}, 'darwin')).toThrow('Invalid updater cache')
})

test('new installs and interrupted userData bridge publication restart safely', () => {
  const source = join(root, 'appData/app')
  const desktop = join(root, 'workbench/app')
  const options = { source, desktop, logs: join(root, 'logs'), updaterCache: join(root, 'cache') }
  prepareDesktopDataSource(source, desktop)
  vi.mocked(fs.symlinkSync).mockImplementation((target, path, type) => {
    if (path === source) throw Error('interrupted')
    return actual.symlinkSync(target, path, type)
  })
  expect(() => migrateWorkbenchDesktopData(options)).toThrow('interrupted')
  vi.mocked(fs.symlinkSync).mockImplementation(actual.symlinkSync)
  prepareDesktopDataSource(source, desktop)
  expect(fs.lstatSync(source).isSymbolicLink()).toBe(true)
  migrateWorkbenchDesktopData(options)
})

test('moves the desktop registry while retaining access for installed CLI clients', () => {
  const home = join(root, 'home')
  const shared = join(home, '.wegent/workbench/shared')
  const legacy = join(home, '.wework/runtime/desktop-instances')
  write(join(legacy, 'instance.json'), '{"instanceId":"synthetic"}')
  migrateDesktopControlRegistry(home, shared)
  expect(fs.realpathSync(legacy)).toBe(join(shared, 'desktop-instances'))
  migrateDesktopControlRegistry(home, shared)
})
