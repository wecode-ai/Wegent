import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, test } from 'vitest'

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

describe('bundled plugin resources', () => {
  test('explicitly packages hidden marketplace manifests', () => {
    const resourcesDirectory = resolve(process.cwd(), 'resources')
    const packageScript = readFileSync(
      resolve(process.cwd(), 'electron/scripts/package-app.mjs'),
      'utf8'
    )

    for (const manifest of bundledMarketplaceManifests) {
      expect(existsSync(resolve(resourcesDirectory, manifest))).toBe(true)
    }
    for (const manifest of bundledPluginExampleManifests) {
      expect(existsSync(resolve(resourcesDirectory, manifest))).toBe(true)
    }
    expect(packageScript).toContain("join(electronRoot, 'resources', 'bundled-plugins')")
  })

  test('installs the stable Wework project-space capability by default', () => {
    const resourcesDirectory = resolve(process.cwd(), 'resources')
    const codexMarketplace = JSON.parse(
      readFileSync(
        resolve(
          resourcesDirectory,
          'bundled-plugins/wework-personal/.agents/plugins/marketplace.json'
        ),
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
        resolve(
          resourcesDirectory,
          'bundled-plugins/wework-personal/.claude-plugin/marketplace.json'
        ),
        'utf8'
      )
    ) as { plugins: Array<{ name: string }> }
    expect(
      codexMarketplace.plugins.find(plugin => plugin.name === 'wework-space')?.policy?.installation
    ).toBe('INSTALLED_BY_DEFAULT')
    expect(claudeMarketplace.plugins.some(plugin => plugin.name === 'wework-space')).toBe(true)
    expect(existsSync(resolve(resourcesDirectory, bundledWeworkSpaceDirectory, '.mcp.json'))).toBe(
      false
    )
    expect(
      existsSync(
        resolve(
          resourcesDirectory,
          bundledWeworkSpaceDirectory,
          'skills/wework-project-space/SKILL.md'
        )
      )
    ).toBe(true)
  })

  test('installs the Smart app builder workflow by default', () => {
    const resourcesDirectory = resolve(process.cwd(), 'resources')
    const codexMarketplace = JSON.parse(
      readFileSync(
        resolve(
          resourcesDirectory,
          'bundled-plugins/wework-personal/.agents/plugins/marketplace.json'
        ),
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
        resolve(
          resourcesDirectory,
          'bundled-plugins/wework-personal/.claude-plugin/marketplace.json'
        ),
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
        resolve(
          resourcesDirectory,
          bundledSmartAppBuilderDirectory,
          'skills/create-smart-app/SKILL.md'
        )
      )
    ).toBe(true)
    expect(
      existsSync(
        resolve(resourcesDirectory, bundledSmartAppBuilderDirectory, 'scripts/smart-app-tool.mjs')
      )
    ).toBe(true)
  })

  test('packages Smart apps on Windows without evaluating path text', () => {
    const script = readFileSync(
      resolve(
        process.cwd(),
        'resources',
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

  test('uses the Electron release builder and publishes both updater protocols', () => {
    const workflow = readFileSync(
      resolve(process.cwd(), '../.github/workflows/wework-app.yml'),
      'utf8'
    )
    const packageManifest = JSON.parse(
      readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
    ) as {
      scripts: Record<string, string>
    }
    const installerHooks = readFileSync(
      resolve(process.cwd(), 'electron/scripts/installer.nsh'),
      'utf8'
    )
    const builderConfig = readFileSync(
      resolve(process.cwd(), 'electron/electron-builder.config.cjs'),
      'utf8'
    )
    const packageAssetsScript = readFileSync(
      resolve(process.cwd(), 'electron/scripts/prepare-package-assets.mjs'),
      'utf8'
    )

    expect(workflow).toContain('pnpm --filter wework build:release')
    expect(packageManifest.scripts['build:release']).toContain('pnpm --dir electron build:release')
    expect(packageAssetsScript).toMatch(
      /WEWORK_SOURCE_SHA\?\.trim\(\)\s*\|\|\s*process\.env\.GITHUB_SHA\?\.trim\(\)/
    )
    expect(builderConfig).toContain('appId: identity.identifier')
    expect(builderConfig).toContain('productName: identity.productName')
    expect(builderConfig).toContain('executableName: identity.executableName')
    expect(builderConfig).toContain('weworkAppId: identity.identifier')
    expect(workflow).toMatch(
      /- name: Prepare Apple signing keychain[\s\S]*?security import[\s\S]*?APPLE_SIGNING_IDENTITY=[\s\S]*?MACOS_KEYCHAIN_PATH=/
    )
    expect(workflow).toContain('security list-keychains -d user -s')
    expect(workflow).toContain('generate-desktop-update-manifests.mjs')
    expect(workflow).toContain('plan-desktop-release.mjs')
    expect(workflow).not.toContain('prepare-rolling-desktop-installers.mjs')
    expect(workflow).toContain('CURRENT_SOURCE_REF')
    expect(workflow).toContain('RELEASE_KIND')
    expect(workflow).toContain('TAURI_SIGNING_PRIVATE_KEY')
    expect(workflow).toContain('release-manifests/*')
    expect(workflow).toContain("! -name 'WeworkComponent_coreDsh_*.tar.gz'")
    expect(workflow).toContain("! -name 'WeworkComponent_codex_*.tar.gz'")
    expect(workflow).toContain("! -name 'WeworkComponent_dws_*.tar.gz'")
    expect(workflow).toContain('Reusing immutable component asset')
    expect(workflow).toContain('components-${channel}-linux-x64.json')
    expect(
      readFileSync(
        resolve(process.cwd(), 'electron/src/runtime/component-update-manager.ts'),
        'utf8'
      )
    ).toContain("'bundledPlugins'")
    expect(
      readFileSync(
        resolve(process.cwd(), 'electron/src/runtime/component-update-manager.ts'),
        'utf8'
      )
    ).toContain("'dws'")
    expect(workflow).toMatch(
      /gh release upload wework-updater "\$component_asset"\s+echo "\$component_name"/
    )
    expect(workflow).toMatch(
      /if \[\[ "\$RELEASE_KIND" == "component" \]\]; then[\s\S]*release-manifests\/components-\$\{channel\}-macos-arm64\.json/
    )
    expect(workflow).toMatch(
      /- name: Commit Wework version files[\s\S]*?GH_TOKEN: \$\{\{ steps\.release-app-token\.outputs\.token \}\}/
    )
    expect(workflow).toMatch(
      /- name: Create or update draft release[\s\S]*?GH_REPO: \$\{\{ github\.repository \}\}/
    )
    expect(workflow).toMatch(
      /- name: Resolve previous Wework release[\s\S]*?resolve-previous-release-tag\.mjs/
    )
    expect(workflow).toContain(
      "PREVIOUS_TAG: ${{ steps.plan.outputs.kind == 'component' && steps.plan.outputs.base_tag || steps.previous-release.outputs.tag }}"
    )
    expect(workflow).toMatch(
      /- name: Upload formal release assets\s+env:[\s\S]*find release-assets/
    )
    expect(workflow.indexOf('- name: Publish version release')).toBeLessThan(
      workflow.indexOf('- name: Publish rolling update channels')
    )
    expect(workflow.indexOf('- name: Publish rolling update channels')).toBeLessThan(
      workflow.indexOf('- name: Promote stable release to latest')
    )
    expect(workflow).toMatch(/gh release edit "\$RELEASE_TAG"[\s\S]*--target "\$RELEASE_SHA"/)
    expect(installerHooks).toContain('Software\\you\\WeWork')
    expect(installerHooks).toContain('InstallLocation')
    expect(installerHooks).toContain('${GetOptions} $R0 "/P"')
    expect(installerHooks).toContain('$R0\\${APP_EXECUTABLE_FILENAME}')
  })

  test('publishes packaged Electron artifacts for all desktop platforms', () => {
    const workflow = readFileSync(
      resolve(process.cwd(), '../.github/workflows/wework-app.yml'),
      'utf8'
    )

    expect(workflow).toContain('macos-14')
    expect(workflow).toContain('windows-latest')
    expect(workflow).toContain('ubuntu-latest')
    expect(workflow).toContain('macOS arm64')
    expect(workflow).toContain('macOS x64')
    expect(workflow).toContain('merge-multiple: true')
  })
})
