import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'

import { packagedUpdaterCache, restoreNativeUpdaterCache } from './app-update-cache.js'

vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, unlinkSync: vi.fn(actual.unlinkSync) }
})
const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
let root: string
beforeEach(() => {
  vi.mocked(fs.unlinkSync).mockImplementation(actual.unlinkSync)
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'app-update-cache-')))
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const desktop = join(root, 'workbench/branded.app')
  const cache = join(root, 'Library/Caches/@fixtureexecutor-updater')
  const target = join(desktop, 'updater-cache')
  fs.mkdirSync(dirname(cache), { recursive: true })
  fs.mkdirSync(target, { recursive: true })
  fs.writeFileSync(join(target, 'update.zip'), 'retained-update')
  return { desktop, cache, target }
}

test.each(['absolute', 'relative', 'dangling', 'replaced-target'])(
  'retires an %s legacy bridge and lets the updater recreate its cache',
  state => {
    const { desktop, cache, target } = fixture()
    const link =
      state === 'relative'
        ? relative(process.platform === 'win32' ? process.cwd() : dirname(cache), target)
        : target
    fs.symlinkSync(link, cache, process.platform === 'win32' ? 'junction' : 'dir')
    if (state === 'dangling' || state === 'replaced-target') {
      fs.renameSync(target, `${target}.backup`)
      if (state === 'replaced-target') fs.mkdirSync(target)
    }

    expect(restoreNativeUpdaterCache(cache, desktop)).toBe(true)

    expect(fs.existsSync(cache)).toBe(false)
    expect(
      fs.readFileSync(
        join(
          state === 'dangling' || state === 'replaced-target' ? `${target}.backup` : target,
          'update.zip'
        ),
        'utf8'
      )
    ).toBe('retained-update')
    fs.mkdirSync(join(cache, 'pending'), { recursive: true })
    fs.writeFileSync(join(cache, 'pending/update.zip'), 'new-update')
    expect(restoreNativeUpdaterCache(cache, desktop)).toBe(false)
    expect(fs.readFileSync(join(cache, 'pending/update.zip'), 'utf8')).toBe('new-update')
  }
)

test('missing native caches are left for the updater to create', () => {
  const { desktop, cache } = fixture()

  expect(restoreNativeUpdaterCache(cache, desktop)).toBe(false)
  expect(fs.existsSync(cache)).toBe(false)
})

test('native cache deletion and recreation needs no migration state', () => {
  const { desktop, cache } = fixture()
  for (let download = 0; download < 2; download++) {
    expect(restoreNativeUpdaterCache(cache, desktop)).toBe(false)
    fs.mkdirSync(join(cache, 'pending'), { recursive: true })
    fs.writeFileSync(join(cache, 'pending/update.zip'), 'new-update')
    expect(fs.lstatSync(cache).isDirectory()).toBe(true)
    fs.rmSync(cache, { recursive: true })
  }
  expect(fs.existsSync(join(desktop, 'migrations'))).toBe(false)
})

test('unrelated symlinks and their data are preserved', () => {
  const { desktop, cache, target } = fixture()
  const external = join(root, 'external')
  fs.renameSync(target, external)
  fs.symlinkSync(external, cache, process.platform === 'win32' ? 'junction' : 'dir')

  expect(restoreNativeUpdaterCache(cache, desktop)).toBe(false)

  expect(fs.realpathSync(cache)).toBe(external)
  expect(fs.readFileSync(join(external, 'update.zip'), 'utf8')).toBe('retained-update')
})

test('a file at the cache path is never deleted', () => {
  const { desktop, cache } = fixture()
  fs.writeFileSync(cache, 'independent-file')

  expect(restoreNativeUpdaterCache(cache, desktop)).toBe(false)
  expect(fs.readFileSync(cache, 'utf8')).toBe('independent-file')
})

test('filesystem errors reach the update operation', () => {
  const { desktop, cache, target } = fixture()
  fs.symlinkSync(target, cache, process.platform === 'win32' ? 'junction' : 'dir')
  const error = Object.assign(new Error('cache permission denied'), { code: 'EACCES' })
  vi.mocked(fs.unlinkSync).mockImplementationOnce(() => {
    throw error
  })

  expect(() => restoreNativeUpdaterCache(cache, desktop)).toThrow(error)
  expect(fs.realpathSync(cache)).toBe(target)
})

test.each([
  ['darwin', {}, 'Library/Caches'],
  ['win32', {}, 'AppData/Local'],
  ['linux', {}, '.cache'],
  ['win32', { LOCALAPPDATA: '/custom-local' }, '/custom-local'],
  ['linux', { XDG_CACHE_HOME: '/custom-cache' }, '/custom-cache'],
] as const)('resolves the branded updater cache on %s with %j', (platform, environment, base) => {
  const resources = join(root, 'Resources')
  fs.mkdirSync(resources)
  fs.writeFileSync(
    join(resources, 'app-update.yml'),
    'updaterCacheDirName: "@fixtureexecutor-updater"\n'
  )

  expect(packagedUpdaterCache(root, resources, environment, platform)).toBe(
    join(base.startsWith('/') ? base : join(root, base), '@fixtureexecutor-updater')
  )
})

test.each(['../other', '/absolute', '..', ''])('rejects unsafe configured cache path %j', name => {
  const resources = join(root, 'Resources')
  fs.mkdirSync(resources)
  fs.writeFileSync(
    join(resources, 'app-update.yml'),
    `updaterCacheDirName: ${JSON.stringify(name)}\n`
  )

  expect(() => packagedUpdaterCache(root, resources, {}, 'darwin')).toThrow('Invalid updater cache')
})
