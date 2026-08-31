import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from 'vitest'

const require = createRequire(import.meta.url)
const {
  resolveAppUpdateConfiguration,
  serializeAppUpdateConfiguration,
} = require('../scripts/app-update-config.cjs')
const electronRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

test('generates the signed application updater configuration from the release URL', () => {
  const configuration = resolveAppUpdateConfiguration('@wegent/wework-electron', {
    WEWORK_UPDATE_BASE_URL: 'https://updates.example.com/wework/macos/',
  })

  expect(configuration).toEqual({
    provider: 'generic',
    url: 'https://updates.example.com/wework/macos',
    updaterCacheDirName: '@wegentwework-electron-updater',
  })
  expect(serializeAppUpdateConfiguration(configuration)).toBe(
    [
      'provider: generic',
      'url: "https://updates.example.com/wework/macos"',
      'updaterCacheDirName: "@wegentwework-electron-updater"',
      '',
    ].join('\n')
  )
})

test('rejects unsafe updater URLs', () => {
  expect(() =>
    resolveAppUpdateConfiguration('@wegent/wework-electron', {
      WEWORK_UPDATE_BASE_URL: 'https://token@updates.example.com/wework',
    })
  ).toThrow('without credentials')
})

test('electron-builder packages the explicit updater configuration resource', () => {
  const builderConfig = require(resolve(electronRoot, 'electron-builder.config.cjs'))

  expect(builderConfig.publish).toEqual({
    provider: 'generic',
    url: expect.any(String),
  })
  expect(builderConfig.extraResources).toContainEqual({
    from: 'resources/app-update.yml',
    to: 'app-update.yml',
  })
})
