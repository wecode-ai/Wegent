import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { afterEach, expect, test } from 'vitest'

import {
  applyInstalledPreparation,
  inspectInstalledProfileSource,
  installedPreparationDirectory,
  installedPreparationMarkerFile,
  installedPreparationProfileRoot,
  installedPreparationSwitchFile,
  recoverInstalledPreparationSwitch,
  writeInstalledPreparationMarker,
} from './installed-preparation-state.js'
import { currentCoreProfile, profileRevision } from './release-profile.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

test('atomically selects a matching prepared profile and preserves the source release profile', async () => {
  const fixture = await createFixture()
  const sourceBefore = await readFile(join(fixture.activeProfile, 'plugin.js'), 'utf8')

  await expect(
    applyInstalledPreparation({
      dataDirectory: fixture.root,
      version: '1.2.3',
      releaseTransactionInProgress: false,
    })
  ).resolves.toEqual({ applied: true, reason: 'applied' })

  expect(await realpath(currentCoreProfile(fixture.root))).toBe(await realpath(fixture.profileRoot))
  expect(await readFile(join(fixture.activeProfile, 'plugin.js'), 'utf8')).toBe(sourceBefore)
  await expect(lstat(installedPreparationMarkerFile(fixture.root, '1.2.3'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
})

test('keeps the active profile and marker when its revision changed after preparation', async () => {
  const fixture = await createFixture()
  await writeFile(join(fixture.activeProfile, 'package.json'), '{"version":"changed"}\n')

  await expect(
    applyInstalledPreparation({
      dataDirectory: fixture.root,
      version: '1.2.3',
      releaseTransactionInProgress: false,
    })
  ).resolves.toEqual({ applied: false, reason: 'source-changed' })
  expect(await realpath(currentCoreProfile(fixture.root))).toBe(
    await realpath(fixture.activeProfile)
  )
  await expect(lstat(installedPreparationMarkerFile(fixture.root, '1.2.3'))).resolves.toBeDefined()
})

test('does not apply preparation while a release transaction is active', async () => {
  const fixture = await createFixture()

  await expect(
    applyInstalledPreparation({
      dataDirectory: fixture.root,
      version: '1.2.3',
      releaseTransactionInProgress: true,
    })
  ).resolves.toEqual({ applied: false, reason: 'release-transaction' })
  expect(await realpath(currentCoreProfile(fixture.root))).toBe(
    await realpath(fixture.activeProfile)
  )
})

test('restores the source pointer when profile switching fails', async () => {
  const fixture = await createFixture()
  const pointer = currentCoreProfile(fixture.root)

  await expect(
    applyInstalledPreparation({
      dataDirectory: fixture.root,
      version: '1.2.3',
      releaseTransactionInProgress: false,
      switchProfile: async () => {
        await rm(pointer, { force: true })
        throw new Error('switch failed')
      },
    })
  ).rejects.toThrow('switch failed')

  expect(await realpath(pointer)).toBe(await realpath(fixture.activeProfile))
  await expect(lstat(installedPreparationMarkerFile(fixture.root, '1.2.3'))).resolves.toBeDefined()
  await expect(lstat(installedPreparationSwitchFile(fixture.root, '1.2.3'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
  await expect(
    applyInstalledPreparation({
      dataDirectory: fixture.root,
      version: '1.2.3',
      releaseTransactionInProgress: false,
    })
  ).resolves.toEqual({ applied: true, reason: 'applied' })
})

test('recovers an interrupted physical profile switch before applying again', async () => {
  const fixture = await createFixture('directory')
  const pointer = currentCoreProfile(fixture.root)
  const preparationDirectory = installedPreparationDirectory(fixture.root, '1.2.3')
  const token = '7cbbdce1-c1ca-4e50-b3ca-fbf0a282f0a5'
  const baseline = join(preparationDirectory, 'previous-profiles', token)
  await mkdir(dirname(baseline), { recursive: true })
  await rename(pointer, baseline)
  const marker = JSON.parse(
    await readFile(installedPreparationMarkerFile(fixture.root, '1.2.3'), 'utf8')
  )
  await writeFile(
    installedPreparationSwitchFile(fixture.root, '1.2.3'),
    JSON.stringify({
      schemaVersion: 1,
      pointer,
      profileRoot: fixture.profileRoot,
      baseline,
      previous: marker.source,
    })
  )

  await expect(
    applyInstalledPreparation({
      dataDirectory: fixture.root,
      version: '1.2.3',
      releaseTransactionInProgress: false,
    })
  ).resolves.toEqual({ applied: true, reason: 'applied' })
  expect(await realpath(pointer)).toBe(await realpath(fixture.profileRoot))
  expect(await readFile(join(baseline, 'plugin.js'), 'utf8')).toBe('active plugin\n')
})

test('reinstalling resolves an interrupted switch before replacing its marker', async () => {
  const fixture = await createFixture('directory')
  const pointer = currentCoreProfile(fixture.root)
  const preparationDirectory = installedPreparationDirectory(fixture.root, '1.2.3')
  const token = '7cbbdce1-c1ca-4e50-b3ca-fbf0a282f0a5'
  const baseline = join(preparationDirectory, 'previous-profiles', token)
  await mkdir(dirname(baseline), { recursive: true })
  await rename(pointer, baseline)
  const marker = JSON.parse(
    await readFile(installedPreparationMarkerFile(fixture.root, '1.2.3'), 'utf8')
  )
  await writeFile(
    installedPreparationSwitchFile(fixture.root, '1.2.3'),
    JSON.stringify({
      schemaVersion: 1,
      pointer,
      profileRoot: fixture.profileRoot,
      baseline,
      previous: marker.source,
    })
  )

  await recoverInstalledPreparationSwitch(fixture.root, '1.2.3')

  expect(await realpath(pointer)).toBe(await realpath(fixture.activeProfile))
  await expect(lstat(installedPreparationSwitchFile(fixture.root, '1.2.3'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
  await expect(
    applyInstalledPreparation({
      dataDirectory: fixture.root,
      version: '1.2.3',
      releaseTransactionInProgress: false,
    })
  ).resolves.toEqual({ applied: true, reason: 'applied' })
  expect(await realpath(pointer)).toBe(await realpath(fixture.profileRoot))
})

async function createFixture(pointerKind: 'directory' | 'symbolicLink' = 'symbolicLink') {
  const root = await mkdtemp(join(tmpdir(), 'wework-installed-state-'))
  roots.push(root)
  const activeProfile = join(root, 'releases', 'active', 'profile')
  const profileRoot = installedPreparationProfileRoot(root, '1.2.3')
  await Promise.all([
    mkdir(activeProfile, { recursive: true }),
    mkdir(profileRoot, { recursive: true }),
  ])
  await Promise.all([
    writeFile(join(activeProfile, 'package.json'), '{"version":"active"}\n'),
    writeFile(join(activeProfile, 'plugin.js'), 'active plugin\n'),
    writeFile(join(profileRoot, 'package.json'), '{"version":"prepared"}\n'),
    writeFile(join(profileRoot, 'plugin.js'), 'prepared plugin\n'),
  ])
  const pointer = currentCoreProfile(root)
  await mkdir(join(pointer, '..'), { recursive: true })
  if (pointerKind === 'directory') {
    await mkdir(pointer, { recursive: true })
    await Promise.all([
      writeFile(join(pointer, 'package.json'), '{"version":"active"}\n'),
      writeFile(join(pointer, 'plugin.js'), 'active plugin\n'),
    ])
  } else {
    await symlink(activeProfile, pointer, process.platform === 'win32' ? 'junction' : 'dir')
  }
  const source = await inspectInstalledProfileSource(pointer)
  await mkdir(installedPreparationDirectory(root, '1.2.3'), { recursive: true })
  await writeInstalledPreparationMarker(root, {
    schemaVersion: 1,
    token: '7cbbdce1-c1ca-4e50-b3ca-fbf0a282f0a5',
    version: '1.2.3',
    preparationDirectory: installedPreparationDirectory(root, '1.2.3'),
    profileRoot,
    preparedRevision: await profileRevision(profileRoot),
    source,
    reusedPreparedProfile: false,
  })
  return { root, activeProfile: pointerKind === 'directory' ? pointer : activeProfile, profileRoot }
}
