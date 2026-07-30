import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

interface TauriConfig {
  bundle: {
    resources?: string[]
  }
}

describe('bundled plugin packaging', () => {
  test('walks the marketplace directory so hidden manifests are bundled', () => {
    const tauriDir = resolve(process.cwd(), 'src-tauri')
    const config = JSON.parse(
      readFileSync(resolve(tauriDir, 'tauri.conf.json'), 'utf8')
    ) as TauriConfig

    expect(config.bundle.resources).toContain('bundled-plugins')
    expect(
      existsSync(
        resolve(tauriDir, 'bundled-plugins/wework-personal/.agents/plugins/marketplace.json')
      )
    ).toBe(true)
    expect(
      existsSync(
        resolve(tauriDir, 'bundled-plugins/wework-personal/.claude-plugin/marketplace.json')
      )
    ).toBe(true)
  })
})
