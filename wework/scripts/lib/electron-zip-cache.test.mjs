import { chmod, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  prepareSharedElectronZip,
  resolveSharedElectronZipDirectory,
} from './electron-zip-cache.mjs'

const roots = []

async function temporaryRoot() {
  const root = join(tmpdir(), `electron-zip-cache-${process.pid}-${roots.length}`)
  roots.push(root)
  await mkdir(root, { recursive: true })
  return root
}

async function writeElectronPackage(root, artifact) {
  const { createHash } = await import('node:crypto')
  const checksum = createHash('sha256').update(artifact).digest('hex')
  await mkdir(root, { recursive: true })
  await writeFile(join(root, 'package.json'), JSON.stringify({ version: '43.4.1' }))
  await writeFile(
    join(root, 'checksums.json'),
    JSON.stringify({ 'electron-v43.4.1-darwin-arm64.zip': checksum })
  )
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe('shared Electron ZIP cache', () => {
  test('uses a machine-level cache directory by default', () => {
    expect(
      resolveSharedElectronZipDirectory(
        { HOME: '/Users/test' },
        { platform: 'darwin' },
        '/workspace'
      )
    ).toBe('/Users/test/Library/Caches/wegent/electron-zips')
  })

  test('materializes a verified Electron artifact once', async () => {
    const root = await temporaryRoot()
    const packageRoot = join(root, 'electron')
    const downloadedArtifact = join(root, 'downloaded.zip')
    const artifact = Buffer.from('verified Electron archive')
    await writeFile(downloadedArtifact, artifact)
    await chmod(downloadedArtifact, 0o600)
    await writeElectronPackage(packageRoot, artifact)
    const downloadArtifact = vi.fn().mockResolvedValue(downloadedArtifact)
    const environment = { WEWORK_ELECTRON_ZIP_DIR: join(root, 'shared') }

    const firstDirectory = await prepareSharedElectronZip({
      electronPackageRoot: packageRoot,
      environment,
      runtime: { arch: 'arm64', platform: 'darwin' },
      downloadArtifact,
    })
    const secondDirectory = await prepareSharedElectronZip({
      electronPackageRoot: packageRoot,
      environment,
      runtime: { arch: 'arm64', platform: 'darwin' },
      downloadArtifact,
    })

    expect(firstDirectory).toBe(join(root, 'shared'))
    expect(secondDirectory).toBe(firstDirectory)
    expect(downloadArtifact).toHaveBeenCalledOnce()
    expect(downloadArtifact).toHaveBeenCalledWith(
      expect.objectContaining({
        checksums: expect.any(Object),
        platform: 'darwin',
        arch: 'arm64',
      })
    )
  })

  test('resolves dependencies beside the real pnpm package path', async () => {
    const root = await temporaryRoot()
    const realPackageRoot = join(root, 'store', 'node_modules', 'electron')
    const linkedPackageRoot = join(root, 'workspace', 'node_modules', 'electron')
    const dependencyRoot = join(root, 'store', 'node_modules', '@electron', 'get')
    const artifact = Buffer.from('verified Electron archive')
    await writeElectronPackage(realPackageRoot, artifact)
    await mkdir(dependencyRoot, { recursive: true })
    await writeFile(
      join(dependencyRoot, 'package.json'),
      JSON.stringify({ name: '@electron/get', main: 'index.cjs' })
    )
    await writeFile(
      join(dependencyRoot, 'index.cjs'),
      `exports.downloadArtifact = async () => ${JSON.stringify(join(root, 'downloaded.zip'))}\n`
    )
    await writeFile(join(root, 'downloaded.zip'), artifact)
    await mkdir(join(root, 'workspace', 'node_modules'), { recursive: true })
    await symlink(realPackageRoot, linkedPackageRoot, 'dir')

    await prepareSharedElectronZip({
      electronPackageRoot: linkedPackageRoot,
      environment: { WEWORK_ELECTRON_ZIP_DIR: join(root, 'shared') },
      runtime: { arch: 'arm64', platform: 'darwin' },
    })

    expect(await realpath(linkedPackageRoot)).toBe(await realpath(realPackageRoot))
  })
})
