import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

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
  test('includes both marketplace manifests in the source tree', () => {
    const marketplaceRoot = resolve(process.cwd(), 'src-tauri/bundled-plugins/wework-personal')

    expect(existsSync(resolve(marketplaceRoot, '.agents/plugins/marketplace.json'))).toBe(true)
    expect(existsSync(resolve(marketplaceRoot, '.claude-plugin/marketplace.json'))).toBe(true)

    const tauriDirectory = resolve(process.cwd(), 'src-tauri')
    for (const manifest of bundledPluginExampleManifests) {
      expect(existsSync(resolve(tauriDirectory, manifest))).toBe(true)
    }
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
          CODEX_TARGET: '',
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
    expect(releaseConfig.bundle.resources).toContain(bundledPluginResource)
  })

  test('limits bundled Codex resources to the requested release target', () => {
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
          CODEX_TARGET: 'aarch64-apple-darwin',
          VERSION: '1.2.3',
          UPDATER_ENDPOINT: 'https://updates.example.com/latest.json',
          UPDATER_PUBKEY: 'test-pubkey',
          SIGNING_IDENTITY: '',
          ENABLE_INSECURE_TRANSPORT: 'false',
        },
      }
    )

    const releaseConfig = JSON.parse(readFileSync(outputConfigPath, 'utf8')) as {
      bundle: {
        resources: string[]
      }
    }

    expect(releaseConfig.bundle.resources).toContain('binaries/codex/aarch64-apple-darwin/**/*')
    expect(releaseConfig.bundle.resources).toContain('binaries/codex/legal/**/*')
    expect(releaseConfig.bundle.resources).not.toContain('binaries/codex/**/*')
    expect(releaseConfig.bundle.resources).not.toContain('binaries/codex/x86_64-apple-darwin/**/*')
    expect(releaseConfig.bundle.resources).toContain(bundledPluginResource)
    expect(releaseConfig.bundle.resources).toContain('bundled-execution-runtimes/*')
    expect(releaseConfig.bundle.resources).toContain('bundled-harness-runtime/*')
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
    expect(workflow).toContain('CODEX_TARGET="${{ matrix.rust_target }}"')
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
