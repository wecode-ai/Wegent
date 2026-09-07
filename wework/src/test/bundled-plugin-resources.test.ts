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
const weworkPluginDeveloperDirectory = 'dsh/plugin-developer'

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

  test('owns the official Codex development plugin inside the Wework plugin package', () => {
    const resourcesDirectory = resolve(process.cwd(), 'resources')
    const weworkDirectory = resolve(process.cwd())
    const marketplace = JSON.parse(
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
    const weworkManifest = JSON.parse(
      readFileSync(resolve(weworkDirectory, weworkPluginDeveloperDirectory, 'package.json'), 'utf8')
    ) as { version?: string; wework?: { codexPlugin?: string } }
    const codexPluginRoot = resolve(
      weworkDirectory,
      weworkPluginDeveloperDirectory,
      weworkManifest.wework?.codexPlugin ?? ''
    )
    const codexManifest = JSON.parse(
      readFileSync(resolve(codexPluginRoot, '.codex-plugin/plugin.json'), 'utf8')
    ) as Record<string, unknown>

    expect(weworkManifest.wework?.codexPlugin).toBe('./codex-plugin')
    expect(codexManifest.name).toBe('wework-plugin-developer')
    expect(weworkManifest.version).toBe(codexManifest.version)
    expect(Object.keys(codexManifest)).toEqual([
      'name',
      'version',
      'description',
      'author',
      'skills',
      'interface',
    ])
    expect(
      marketplace.plugins.find(plugin => plugin.name === 'wework-plugin-developer')?.policy
        ?.installation
    ).toBe('INSTALLED_BY_DEFAULT')
    const claudeMarketplace = JSON.parse(
      readFileSync(
        resolve(
          resourcesDirectory,
          'bundled-plugins/wework-personal/.claude-plugin/marketplace.json'
        ),
        'utf8'
      )
    ) as { plugins: Array<{ name: string; version?: string }> }
    expect(
      claudeMarketplace.plugins.find(plugin => plugin.name === 'wework-plugin-developer')?.version
    ).toBe(codexManifest.version)
    const skillRoot = resolve(codexPluginRoot, 'skills/develop-wework-plugin')
    expect(readFileSync(resolve(skillRoot, 'SKILL.md'), 'utf8')).toContain(
      'Never edit files inside an installed plugin cache'
    )
    expect(readFileSync(resolve(skillRoot, 'SKILL.md'), 'utf8')).toContain(
      'wework desktop inspect --project .'
    )
    expect(existsSync(resolve(codexPluginRoot, '.mcp.json'))).toBe(false)
    expect(existsSync(resolve(skillRoot, 'references/extension-points.md'))).toBe(true)
    expect(existsSync(resolve(skillRoot, 'assets/ui-extension-demo/client.js'))).toBe(true)
    expect(
      existsSync(
        resolve(
          resourcesDirectory,
          'bundled-plugins/wework-personal/plugins/wework-plugin-developer/.codex-plugin/plugin.json'
        )
      )
    ).toBe(false)
  })

  test('delegates Smart App verification and packaging to the Wework host', () => {
    const script = readFileSync(
      resolve(
        process.cwd(),
        'resources',
        bundledSmartAppBuilderDirectory,
        'scripts/smart-app-tool.mjs'
      ),
      'utf8'
    )
    const skill = readFileSync(
      resolve(
        process.cwd(),
        'resources',
        bundledSmartAppBuilderDirectory,
        'skills/create-smart-app/SKILL.md'
      ),
      'utf8'
    )

    expect(script).toContain("spawnSync('wework'")
    expect(script).toContain("['smart-app', command, '--project', root, '--format', 'json']")
    expect(script).toContain("case 'inspect'")
    expect(script).toContain("case 'verify'")
    expect(script).toContain("case 'pack'")
    expect(script).not.toContain('function validate(')
    expect(script).not.toContain('function pack(')
    expect(script).not.toContain('execFileSync')
    expect(skill).toContain('inspect → contract → doctor → verify → preview → pack')
    expect(skill).toContain('structured error code')
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
    expect(workflow).toContain("! -name 'WeworkComponent_*.tar.gz'")
    expect(workflow).toContain('desktop-component-release.mjs release-assets version')
    expect(workflow).toContain('desktop-component-release.mjs release-assets shared')
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
    expect(workflow).not.toContain('macos-15-intel')
    expect(workflow).not.toContain('Install Rosetta 2')
    expect(workflow).not.toContain('node_arch')
    expect(workflow).toContain('WEWORK_ELECTRON_DEPENDENCIES_READY: "true"')
    expect(workflow).toContain('WEWORK_E2E_PARALLEL_CHECKPOINTS: "3"')
    expect(workflow).toContain(
      '--parallel-segments release-package-startup,component-update,app-update-differential'
    )
    expect(workflow).toContain('windows-latest')
    expect(workflow).toContain('ubuntu-latest')
    expect(workflow).toContain('macOS arm64')
    expect(workflow).toContain('macOS x64')
    expect(workflow).toContain('merge-multiple: true')
  })
})
