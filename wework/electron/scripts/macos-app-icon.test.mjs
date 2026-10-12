import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest'

import { compileMacosAppIcon } from './compile-macos-app-icon.mjs'

const require = createRequire(import.meta.url)
const macosAppIcon = require('./macos-app-icon.cjs')
const configPath = require.resolve('../electron-builder.config.cjs')
const sha256 = data => createHash('sha256').update(data).digest('hex')

afterEach(() => {
  vi.unstubAllEnvs()
  delete require.cache[configPath]
})

describe('macOS app icon packaging', () => {
  test.each(['false', 'true'])(
    'prepares and bundles the catalog alongside the existing ICNS for online update=%s',
    onlineUpdate => {
      vi.stubEnv('WEWORK_ONLINE_UPDATE_BUILD', onlineUpdate)
      const config = require(configPath)

      expect(config.beforePack).toBe(macosAppIcon.prepare)
      expect(config.mac.icon).toBe(macosAppIcon.icon)
      expect(config.mac.extendInfo.CFBundleIconName).toBe(macosAppIcon.extendInfo.CFBundleIconName)
      expect(config.mac.extraFiles).toEqual([
        { from: macosAppIcon.assetCatalog, to: 'Resources/Assets.car' },
      ])
      expect(config.win.extraFiles).toBeUndefined()
      expect(config.linux.extraFiles).toBeUndefined()
    }
  )

  test.each(['linux', 'win32'])('does not invoke Apple tools when packaging %s', async platform => {
    await expect(macosAppIcon.prepare({ electronPlatformName: platform })).resolves.toBeUndefined()
  })
})

describe.skipIf(process.platform !== 'darwin')('compiled macOS app icon', () => {
  let root
  let compiled

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'wework-icon-test-'))
    compiled = await compileMacosAppIcon({ assetCatalog: join(root, 'Assets.car') })
  }, 30_000)
  afterAll(async () => {
    if (root) await rm(root, { recursive: true, force: true })
  })

  async function expectCatalogHashes() {
    const metadata = JSON.parse(await readFile(compiled.metadataPath, 'utf8'))
    const [icon, catalog] = await Promise.all([
      readFile(macosAppIcon.icon),
      readFile(compiled.assetCatalog),
    ])
    expect(metadata.iconName).toBe(macosAppIcon.extendInfo.CFBundleIconName)
    expect(metadata.sourceSha256).toBe(sha256(icon))
    expect(metadata.catalogSha256).toBe(sha256(catalog))
  }

  test(
    'compiles a catalog matching the current icon without a checked-in binary',
    expectCatalogHashes
  )

  test('publishes a complete catalog and matching metadata for parallel builds', async () => {
    await Promise.all([
      compileMacosAppIcon({ assetCatalog: compiled.assetCatalog }),
      compileMacosAppIcon({ assetCatalog: compiled.assetCatalog }),
    ])
    await expectCatalogHashes()
  }, 30_000)

  test('registers every existing bitmap size without an Icon Composer stack', () => {
    const records = JSON.parse(
      execFileSync('assetutil', ['--info', compiled.assetCatalog], { encoding: 'utf8' })
    )
    const icons = records.filter(record => record.AssetType === 'Icon Image')
    const representations = new Set(
      icons.map(record => `${record.PixelWidth / record.Scale}@${record.Scale}x`)
    )

    expect(new Set(icons.map(record => record.Name))).toEqual(
      new Set([macosAppIcon.extendInfo.CFBundleIconName])
    )
    expect(representations).toEqual(
      new Set([16, 32, 128, 256, 512].flatMap(size => [`${size}@1x`, `${size}@2x`]))
    )
    expect(records.some(record => record.AssetType === 'IconImageStack')).toBe(false)
  })
})
