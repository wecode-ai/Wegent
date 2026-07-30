import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

interface TauriConfig {
  bundle: {
    resources?: string[]
  }
}

const bundledPluginResource = 'bundled-plugins'
const packagingScripts = [
  'scripts/build-mac-app.sh',
  'scripts/release-mac-app.sh',
  'scripts/build-minio-windows-release.sh',
]

describe('bundled plugin resources', () => {
  test('includes both marketplace manifests in the source tree', () => {
    const marketplaceRoot = resolve(process.cwd(), 'src-tauri/bundled-plugins/wework-personal')

    expect(existsSync(resolve(marketplaceRoot, '.agents/plugins/marketplace.json'))).toBe(true)
    expect(existsSync(resolve(marketplaceRoot, '.claude-plugin/marketplace.json'))).toBe(true)
  })

  test('bundles the marketplace directory in the base Tauri config', () => {
    const configPath = resolve(process.cwd(), 'src-tauri/tauri.conf.json')
    const config = JSON.parse(readFileSync(configPath, 'utf8')) as TauriConfig

    expect(config.bundle.resources).toContain(bundledPluginResource)
  })

  test.each(packagingScripts)('%s keeps the marketplace in its resource override', scriptPath => {
    const script = readFileSync(resolve(process.cwd(), scriptPath), 'utf8')

    expect(script).toContain(`"${bundledPluginResource}",`)
  })
})
