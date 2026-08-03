import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import {
  generateChannelManifests,
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
})
