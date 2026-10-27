import { expect, test } from 'vitest'

import { planChannelUpdates } from './publish-desktop-update-channel.mjs'

const migration = version => ({
  platform: 'windows',
  appVersion: version,
  legacyMigration: { protocolVersion: 2, kind: 'self-contained-installer' },
})
const input = {
  channel: 'stable',
  version: '1.2.4',
  assetNames: [
    'components-stable-macos-arm64.json',
    'components-stable-macos-x64.json',
    'components-stable-linux-x64.json',
    'latest-mac.yml',
  ],
}

test('publishes a complete initial migration bridge alongside the independent v2 feed', () => {
  expect(planChannelUpdates(input)).toEqual({
    otherPlatforms: input.assetNames,
    legacyWindows: ['components-stable-windows-x64.json', 'latest.yml'],
    windowsV2: ['windows-stable-v2.json'],
  })
})

test('freezes the matched bridge while newer v2 and other platforms keep advancing', () => {
  expect(
    planChannelUpdates({
      ...input,
      macVersion: '1.2.3',
      legacyVersion: '1.2.3',
      legacyComponents: migration('1.2.3'),
      windowsV2: { schemaVersion: 2, version: '1.2.3' },
    })
  ).toEqual({
    otherPlatforms: input.assetNames,
    legacyWindows: [],
    windowsV2: ['windows-stable-v2.json'],
  })
})

test('repairs a partially uploaded bridge rather than freezing mismatched versions', () => {
  expect(
    planChannelUpdates({
      ...input,
      legacyVersion: '1.2.3',
      legacyComponents: migration('1.2.4'),
    }).legacyWindows
  ).toEqual(['components-stable-windows-x64.json', 'latest.yml'])
})

test('does not let the macOS version guard block repairing or advancing Windows v2', () => {
  expect(
    planChannelUpdates({
      ...input,
      macVersion: '1.2.4',
      legacyVersion: '1.2.3',
      legacyComponents: migration('1.2.3'),
      windowsV2: { schemaVersion: 2, version: '1.2.3' },
    })
  ).toEqual({ otherPlatforms: [], legacyWindows: [], windowsV2: ['windows-stable-v2.json'] })
})

test('does not downgrade newer channels when a stable publication also targets beta', () => {
  expect(
    planChannelUpdates({
      ...input,
      channel: 'beta',
      macVersion: '1.3.0-beta.1',
      assetNames: input.assetNames.map(name =>
        name.replace('stable', 'beta').replace('latest', 'beta')
      ),
      legacyVersion: '1.3.0-beta.1',
      legacyComponents: migration('1.3.0-beta.1'),
      windowsV2: { schemaVersion: 2, version: '1.3.0-beta.1' },
    })
  ).toEqual({ otherPlatforms: [], legacyWindows: [], windowsV2: [] })
})

test('repairs missing same-version v2 even when all other manifests already exist', () => {
  expect(
    planChannelUpdates({
      ...input,
      macVersion: '1.2.4',
      legacyVersion: '1.2.3',
      legacyComponents: migration('1.2.3'),
    }).windowsV2
  ).toEqual(['windows-stable-v2.json'])
})

test('requires the newer release to repair its interrupted migration publication', () => {
  expect(() =>
    planChannelUpdates({
      ...input,
      legacyVersion: '1.2.3',
      legacyComponents: migration('1.2.5'),
    })
  ).toThrow('newer legacy migration bridge is incomplete')
})
