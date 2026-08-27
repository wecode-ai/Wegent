import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'

import { expect, test } from 'vitest'

import identityModule from '../scripts/build-identity.cjs'

const { DEFAULT_IDENTITY, resolveBuildIdentity } = identityModule
const require = createRequire(import.meta.url)
const builderConfig = require('../electron-builder.config.cjs')

test('uses the public Electron identity by default', () => {
  expect(resolveBuildIdentity({})).toEqual(DEFAULT_IDENTITY)
})

test('uses a configured identity required for overwrite installation', async () => {
  const path = resolve(tmpdir(), `wework-brand-${process.pid}-${Date.now()}.json`)
  await writeFile(
    path,
    JSON.stringify({
      productName: 'Example Workbench',
      identifier: 'com.example.workbench',
      mainBinaryName: 'Example Workbench',
      backendUrl: 'https://backend.example.com/api',
      socketUrl: 'wss://socket.example.com',
    })
  )

  expect(resolveBuildIdentity({ WEWORK_BRAND_CONFIG: path })).toEqual({
    productName: 'Example Workbench',
    identifier: 'com.example.workbench',
    executableName: 'Example Workbench',
    executorNamespace: 'com.example.workbench',
    backendUrl: 'https://backend.example.com/api',
    socketUrl: 'wss://socket.example.com',
  })
})

test('rejects unsafe executable names', async () => {
  const path = resolve(tmpdir(), `wework-brand-invalid-${process.pid}-${Date.now()}.json`)
  await writeFile(
    path,
    JSON.stringify({
      productName: 'Example Workbench',
      identifier: 'com.example.workbench',
      mainBinaryName: '../Example Workbench',
    })
  )

  expect(() => resolveBuildIdentity({ WEWORK_BRAND_CONFIG: path })).toThrow(
    'is not a safe file name'
  )
})

test('rejects non-web backend URLs', async () => {
  const path = resolve(tmpdir(), `wework-brand-backend-${process.pid}-${Date.now()}.json`)
  await writeFile(
    path,
    JSON.stringify({
      productName: 'Example Workbench',
      identifier: 'com.example.workbench',
      backendUrl: 'file:///tmp/backend',
    })
  )

  expect(() => resolveBuildIdentity({ WEWORK_BRAND_CONFIG: path })).toThrow(
    'backendUrl must use http: or https:'
  )
})

test('rejects identifiers that are invalid macOS bundle identifiers', async () => {
  const path = resolve(tmpdir(), `wework-brand-identifier-${process.pid}-${Date.now()}.json`)
  await writeFile(
    path,
    JSON.stringify({
      productName: 'Example Workbench',
      identifier: 'com.example_workbench',
    })
  )

  expect(() => resolveBuildIdentity({ WEWORK_BRAND_CONFIG: path })).toThrow(
    "identifier may only contain letters, numbers, '.' and '-'"
  )
})

test.each([
  ['backendUrl', 'https://user@backend.example.com'],
  ['backendUrl', 'https://:password@backend.example.com'],
  ['socketUrl', 'wss://user@socket.example.com'],
  ['socketUrl', 'wss://:password@socket.example.com'],
])('rejects credentials in %s', async (field, value) => {
  const path = resolve(tmpdir(), `wework-brand-credentials-${process.pid}-${Date.now()}.json`)
  await writeFile(
    path,
    JSON.stringify({
      productName: 'Example Workbench',
      identifier: 'com.example.workbench',
      [field]: value,
    })
  )

  expect(() => resolveBuildIdentity({ WEWORK_BRAND_CONFIG: path })).toThrow(
    `${field} may not contain credentials`
  )
})

test('packages only product locales and skips individual static plugin signing', () => {
  expect(builderConfig.mac.electronLanguages).toEqual(['en', 'zh_CN'])
  expect(builderConfig.mac.signIgnore).toEqual(['/Contents/Resources/wework-core-plugins/'])
  expect(builderConfig.win.electronLanguages).toEqual(['en-US', 'zh-CN'])
  expect(builderConfig.linux.electronLanguages).toEqual(['en-US', 'zh-CN'])
})
