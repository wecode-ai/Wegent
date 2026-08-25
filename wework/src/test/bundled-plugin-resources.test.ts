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

  test('uses the Electron packager in GitHub desktop releases', () => {
    const workflow = readFileSync(
      resolve(process.cwd(), '../.github/workflows/wework-app.yml'),
      'utf8'
    )

    expect(workflow).toContain('ai:verify:electron:build')
  })

  test('publishes packaged Electron artifacts for all desktop platforms', () => {
    const workflow = readFileSync(
      resolve(process.cwd(), '../.github/workflows/wework-app.yml'),
      'utf8'
    )

    expect(workflow).toContain('macos-14')
    expect(workflow).toContain('windows-latest')
    expect(workflow).toContain('ubuntu-latest')
    expect(workflow).toContain('name: wework-${{ needs.prepare-release.outputs.version }}-')
  })
})
