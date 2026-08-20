import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

const bundledMarketplaceManifests = [
  'bundled-plugins/wework-personal/.agents/plugins/marketplace.json',
  'bundled-plugins/wework-personal/.claude-plugin/marketplace.json',
]

const bundledPluginExampleManifests = [
  'bundled-plugins/wework-plugin-example/.codex-plugin/plugin.json',
  'bundled-plugins/wework-plugin-example/.mcp.json',
]

const bundledWeworkSpaceDirectory = 'bundled-plugins/wework-personal/plugins/wework-space'
const bundledSmartAppBuilderDirectory = 'bundled-plugins/wework-personal/plugins/smart-app-builder'

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
    for (const manifest of bundledPluginExampleManifests) {
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

  test('installs the stable Wework project-space capability by default', () => {
    const tauriDirectory = resolve(process.cwd(), 'src-tauri')
    const codexMarketplace = JSON.parse(
      readFileSync(
        resolve(tauriDirectory, 'bundled-plugins/wework-personal/.agents/plugins/marketplace.json'),
        'utf8'
      )
    ) as {
      plugins: Array<{
        name: string
        policy?: { installation?: string }
      }>
    }
    const claudeMarketplace = JSON.parse(
      readFileSync(
        resolve(tauriDirectory, 'bundled-plugins/wework-personal/.claude-plugin/marketplace.json'),
        'utf8'
      )
    ) as { plugins: Array<{ name: string }> }
    expect(
      codexMarketplace.plugins.find(plugin => plugin.name === 'wework-space')?.policy?.installation
    ).toBe('INSTALLED_BY_DEFAULT')
    expect(claudeMarketplace.plugins.some(plugin => plugin.name === 'wework-space')).toBe(true)
    expect(existsSync(resolve(tauriDirectory, bundledWeworkSpaceDirectory, '.mcp.json'))).toBe(
      false
    )
    expect(
      existsSync(
        resolve(tauriDirectory, bundledWeworkSpaceDirectory, 'skills/wework-project-space/SKILL.md')
      )
    ).toBe(true)
  })

  test('installs the Smart app builder workflow by default', () => {
    const tauriDirectory = resolve(process.cwd(), 'src-tauri')
    const codexMarketplace = JSON.parse(
      readFileSync(
        resolve(tauriDirectory, 'bundled-plugins/wework-personal/.agents/plugins/marketplace.json'),
        'utf8'
      )
    ) as {
      plugins: Array<{
        name: string
        policy?: { installation?: string }
      }>
    }
    const claudeMarketplace = JSON.parse(
      readFileSync(
        resolve(tauriDirectory, 'bundled-plugins/wework-personal/.claude-plugin/marketplace.json'),
        'utf8'
      )
    ) as { plugins: Array<{ name: string }> }

    expect(
      codexMarketplace.plugins.find(plugin => plugin.name === 'smart-app-builder')?.policy
        ?.installation
    ).toBe('INSTALLED_BY_DEFAULT')
    expect(claudeMarketplace.plugins.some(plugin => plugin.name === 'smart-app-builder')).toBe(true)
    expect(
      existsSync(
        resolve(tauriDirectory, bundledSmartAppBuilderDirectory, 'skills/create-smart-app/SKILL.md')
      )
    ).toBe(true)
    expect(
      existsSync(
        resolve(tauriDirectory, bundledSmartAppBuilderDirectory, 'scripts/smart-app-tool.mjs')
      )
    ).toBe(true)
  })

  test('packages Smart apps on Windows without evaluating path text', () => {
    const script = readFileSync(
      resolve(
        process.cwd(),
        'src-tauri',
        bundledSmartAppBuilderDirectory,
        'scripts/smart-app-tool.mjs'
      ),
      'utf8'
    )

    expect(script).toMatch(/execFileSync\(\s*'tar\.exe'/)
    expect(script).not.toMatch(/execFileSync\(\s*'powershell\.exe'/)
    expect(script).toContain("'--exclude=node_modules'")
    expect(script).toContain("'--exclude=.git'")
    expect(script).toContain("'--exclude=test-results'")
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
