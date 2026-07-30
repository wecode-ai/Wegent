import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

const bundledMarketplaceManifests = [
  'bundled-plugins/wework-personal/.agents/plugins/marketplace.json',
  'bundled-plugins/wework-personal/.claude-plugin/marketplace.json',
]

describe('bundled plugin resources', () => {
  test('explicitly packages hidden marketplace manifests', () => {
    const tauriDirectory = resolve(process.cwd(), 'src-tauri')
    const config = JSON.parse(readFileSync(resolve(tauriDirectory, 'tauri.conf.json'), 'utf8')) as {
      bundle: {
        resources: string[]
      }
    }

    for (const manifest of bundledMarketplaceManifests) {
      expect(config.bundle.resources).toContain(manifest)
      expect(existsSync(resolve(tauriDirectory, manifest))).toBe(true)
    }
  })
})
