// @vitest-environment node

import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import { writeManagedAuthMarker } from '../electron/src/runtime/managed-auth-marker.ts'
import {
  captureSessionAuthOwnership,
  cleanupSessionAuth,
  observeSessionAuthOwnership,
  sessionExecutorHome,
} from './ai-verify-auth-cleanup.mjs'

const directories = []
const platforms = [...new Set([process.platform, 'win32'])]

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture(platform, override = false) {
  const directory = await mkdtemp(join(tmpdir(), 'wework-auth-cleanup-'))
  directories.push(directory)
  const session = {
    directory: join(directory, 'session'),
    ...(override ? { executorHomeOverride: join(directory, 'preserved-home') } : {}),
  }
  const nativeCodexHome = join(directory, 'native-codex')
  const source = join(nativeCodexHome, 'auth.json')
  const target = join(sessionExecutorHome(session), 'codex', 'auth.json')
  const marker = join(dirname(target), '.wework-managed-auth')
  await mkdir(nativeCodexHome, { recursive: true })
  await mkdir(dirname(target), { recursive: true })
  await writeFile(source, 'synthetic-native-account')
  return {
    session,
    source,
    target,
    marker,
    async capture() {
      session.authCleanup = await captureSessionAuthOwnership(session, {
        nativeCodexHome,
        platform,
      })
    },
    async createNativeAuth() {
      if (platform === 'win32') await copyFile(source, target)
      else await symlink(source, target)
      writeManagedAuthMarker(dirname(target), session.authCleanup?.ownerId)
    },
  }
}

async function createUserAlias(target, path) {
  // Windows native auth is copied; junctions cover foreign aliases without extra privileges.
  await symlink(target, path, process.platform === 'win32' ? 'junction' : 'file')
}

describe.each(platforms)('session auth ownership (%s)', platform => {
  test.each(['null', '[]', 'true', '"unknown"', '{'])(
    'preserves auth with malformed marker %s',
    async text => {
      const f = await fixture(platform, true)
      await f.capture()
      await f.createNativeAuth()
      await writeFile(f.marker, text)
      expect(await cleanupSessionAuth(f.session)).toBe(false)
      expect(await lstat(f.target)).toBeDefined()
    }
  )
  test('does not claim another session native marker', async () => {
    const f = await fixture(platform, true)
    await f.capture()
    await f.createNativeAuth()
    writeManagedAuthMarker(dirname(f.target), 'another-session-owner')
    expect(await cleanupSessionAuth(f.session)).toBe(false)
    expect(await lstat(f.target)).toBeDefined()
  })
  test('preserves a replacement made before the first observation', async () => {
    const f = await fixture(platform, true)
    await f.capture()
    await f.createNativeAuth()
    await rm(f.target)
    await writeFile(f.target, 'user-replacement-before-observe')
    expect(await cleanupSessionAuth(f.session)).toBe(false)
    expect(await readFile(f.target, 'utf8')).toBe('user-replacement-before-observe')
  })

  test('preserves a same-source entry replaced before the first observation', async () => {
    const f = await fixture(platform, true)
    await f.capture()
    await f.createNativeAuth()
    await rm(f.target)
    if (platform === 'win32') await copyFile(f.source, f.target)
    else await createUserAlias(f.source, f.target)
    expect(await cleanupSessionAuth(f.session)).toBe(false)
    if (platform === 'win32')
      expect(await readFile(f.target, 'utf8')).toBe('synthetic-native-account')
    else expect(await readlink(f.target)).toBe(f.source)
  })
  test.each([false, true])(
    'cleans a new managed entry in default/override home %s',
    async override => {
      const f = await fixture(platform, override)
      await f.capture()
      await f.createNativeAuth()
      expect(await observeSessionAuthOwnership(f.session)).toBe(true)
      const restored = JSON.parse(JSON.stringify(f.session))
      expect(await cleanupSessionAuth(restored)).toBe(true)
      await expect(lstat(f.target)).rejects.toMatchObject({ code: 'ENOENT' })
      await expect(lstat(f.marker)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(await readFile(f.source, 'utf8')).toBe('synthetic-native-account')
      expect(await cleanupSessionAuth(restored)).toBe(false)
    }
  )

  test('claims a fresh native entry when a stale marker remains from an older stop', async () => {
    const f = await fixture(platform, true)
    await writeFile(f.marker, '')
    await utimes(f.marker, new Date(1000), new Date(1000))
    await f.capture()
    expect(f.session.authCleanup.markerBefore).not.toBeNull()
    await f.createNativeAuth()
    expect(await cleanupSessionAuth(f.session)).toBe(true)
    await expect(lstat(f.target)).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await readFile(f.source, 'utf8')).toBe('synthetic-native-account')
  })

  test('cleans a new native entry even if startup failed before the first ready observation', async () => {
    const f = await fixture(platform, true)
    await f.capture()
    await f.createNativeAuth()
    expect(f.session.authCleanup.owned).toBeNull()
    expect(await cleanupSessionAuth(f.session)).toBe(true)
    expect(f.session.authCleanup.cleaned).toBe(true)
  })

  test('preserves pre-existing user auth even when a native marker is present', async () => {
    const f = await fixture(platform, true)
    await f.createNativeAuth()
    await f.capture()
    await writeFile(f.marker, '')
    expect(f.session.authCleanup.authExistedAtStart).toBe(true)
    expect(await cleanupSessionAuth(f.session)).toBe(false)
    expect((await lstat(f.target)).isFile() || (await lstat(f.target)).isSymbolicLink()).toBe(true)
  })

  test('preserves a user replacement after the native entry was observed', async () => {
    const f = await fixture(platform, true)
    await f.capture()
    await f.createNativeAuth()
    expect(await observeSessionAuthOwnership(f.session)).toBe(true)
    await rm(f.target)
    await writeFile(f.target, 'new-user-owned-replacement')
    expect(await cleanupSessionAuth(f.session)).toBe(false)
    expect(await readFile(f.target, 'utf8')).toBe('new-user-owned-replacement')
    expect(await readFile(f.source, 'utf8')).toBe('synthetic-native-account')
  })

  test('does not treat an unchanged stale marker as creation evidence', async () => {
    const f = await fixture(platform, true)
    await writeFile(f.marker, '')
    await f.capture()
    if (platform === 'win32') await copyFile(f.source, f.target)
    else await symlink(f.source, f.target)
    expect(await cleanupSessionAuth(f.session)).toBe(false)
    expect(await lstat(f.target)).toBeDefined()
  })
})

test('preserves a pre-existing dangling link by using lstat rather than following it', async () => {
  const f = await fixture(process.platform, true)
  const missing = join(dirname(f.source), 'missing-auth.json')
  await createUserAlias(missing, f.target)
  const original = await readlink(f.target)
  await f.capture()
  await writeFile(f.marker, '')
  expect(f.session.authCleanup.authExistedAtStart).toBe(true)
  expect(await cleanupSessionAuth(f.session)).toBe(false)
  expect(await readlink(f.target)).toBe(original)
})

test('preserves an unmarked newly added user file', async () => {
  const f = await fixture(process.platform, true)
  await f.capture()
  await writeFile(f.target, 'new-unmarked-user-auth')
  expect(await cleanupSessionAuth(f.session)).toBe(false)
  expect(await readFile(f.target, 'utf8')).toBe('new-unmarked-user-auth')
})

test('preserves a pre-existing regular user file in a native host home', async () => {
  const f = await fixture(process.platform, true)
  await writeFile(f.target, 'pre-existing-user-auth')
  await f.capture()
  await writeFile(f.marker, '')
  expect(await cleanupSessionAuth(f.session)).toBe(false)
  expect(await readFile(f.target, 'utf8')).toBe('pre-existing-user-auth')
})

test('preserves a newly created alias that does not target the selected native account', async () => {
  const f = await fixture(process.platform, true)
  await f.capture()
  const another = join(dirname(f.source), 'another-auth.json')
  await createUserAlias(another, f.target)
  const original = await readlink(f.target)
  await writeFile(f.marker, '')
  expect(await cleanupSessionAuth(f.session)).toBe(false)
  expect(await readlink(f.target)).toBe(original)
})

test('preserves a user alias replacing the observed native auth entry', async () => {
  const f = await fixture(process.platform, true)
  await f.capture()
  await f.createNativeAuth()
  expect(await observeSessionAuthOwnership(f.session)).toBe(true)
  await rm(f.target)
  await createUserAlias(process.platform === 'win32' ? dirname(f.source) : f.source, f.target)
  expect(await cleanupSessionAuth(f.session)).toBe(false)
  expect(await lstat(f.target)).toBeDefined()
})

test('rejects ownership metadata pointing outside the actual selected home', async () => {
  const f = await fixture(process.platform, true)
  await f.capture()
  await f.createNativeAuth()
  f.session.authCleanup.authPath = f.source
  expect(await cleanupSessionAuth(f.session)).toBe(false)
  expect(await readFile(f.source, 'utf8')).toBe('synthetic-native-account')
  expect(await lstat(f.target)).toBeDefined()
})

test('preserves a legacy override home without ownership evidence', async () => {
  const f = await fixture(process.platform, true)
  await f.createNativeAuth()
  expect(await cleanupSessionAuth(f.session)).toBe(false)
  expect(await lstat(f.target)).toBeDefined()
})

test('preserves older ownership protocols rather than guessing native ownership', async () => {
  const f = await fixture(process.platform, true)
  await f.capture()
  await f.createNativeAuth()
  f.session.authCleanup.version = 1
  expect(await cleanupSessionAuth(f.session)).toBe(false)
  expect(await lstat(f.target)).toBeDefined()
})

test('retains legacy cleanup for the session-owned default home', async () => {
  const f = await fixture(process.platform)
  await f.createNativeAuth()
  expect(await cleanupSessionAuth(f.session)).toBe(true)
  await expect(lstat(f.target)).rejects.toMatchObject({ code: 'ENOENT' })
  expect(await readFile(f.source, 'utf8')).toBe('synthetic-native-account')
})
