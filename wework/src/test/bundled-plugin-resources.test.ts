import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

const bundledMarketplaceManifests = [
  'bundled-plugins/wework-personal/.agents/plugins/marketplace.json',
  'bundled-plugins/wework-personal/.claude-plugin/marketplace.json',
]

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

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

  test('preserves bundled plugins in the macOS release config override', () => {
    const weworkDirectory = process.cwd()
    const baseConfigPath = resolve(weworkDirectory, 'src-tauri/tauri.conf.json')
    const outputDirectory = mkdtempSync(resolve(tmpdir(), 'wework-release-config-'))
    temporaryDirectories.push(outputDirectory)
    const outputConfigPath = resolve(outputDirectory, 'tauri.release.json')

    execFileSync(
      process.execPath,
      [resolve(weworkDirectory, 'scripts/generate-release-config.mjs')],
      {
        env: {
          ...process.env,
          BASE_CONFIG: baseConfigPath,
          CONFIG_OVERRIDE: outputConfigPath,
          VERSION: '1.2.3',
          UPDATER_ENDPOINT: 'https://updates.example.com/latest.json',
          UPDATER_PUBKEY: 'test-pubkey',
          SIGNING_IDENTITY: '',
          ENABLE_INSECURE_TRANSPORT: 'false',
        },
      }
    )

    const baseConfig = JSON.parse(readFileSync(baseConfigPath, 'utf8')) as {
      bundle: {
        resources: string[]
      }
    }
    const releaseConfig = JSON.parse(readFileSync(outputConfigPath, 'utf8')) as {
      bundle: {
        resources: string[]
      }
    }

    expect(releaseConfig.bundle.resources).toEqual(baseConfig.bundle.resources)
    for (const manifest of bundledMarketplaceManifests) {
      expect(releaseConfig.bundle.resources).toContain(manifest)
    }
  })

  test('uses the shared release config generator in GitHub macOS releases', () => {
    const workflow = readFileSync(
      resolve(process.cwd(), '../.github/workflows/wework-app.yml'),
      'utf8'
    )

    expect(workflow).toContain('node scripts/generate-release-config.mjs')
  })

  test('publishes separate stable and Beta update channels', () => {
    const workflow = readFileSync(
      resolve(process.cwd(), '../.github/workflows/wework-app.yml'),
      'utf8'
    )

    expect(workflow).toContain('Beta versions are always generated automatically')
    expect(workflow).toContain('node wework/scripts/resolve-release-version.mjs')
    expect(workflow).toContain('node wework/scripts/resolve-previous-release-tag.mjs')
    expect(workflow).toContain('releases/download/wework-updater/{{target}}-{{arch}}.json')
    expect(workflow).toContain('publish_channel "$RELEASE_CHANNEL"')
    expect(workflow).toContain('publish_channel beta')
    expect(workflow).toContain('--field prerelease="$PRERELEASE"')
  })
})
