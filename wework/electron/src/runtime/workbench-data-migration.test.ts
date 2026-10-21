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

test('moves a directory once and preserves native internal, external and dangling aliases', () => {
  const options = entry()
  write(join(options.source, 'config.json'))
  write(join(root, 'external.txt'))
  if (process.platform === 'win32') {
    fs.linkSync(join(options.source, 'config.json'), join(options.source, 'internal'))
    fs.linkSync(join(root, 'external.txt'), join(options.source, 'external'))
    fs.symlinkSync(
      join(options.source, 'missing-cookie'),
      join(options.source, 'SingletonCookie'),
      'junction'
    )
  } else {
    fs.symlinkSync('config.json', join(options.source, 'internal'))
    fs.symlinkSync('../../external.txt', join(options.source, 'external'))
    fs.symlinkSync('missing-cookie', join(options.source, 'SingletonCookie'))
  }
  const inode = fs.statSync(options.source).ino
  migrateWorkbenchDataEntry(options)
  expect(fs.lstatSync(options.source).isSymbolicLink()).toBe(true)
  expect(fs.statSync(options.target).ino).toBe(inode)
  expect(fs.readFileSync(join(options.target, 'internal'), 'utf8')).toBe('fixture')
  if (process.platform === 'win32')
    expect(fs.statSync(join(options.target, 'external')).ino).toBe(
      fs.statSync(join(root, 'external.txt')).ino
    )
  else expect(fs.realpathSync(join(options.target, 'external'))).toBe(join(root, 'external.txt'))
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

test.each(['directory', 'file'])('device changes do not relax default %s recovery', type => {
  const options = entry()
  const path = type === 'directory' ? join(options.source, 'tasks.sqlite') : options.source
  write(path, 'original')
  migrateWorkbenchDataEntry(options)
  fs.unlinkSync(options.source)
  const journal = JSON.parse(fs.readFileSync(options.journal, 'utf8'))
  journal.device = (BigInt(journal.device) + 1n).toString()
  // An interrupted file migration must also retain its strict identity check.
  delete journal.completed
  fs.writeFileSync(options.journal, JSON.stringify(journal))
  const before = fs.readFileSync(options.journal, 'utf8')

  recoverWorkbenchDataBridge(options)
  if (type === 'file') recoverWorkbenchDataBridge(options, { allowDirectoryDeviceChange: true })

  expect(fs.existsSync(options.source)).toBe(false)
  expect(fs.readFileSync(options.journal, 'utf8')).toBe(before)
  expect(
    fs.readFileSync(
      type === 'directory' ? join(options.target, 'tasks.sqlite') : options.target,
      'utf8'
    )
  ).toBe('original')
})

test('empty-directory recovery rejects an ancestor alias into the migration target', () => {
  const options = entry()
  fs.mkdirSync(options.source, { recursive: true })
  migrateWorkbenchDataEntry(options)
  const identity = fs.statSync(options.target, { bigint: true }).ino
  const journal = fs.readFileSync(options.journal, 'utf8')
  fs.unlinkSync(options.source)
  fs.rmdirSync(join(root, 'old'))
  fs.symlinkSync(join(root, 'new'), join(root, 'old'), 'junction')

  expect(() => recoverWorkbenchDataBridge(options, { replaceEmptyDirectory: true })).toThrow(
    'disjoint'
  )

  expect(fs.statSync(options.target, { bigint: true }).ino).toBe(identity)
  expect(fs.readdirSync(options.target)).toEqual([])
  expect(fs.readFileSync(options.journal, 'utf8')).toBe(journal)
})

test('empty-directory recovery preserves a concurrent log write', () => {
  const options = entry()
  write(join(options.source, 'retained.log'), 'original')
  migrateWorkbenchDataEntry(options)
  fs.unlinkSync(options.source)
  fs.mkdirSync(options.source)
  const remove = vi.spyOn(fs, 'rmdirSync').mockImplementationOnce(path => {
    write(join(String(path), 'new.log'), 'concurrent')
    actual.rmdirSync(path)
  })
  try {
    expect(() => recoverWorkbenchDataBridge(options, { replaceEmptyDirectory: true })).toThrow()
    expect(fs.readFileSync(join(options.source, 'new.log'), 'utf8')).toBe('concurrent')
    expect(fs.readFileSync(join(options.target, 'retained.log'), 'utf8')).toBe('original')
  } finally {
    remove.mockRestore()
  }
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

test('migrates a regular file with native aliases without elevated link privileges', () => {
  const options = entry()
  write(options.source, 'original file')
  const identity = fs.statSync(options.source).ino
  migrateWorkbenchDataEntry(options)
  expect(fs.statSync(options.target).ino).toBe(identity)
  expect(fs.statSync(options.source).ino).toBe(identity)
  expect(fs.readFileSync(options.source, 'utf8')).toBe('original file')
  const journal = fs.readFileSync(options.journal, 'utf8')
  migrateWorkbenchDataEntry(options)
  expect(fs.readFileSync(options.journal, 'utf8')).toBe(journal)
})

test('refreshes a mutable file alias after an atomic configuration write', () => {
  const options = { ...entry(), mutableFile: true }
  write(options.source, 'original')
  migrateWorkbenchDataEntry(options)
  const replacement = join(root, 'replacement')
  write(replacement, 'updated')
  fs.renameSync(replacement, options.target)
  migrateWorkbenchDataEntry(options)
  expect(fs.readFileSync(options.source, 'utf8')).toBe('updated')
  expect(fs.statSync(options.source).ino).toBe(fs.statSync(options.target).ino)
  migrateWorkbenchDataEntry(options)
  expect(fs.readFileSync(options.target, 'utf8')).toBe('updated')
})

test('recovers initial file alias publication before the completion journal is written', () => {
  const options = entry()
  write(options.source, 'original')
  vi.mocked(fs.renameSync).mockImplementation((source, target) => {
    if (target === options.journal) throw Error('interrupted completion')
    return actual.renameSync(source, target)
  })
  expect(() => migrateWorkbenchDataEntry(options)).toThrow('interrupted completion')
  expect(fs.readFileSync(options.source, 'utf8')).toBe('original')
  vi.mocked(fs.renameSync).mockImplementation(actual.renameSync)
  recoverWorkbenchDataBridge(options)
  migrateWorkbenchDataEntry(options)
  expect(JSON.parse(fs.readFileSync(options.journal, 'utf8')).completed).toBe(true)
  expect(fs.statSync(options.source).ino).toBe(fs.statSync(options.target).ino)
})

test('recovers a mutable file refresh interrupted before alias publication', () => {
  const options = { ...entry(), mutableFile: true }
  write(options.source, 'original')
  migrateWorkbenchDataEntry(options)
  const replacement = join(root, 'replacement')
  write(replacement, 'updated')
  fs.renameSync(replacement, options.target)
  if (process.platform === 'win32') {
    vi.mocked(fs.renameSync).mockImplementation((source, target) => {
      if (target === options.source) throw Error('interrupted alias publication')
      return actual.renameSync(source, target)
    })
    expect(() => migrateWorkbenchDataEntry(options)).toThrow('interrupted alias publication')
    expect(fs.readFileSync(options.target, 'utf8')).toBe('updated')
    vi.mocked(fs.renameSync).mockImplementation(actual.renameSync)
  }
  recoverWorkbenchDataBridge(options)
  migrateWorkbenchDataEntry(options)
  expect(fs.readFileSync(options.source, 'utf8')).toBe('updated')
  expect(JSON.parse(fs.readFileSync(options.journal, 'utf8')).replacement).toBeUndefined()
})

test('rejects replacing an independently changed mutable source', () => {
  const options = { ...entry(), mutableFile: true }
  write(options.source, 'original')
  migrateWorkbenchDataEntry(options)
  fs.unlinkSync(options.source)
  write(options.source, 'independent')
  const replacement = join(root, 'replacement')
  write(replacement, 'updated')
  fs.renameSync(replacement, options.target)
  expect(() => migrateWorkbenchDataEntry(options)).toThrow('conflict')
  expect(fs.readFileSync(options.source, 'utf8')).toBe('independent')
  expect(fs.readFileSync(options.target, 'utf8')).toBe('updated')
})

test('rejects changing the destination during a journaled mutable alias refresh', () => {
  const options = { ...entry(), mutableFile: true }
  write(options.source, 'original')
  migrateWorkbenchDataEntry(options)
  const replacement = join(root, 'replacement')
  write(replacement, 'updated')
  fs.renameSync(replacement, options.target)
  if (process.platform === 'win32') {
    vi.mocked(fs.renameSync).mockImplementation((source, target) => {
      if (target === options.source) throw Error('interrupted alias publication')
      return actual.renameSync(source, target)
    })
    expect(() => migrateWorkbenchDataEntry(options)).toThrow('interrupted alias publication')
    vi.mocked(fs.renameSync).mockImplementation(actual.renameSync)
    write(replacement, 'independent destination')
    fs.renameSync(replacement, options.target)
    expect(() => migrateWorkbenchDataEntry(options)).toThrow('conflict')
    expect(fs.readFileSync(options.source, 'utf8')).toBe('original')
    expect(fs.readFileSync(options.target, 'utf8')).toBe('independent destination')
  } else {
    migrateWorkbenchDataEntry(options)
    expect(fs.readFileSync(options.source, 'utf8')).toBe('updated')
  }
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
    const physical = process.platform === 'win32' && path.startsWith('data/') ? target : source
    expect(fs.realpathSync(join(source, path))).toBe(join(physical, path))
    expect(fs.statSync(join(source, path)).ino).toBe(historical[index])
    if (process.platform === 'win32' && fs.lstatSync(join(target, path)).isFile())
      expect(fs.statSync(join(target, path)).ino).toBe(historical[index])
    else expect(fs.realpathSync(join(target, path))).toBe(join(physical, path))
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
    expect(fs.existsSync(join(source, path))).toBe(
      process.platform === 'win32' && path.startsWith('data/')
    )
    expect(fs.realpathSync(join(target, path))).toBe(join(target, path))
  }
  migrateWorkbenchExecutorData(source, target, state)
})

test('recreates a completed file bridge after SQLite removes both sidecar entries', () => {
  const options = {
    ...entry(),
    source: join(root, 'old/tasks.sqlite-wal'),
    target: join(root, 'new/tasks.sqlite-wal'),
    mutableFile: true,
  }
  write(options.source)
  migrateWorkbenchDataEntry(options)
  fs.unlinkSync(options.source)
  fs.unlinkSync(options.target)
  migrateWorkbenchDataEntry(options)
  if (process.platform === 'win32') expect(fs.existsSync(options.source)).toBe(false)
  else expect(fs.readlinkSync(options.source)).toBe(options.target)
  write(options.target, 'new WAL')
  migrateWorkbenchDataEntry(options)
  expect(fs.readFileSync(options.source, 'utf8')).toBe('new WAL')
  fs.unlinkSync(options.source)
  write(options.source, 'unmanaged')
  expect(() => migrateWorkbenchDataEntry(options)).toThrow('conflict')
})

function completedHardLink() {
  const options = {
    ...entry(),
    source: join(root, 'old/app-ipc.addr'),
    target: join(root, 'new/app-ipc.addr'),
  }
  write(options.target, 'original')
  fs.mkdirSync(join(options.source, '..'), { recursive: true })
  fs.linkSync(options.target, options.source)
  const identity = fs.statSync(options.target, { bigint: true })
  const journal = {
    ...options,
    version: 1,
    device: identity.dev.toString(),
    inode: identity.ino.toString(),
    directory: false,
    completed: true,
  }
  write(options.journal, JSON.stringify(journal))
  return { options, journal }
}

test('restarts a completed hard-link migration without changing either alias or its journal', () => {
  const { options } = completedHardLink()
  const journal = fs.readFileSync(options.journal, 'utf8')
  vi.mocked(fs.symlinkSync)
    .mockClear()
    .mockImplementation(() => {
      throw Object.assign(new Error('symlink privilege unavailable'), { code: 'EPERM' })
    })
  migrateWorkbenchDataEntry(options)
  migrateWorkbenchDataEntry(options)
  expect(fs.readFileSync(options.journal, 'utf8')).toBe(journal)
  expect(fs.statSync(options.source).ino).toBe(fs.statSync(options.target).ino)
  expect(fs.readFileSync(options.source, 'utf8')).toBe('original')
  expect(fs.symlinkSync).not.toHaveBeenCalled()
})

test.each(['source', 'target'] as const)(
  'rejects a completed hard-link migration after replacing the %s file',
  side => {
    const { options } = completedHardLink()
    fs.unlinkSync(options[side])
    write(options[side], 'replacement')
    expect(() => migrateWorkbenchDataEntry(options)).toThrow('conflict')
    expect(fs.readFileSync(options[side], 'utf8')).toBe('replacement')
    expect(fs.readFileSync(options[side === 'source' ? 'target' : 'source'], 'utf8')).toBe(
      'original'
    )
  }
)

test.each(['missing', 'incomplete', 'different-identity'])(
  'rejects a completed hard-link pair with a %s journal',
  state => {
    const { options, journal } = completedHardLink()
    if (state === 'missing') fs.unlinkSync(options.journal)
    else {
      const value =
        state === 'incomplete'
          ? { ...journal, completed: undefined }
          : { ...journal, inode: (BigInt(journal.inode) + 1n).toString() }
      fs.writeFileSync(options.journal, JSON.stringify(value))
    }
    expect(() => migrateWorkbenchDataEntry(options)).toThrow('conflict')
    expect(fs.readFileSync(options.source, 'utf8')).toBe('original')
    expect(fs.readFileSync(options.target, 'utf8')).toBe('original')
  }
)

test('moves browser partitions, preferences and logs before stores open', () => {
  const source = join(root, 'appData/app')
  const desktop = join(root, 'workbench/wework/app')
  const logs = join(root, 'logs/app')
  for (const path of [
    join(source, 'Partitions/browser/Cookies'),
    join(source, 'preferences.json'),
    join(logs, 'app.log'),
  ])
    write(path)
  prepareDesktopDataSource(source, desktop)
  const result = migrateWorkbenchDesktopData({ source, desktop, logs })
  expect(result.userData).toBe(join(desktop, 'user-data'))
  expect(fs.readFileSync(join(result.userData, 'Partitions/browser/Cookies'), 'utf8')).toBe(
    'fixture'
  )
  prepareDesktopDataSource(source, desktop)
  expect(migrateWorkbenchDesktopData({ source, desktop, logs })).toEqual(result)
})

test('new installs and interrupted userData bridge publication restart safely', () => {
  const source = join(root, 'appData/app')
  const desktop = join(root, 'workbench/app')
  const options = { source, desktop, logs: join(root, 'logs') }
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
