import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { ReleaseStore, type DesktopRelease } from './release-store.js'
import { currentCoreProfile } from './release-profile.js'
import { settleReleaseBeforeStartup } from './release-startup-recovery.js'
import {
  acknowledgeWindowsInstallation,
  pendingWindowsInstallation,
  prepareWindowsInstallationProfile,
  windowsInstallationId,
} from './windows-release-installation.js'

const roots: string[] = []
const token = '134000000000012345'

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wework-windows-install-'))
  roots.push(root)
  const store = new ReleaseStore(join(root, 'releases'))
  const executable = join(root, 'installed with spaces', 'Wework.exe')
  await mkdir(dirname(executable))
  const marker = join(dirname(executable), 'wework-installed-release')
  return { root, store, executable, marker }
}

test('the installer entry takes over once per installation and ignores markers in other versions', async () => {
  const { store, executable, marker } = await fixture()
  await writeFile(marker, `0.6.7\n${token}`)
  await expect(pendingWindowsInstallation(store, executable, '0.6.7', 'win32')).resolves.toBe(token)
  await expect(pendingWindowsInstallation(store, executable, '0.6.6', 'win32')).resolves.toBeNull()
  await acknowledgeWindowsInstallation(store, token)
  await expect(pendingWindowsInstallation(store, executable, '0.6.7', 'win32')).resolves.toBeNull()
  await writeFile(marker, '0.6.8\n134000000000012346')
  await expect(pendingWindowsInstallation(store, executable, '0.6.8', 'win32')).resolves.toBe(
    '134000000000012346'
  )
})

test('settles an unstarted update, then stages a copy of the healthy profile for the installer', async () => {
  const { root, store, executable } = await fixture()
  const source: DesktopRelease = {
    id: 'source',
    version: '0.6.5',
    executable,
    resources: join(root, 'resources'),
    runtimeRoot: join(root, 'runtime'),
    profileRoot: currentCoreProfile(root),
    dataSchema: 1,
    readableDataSchemas: [1],
    schemaVersion: 1,
  }
  const target = { ...source, id: 'target', version: '0.6.6' }
  await mkdir(source.profileRoot, { recursive: true })
  await writeFile(join(source.profileRoot, 'package.json'), '{"name":"preserved-profile"}')
  await store.save(source)
  await store.save(target)
  await writeFile(join(store.root, 'active'), source.id)
  await store.activate(target, 'snapshot')
  const confirmRestore = vi.fn(async () => false)
  await expect(settleReleaseBeforeStartup(store, root, confirmRestore, true)).resolves.toBe(true)
  expect(confirmRestore).not.toHaveBeenCalled()
  await expect(store.activation()).resolves.toBeNull()
  await expect(store.active()).resolves.toMatchObject({ id: source.id })
  const installed = windowsInstallationId('0.6.7', token)
  await prepareWindowsInstallationProfile(store, root, installed)
  const profile = join(store.slot(installed), 'profile')
  expect(await realpath(currentCoreProfile(root))).toBe(await realpath(profile))
  await expect(readFile(join(profile, 'package.json'), 'utf8')).resolves.toContain(
    'preserved-profile'
  )
  await expect(prepareWindowsInstallationProfile(store, root, installed)).resolves.toBeUndefined()
})

test('keeps the transaction when a data restore requires explicit consent', async () => {
  const { root, store } = await fixture()
  const activation = {
    from: 'source',
    to: 'target',
    token: 'trial',
    snapshot: 'snapshot',
    restoreRequired: true,
  }
  await mkdir(store.root)
  await writeFile(join(store.root, 'activation.json'), JSON.stringify(activation))
  await writeFile(join(store.root, 'data-opened'), activation.token)
  const confirmRestore = vi.fn(async () => false)
  await expect(settleReleaseBeforeStartup(store, root, confirmRestore, true)).resolves.toBe(false)
  expect(confirmRestore).toHaveBeenCalledOnce()
  await expect(store.activation()).resolves.toEqual(activation)
})
