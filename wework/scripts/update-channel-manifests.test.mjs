import { describe, expect, test } from 'vitest'
import {
  expectedChannelAssetNames,
  hasCompleteChannelAssets,
  isNewerWeworkVersion,
  parseElectronManifestVersion,
  parseWeworkVersion,
} from './update-channel-manifests.mjs'

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

  test('requires every Electron and component manifest before treating a channel as complete', () => {
    const stableAssets = expectedChannelAssetNames('stable')

    expect(stableAssets).toEqual([
      'latest.yml',
      'latest-mac.yml',
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
          'components-beta-macos-arm64.json',
          'components-beta-macos-x64.json',
          'components-beta-windows-x64.json',
          'components-beta-linux-x64.json',
        ],
        'beta'
      )
    ).toBe(true)
  })

  test('reads the current version from an Electron YAML manifest', () => {
    expect(parseElectronManifestVersion("version: '1.2.4-beta.1'\nfiles:\n")).toBe('1.2.4-beta.1')
    expect(parseElectronManifestVersion('files:\nversion: 1.2.4\n')).toBe('1.2.4')
  })

  test('rejects a malformed Electron YAML manifest version', () => {
    expect(() => parseElectronManifestVersion('files: []\n')).toThrow('does not contain a version')
    expect(() => parseElectronManifestVersion('version: next\n')).toThrow(
      'Unsupported Wework version'
    )
  })
})
