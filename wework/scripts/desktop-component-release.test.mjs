import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, expect, test } from 'vitest'

import { componentReleaseScope, listComponentAssets } from './desktop-component-release.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }))
  )
})

test('keeps external runtime components on the shared updater release', () => {
  expect(componentReleaseScope('coreDsh')).toBe('shared')
  expect(componentReleaseScope('codex')).toBe('shared')
  expect(componentReleaseScope('dws')).toBe('shared')
  expect(componentReleaseScope('executor')).toBe('version')
  expect(componentReleaseScope('weworkCorePlugins')).toBe('version')
  expect(componentReleaseScope('weworkAppStatic')).toBe('version')
  expect(componentReleaseScope('bundledPlugins')).toBe('version')
})

test('lists only assets owned by the requested release scope', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'wework-component-release-'))
  temporaryDirectories.push(root)
  await mkdir(root, { recursive: true })
  await writeFile(
    resolve(root, 'components-macos-arm64.json'),
    JSON.stringify({
      components: {
        coreDsh: {
          releaseScope: 'shared',
          assetName: 'WeworkComponent_coreDsh_shared_macos_arm64.tar.gz',
        },
        codex: {
          releaseScope: 'shared',
          assetName: 'WeworkComponent_codex_shared_macos_arm64.tar.gz',
        },
        executor: {
          releaseScope: 'version',
          assetName: 'WeworkComponent_executor_version_macos_arm64.tar.gz',
        },
      },
    })
  )

  await expect(listComponentAssets(root, 'shared')).resolves.toEqual([
    'WeworkComponent_codex_shared_macos_arm64.tar.gz',
    'WeworkComponent_coreDsh_shared_macos_arm64.tar.gz',
  ])
  await expect(listComponentAssets(root, 'version')).resolves.toEqual([
    'WeworkComponent_executor_version_macos_arm64.tar.gz',
  ])
})

test('rejects a descriptor that routes an external component to a version release', async () => {
  const root = await mkdtemp(resolve(tmpdir(), 'wework-component-scope-'))
  temporaryDirectories.push(root)
  await writeFile(
    resolve(root, 'components-windows-x64.json'),
    JSON.stringify({
      components: {
        codex: {
          releaseScope: 'version',
          assetName: 'WeworkComponent_codex_invalid_windows_x64.tar.gz',
        },
      },
    })
  )

  await expect(listComponentAssets(root, 'version')).rejects.toThrow(
    'Desktop component codex has release scope version; expected shared'
  )
})
