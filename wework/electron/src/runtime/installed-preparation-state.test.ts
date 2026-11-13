import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, expect, test } from 'vitest'

import {
  applyInstalledPreparation,
  inspectInstalledProfileSource,
  installedPreparationDirectory,
  installedPreparationMarkerFile,
  installedPreparationProfileRoot,
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

async function createFixture() {
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
  await symlink(activeProfile, pointer, process.platform === 'win32' ? 'junction' : 'dir')
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
  return { root, activeProfile, profileRoot }
}
