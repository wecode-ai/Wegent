import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  expectedChannelAssetNames,
  generateChannelManifests,
  hasCompleteChannelAssets,
  isNewerWeworkVersion,
  parseWeworkVersion,
} from './update-channel-manifests.mjs'

const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  )
})

describe('Wework update channel manifests', () => {
  test('orders stable and Beta versions using SemVer precedence', () => {
    expect(isNewerWeworkVersion('1.2.4-beta.2', '1.2.4-beta.1')).toBe(true)
    expect(isNewerWeworkVersion('1.2.4', '1.2.4-beta.2')).toBe(true)
    expect(isNewerWeworkVersion('1.2.4-beta.1', '1.2.4')).toBe(false)
    expect(isNewerWeworkVersion('1.3.0-beta.1', '1.2.9')).toBe(true)
  })

  test('rejects unsupported prerelease formats', () => {
    expect(() => parseWeworkVersion('1.2.3-alpha.1')).toThrow('Unsupported Wework version')
  })

  test('requires every Electron and legacy manifest before treating a channel as complete', () => {
    const stableAssets = expectedChannelAssetNames('stable')

    expect(stableAssets).toEqual([
      'latest.yml',
      'latest-mac.yml',
      'stable-darwin-aarch64.json',
      'stable-darwin-x86_64.json',
      'stable-windows-x86_64.json',
      'components-stable-macos-arm64.json',
      'components-stable-macos-x64.json',
      'components-stable-windows-x64.json',
      'components-stable-linux-x64.json',
    ])
    expect(hasCompleteChannelAssets(stableAssets, 'stable')).toBe(true)
    expect(
      hasCompleteChannelAssets(
        stableAssets.filter(name => name !== 'latest-mac.yml'),
        'stable'
      )
    ).toBe(false)
    expect(
      hasCompleteChannelAssets(
        [
          'beta.yml',
          'beta-mac.yml',
          'beta-darwin-aarch64.json',
          'beta-darwin-x86_64.json',
          'beta-windows-x86_64.json',
          'components-beta-macos-arm64.json',
          'components-beta-macos-x64.json',
          'components-beta-windows-x64.json',
          'components-beta-linux-x64.json',
        ],
        'beta'
      )
    ).toBe(true)
  })

  test('creates architecture-specific manifests for a custom channel target', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'wework-update-channel-'))
    temporaryDirectories.push(directory)
    const sourcePath = resolve(directory, 'latest.json')
    const source = {
      version: '1.2.4-beta.1',
      notes: 'Beta release',
      pub_date: '2026-08-02T00:00:00Z',
      platforms: {
        'darwin-aarch64': { signature: 'mac-arm', url: 'https://example.com/mac-arm' },
        'darwin-x86_64': { signature: 'mac-x64', url: 'https://example.com/mac-x64' },
        'windows-x86_64': { signature: 'win-x64', url: 'https://example.com/win-x64' },
      },
    }
    await writeFile(sourcePath, JSON.stringify(source), 'utf8')

    await generateChannelManifests({
      sourcePath,
      outputDirectory: directory,
      channel: 'beta',
    })

    const manifest = JSON.parse(
      await readFile(resolve(directory, 'beta-darwin-aarch64.json'), 'utf8')
    )
    expect(manifest.version).toBe(source.version)
    expect(manifest.platforms).toEqual({
      'beta-darwin': source.platforms['darwin-aarch64'],
    })
  })

  test('rejects a source manifest that omits a required platform', async () => {
    const directory = await mkdtemp(resolve(tmpdir(), 'wework-update-channel-'))
    temporaryDirectories.push(directory)
    const sourcePath = resolve(directory, 'latest.json')
    await writeFile(
      sourcePath,
      JSON.stringify({
        version: '1.2.4',
        notes: 'Stable release',
        pub_date: '2026-08-03T00:00:00Z',
        platforms: {
          'darwin-aarch64': { signature: 'mac-arm', url: 'https://example.com/mac-arm' },
          'darwin-x86_64': { signature: 'mac-x64', url: 'https://example.com/mac-x64' },
        },
      }),
      'utf8'
    )

    await expect(
      generateChannelManifests({
        sourcePath,
        outputDirectory: directory,
        channel: 'stable',
      })
    ).rejects.toThrow("Missing platform 'windows-x86_64'")
  })
})
