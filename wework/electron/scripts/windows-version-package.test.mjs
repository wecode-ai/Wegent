import { createHash } from 'node:crypto'
import { createRequire } from 'node:module'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import extract from 'extract-zip'
import { afterEach, expect, test } from 'vitest'

import {
  createWindowsUpdateArchive,
  finalizeWindowsVersionPackage,
  WINDOWS_INITIAL_UPDATE_STATE,
  writeWindowsReleaseManifest,
} from './windows-version-package.mjs'

const directories = []
const afterSign = createRequire(import.meta.url)('./after-sign.cjs')
afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wework-version-package-'))
  directories.push(root)
  const appOutDir = join(root, 'win-unpacked')
  await mkdir(join(appOutDir, 'resources', 'bin'), { recursive: true })
  await writeFile(join(appOutDir, 'WeWork.exe'), 'signed-electron-bytes')
  await writeFile(join(appOutDir, 'resources', 'app.asar'), 'complete-runtime')
  const launcherPath = join(appOutDir, 'resources', 'bin', 'wework-launcher.exe')
  await writeFile(launcherPath, 'signed-launcher')
  return { root, appOutDir, launcherPath }
}

test('preserves signed application bytes and uses the version helper as the stable launcher', async () => {
  const { root, appOutDir, launcherPath } = await fixture()
  const result = await finalizeWindowsVersionPackage({
    appOutDir,
    launcherPath,
    version: '1.2.3',
  })
  expect(await readFile(join(appOutDir, 'WeWork.exe'), 'utf8')).toBe('signed-launcher')
  const version = join(appOutDir, result.versionPath)
  expect(await readFile(join(version, 'WeWork.exe'), 'utf8')).toBe('signed-electron-bytes')
  const releaseBytes = await readFile(join(version, 'release.json'))
  const release = JSON.parse(releaseBytes)
  expect(release).toMatchObject({
    schemaVersion: 2,
    version: '1.2.3',
    platform: 'windows',
    arch: 'x64',
    dataSchemaVersion: 1,
    entryPoint: 'WeWork.exe',
  })
  expect(release.files).toEqual([
    {
      path: 'WeWork.exe',
      size: 21,
      sha256: createHash('sha256').update('signed-electron-bytes').digest('hex'),
    },
    {
      path: 'resources/app.asar',
      size: 16,
      sha256: createHash('sha256').update('complete-runtime').digest('hex'),
    },
    {
      path: 'resources/bin/wework-launcher.exe',
      size: 15,
      sha256: createHash('sha256').update('signed-launcher').digest('hex'),
    },
  ])
  expect(result.versionPath).toBe(
    `versions/1.2.3-${createHash('sha256').update(releaseBytes).digest('hex').slice(0, 16)}`
  )
  expect(JSON.parse(await readFile(join(appOutDir, WINDOWS_INITIAL_UPDATE_STATE), 'utf8'))).toEqual(
    {
      schemaVersion: 2,
      active: { version: '1.2.3', path: result.versionPath },
      dataSchemaVersion: 1,
    }
  )
  expect((await readdir(appOutDir)).sort()).toEqual([
    'WeWork.exe',
    WINDOWS_INITIAL_UPDATE_STATE,
    // Reserved for the NSIS elevate helper outside the immutable version.
    'resources',
    'versions',
  ])
  const outputFile = join(root, 'update.zip')
  await createWindowsUpdateArchive({ installRoot: appOutDir, outputFile })
  const extracted = join(root, 'extracted')
  await extract(outputFile, { dir: extracted })
  expect((await readdir(extracted)).sort()).toEqual(['WeWork.exe', 'release.json', 'resources'])
  expect(await readFile(join(extracted, 'WeWork.exe'), 'utf8')).toBe('signed-electron-bytes')
  expect(await readFile(join(extracted, 'release.json'))).toEqual(releaseBytes)
  expect(await readFile(join(extracted, 'resources/bin/wework-launcher.exe'), 'utf8')).toBe(
    'signed-launcher'
  )
})

test('signs the nested native helper before hashing and copies exactly those bytes to the root', async () => {
  const { root, appOutDir, launcherPath } = await fixture()
  await writeFile(launcherPath, 'unsigned-launcher')
  const signed = []
  await afterSign({
    electronPlatformName: 'win32',
    appOutDir,
    outDir: root,
    arch: 1,
    packager: {
      appInfo: { version: '1.2.3', productFilename: 'WeWork' },
      signAndEditResources: async file => {
        signed.push(file)
        await writeFile(file, 'signed-launcher')
      },
    },
  })
  expect(signed).toEqual([launcherPath])
  const state = JSON.parse(await readFile(join(appOutDir, WINDOWS_INITIAL_UPDATE_STATE), 'utf8'))
  const directory = join(appOutDir, state.active.path)
  const release = JSON.parse(await readFile(join(directory, 'release.json'), 'utf8'))
  expect(release.files.find(file => file.path === 'resources/bin/wework-launcher.exe')).toEqual({
    path: 'resources/bin/wework-launcher.exe',
    size: 15,
    sha256: createHash('sha256').update('signed-launcher').digest('hex'),
  })
  expect(await readFile(join(appOutDir, 'WeWork.exe'))).toEqual(
    await readFile(join(directory, 'resources/bin/wework-launcher.exe'))
  )
  expect(await readFile(join(directory, 'WeWork.exe'), 'utf8')).toBe('signed-electron-bytes')
})

test('rejects a package without its real Electron executable before moving files', async () => {
  const { appOutDir, launcherPath } = await fixture()
  await rm(join(appOutDir, 'WeWork.exe'))
  await expect(
    finalizeWindowsVersionPackage({ appOutDir, launcherPath, version: '1.2.3' })
  ).rejects.toThrow('ENOENT')
  expect(await readFile(join(appOutDir, 'resources', 'app.asar'), 'utf8')).toBe('complete-runtime')
})

test('release manifests hash the final on-disk bytes and use portable relative file names', async () => {
  const { appOutDir } = await fixture()
  const first = await writeWindowsReleaseManifest({ directory: appOutDir, version: '1.2.3' })
  await writeFile(join(appOutDir, 'WeWork.exe'), 'signed-new-bytes')
  const second = await writeWindowsReleaseManifest({ directory: appOutDir, version: '1.2.3' })
  expect(second.files[0].sha256).not.toBe(first.files[0].sha256)
  expect(second.files.map(file => file.path)).toEqual([
    'WeWork.exe',
    'resources/app.asar',
    'resources/bin/wework-launcher.exe',
  ])
})

test('release archives use the packaged seed rather than a mutable live installation state', async () => {
  const { root, appOutDir, launcherPath } = await fixture()
  const { versionPath } = await finalizeWindowsVersionPackage({
    appOutDir,
    launcherPath,
    version: '1.2.3',
  })
  await writeFile(
    join(appOutDir, 'update-state.json'),
    JSON.stringify({
      schemaVersion: 2,
      active: { version: '9.9.9', path: 'versions/unrelated-live-version' },
    })
  )
  const outputFile = join(root, 'update.zip')
  await createWindowsUpdateArchive({ installRoot: appOutDir, outputFile })
  const extracted = join(root, 'extracted')
  await extract(outputFile, { dir: extracted })
  expect(await readFile(join(extracted, 'release.json'))).toEqual(
    await readFile(join(appOutDir, versionPath, 'release.json'))
  )
})

test.each(['changed', 'extra', 'missing'])(
  'rejects %s files after signed release finalization',
  async change => {
    const { root, appOutDir, launcherPath } = await fixture()
    const { versionPath } = await finalizeWindowsVersionPackage({
      appOutDir,
      launcherPath,
      version: '1.2.3',
    })
    const directory = join(appOutDir, versionPath)
    if (change === 'changed') await writeFile(join(directory, 'WeWork.exe'), 'changed-bytes')
    else if (change === 'extra') await writeFile(join(directory, 'extra.exe'), 'extra')
    else await rm(join(directory, 'resources/app.asar'))
    await expect(
      createWindowsUpdateArchive({ installRoot: appOutDir, outputFile: join(root, 'update.zip') })
    ).rejects.toThrow(
      change === 'changed' ? 'bytes changed after signing' : 'files changed after release'
    )
  }
)
