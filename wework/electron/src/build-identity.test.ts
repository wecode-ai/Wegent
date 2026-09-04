import { execFileSync } from 'node:child_process'
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
    packageName: 'com.example.workbench',
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
  expect(builderConfig.extraMetadata.name).toBe(DEFAULT_IDENTITY.packageName)
  expect(builderConfig.mac.electronLanguages).toEqual(['en', 'zh_CN'])
  expect(builderConfig.mac.signIgnore).toEqual(['/Contents/Resources/wework-core-plugins/'])
  expect(builderConfig.win.electronLanguages).toEqual(['en-US', 'zh-CN'])
  expect(builderConfig.linux.electronLanguages).toEqual(['en-US', 'zh-CN'])
})

test('builds a slim Host update without managed components', () => {
  const config = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '-e',
        `
const config = require(process.argv[1])
process.stdout.write(JSON.stringify({
  compression: config.compression,
  output: config.directories.output,
  resources: config.extraResources,
  macTarget: config.mac.target,
  macArtifactName: config.mac.artifactName,
  winArtifactName: config.win.artifactName,
  linuxArtifactName: config.linux.artifactName,
}))
`,
        resolve(process.cwd(), 'electron/electron-builder.config.cjs'),
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          WEWORK_ONLINE_UPDATE_BUILD: 'true',
        },
      }
    )
  )

  expect(config.output).toBe('release-online-update')
  expect(config.compression).toBe('store')
  expect(config.resources).toEqual([
    { from: 'resources/components.json', to: 'components.json' },
    { from: '../resources/licenses', to: 'licenses' },
    { from: '../resources/icons', to: 'icons' },
    { from: '../../LICENSE', to: 'LICENSE' },
  ])
  expect(config.macTarget).toEqual(['zip'])
  expect(config.macArtifactName).toBe('WeWorkHostUpdate_${version}_macos_${arch}.${ext}')
  expect(config.winArtifactName).toBe('WeWorkHostUpdate_${version}_windows_${arch}-setup.${ext}')
  expect(config.linuxArtifactName).toBe('WeWorkHostUpdate_${version}_linux_${arch}.${ext}')
})

test('builds a complete Host update for the componentized updater migration release', () => {
  const config = JSON.parse(
    execFileSync(
      process.execPath,
      [
        '-e',
        `
const config = require(process.argv[1])
process.stdout.write(JSON.stringify(config.extraResources.map(resource => resource.to)))
`,
        resolve(process.cwd(), 'electron/electron-builder.config.cjs'),
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          WEWORK_ONLINE_UPDATE_BUILD: 'true',
          WEWORK_ONLINE_UPDATE_INCLUDE_COMPONENTS: 'true',
        },
      }
    )
  )

  expect(config).toEqual([
    'harness-runtime',
    'bin',
    'codex',
    'wework-core-plugins',
    'wework-app-static',
    'bundled-plugins',
    'components.json',
    'licenses',
    'icons',
    'LICENSE',
  ])
})
