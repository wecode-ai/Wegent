// @vitest-environment node

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
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

function skillCliFixture(root: string) {
  const bin = join(root, 'old-bin')
  const instance = join(root, 'instance tools')
  mkdirSync(bin)
  mkdirSync(instance)
  const launcher = join(instance, 'wework')
  const log = join(root, 'bound-calls.jsonl')
  const bareLog = join(root, 'bare-called')
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`
  const source = `const fs = require('node:fs');
const args = process.argv.slice(1);
fs.appendFileSync(process.env.WEWORK_TEST_LOG, JSON.stringify(args) + '\\n');
if (args[1] === 'install' && process.env.WEWORK_TEST_CANCEL === '1') {
  console.log('null');
  process.exit(1);
}
console.log(JSON.stringify({ id: 'bound-app' }));`
  writeFileSync(launcher, `#!/bin/sh\nexec ${quote(process.execPath)} -e ${quote(source)} "$@"\n`)
  chmodSync(launcher, 0o700)
  writeFileSync(join(bin, 'wework'), '#!/bin/sh\n: > "$WEWORK_TEST_BARE_LOG"\nexit 97\n')
  chmodSync(join(bin, 'wework'), 0o700)
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    PATH: [bin, process.env.PATH].filter(Boolean).join(delimiter),
    WEWORK_TEST_LOG: log,
    WEWORK_TEST_BARE_LOG: bareLog,
  }
  delete environment.WEWORK_CLI_PATH
  return { environment, launcher, log, bareLog }
}

describe('bundled plugin resources', () => {
  test.runIf(process.platform !== 'win32').each(['available', 'missing'])(
    'builder tools preserve task identity and argument boundaries when the binding is %s',
    mode => {
      const root = mkdtempSync(join(tmpdir(), 'workbench-builder-cli-'))
      try {
        const { environment, launcher, log, bareLog } = skillCliFixture(root)
        const helper = resolve(
          process.cwd(),
          'resources',
          bundledSmartAppBuilderDirectory,
          'scripts/smart-app-tool.mjs'
        )
        const project = join(root, "project with 'quotes' and $(untrusted)")
        if (mode === 'available') environment.WEWORK_CLI_PATH = launcher
        const result = spawnSync(process.execPath, [helper, 'verify', project], {
          env: environment,
          encoding: 'utf8',
        })
        if (mode === 'available') {
          expect(result.status, result.stderr).toBe(0)
          expect(JSON.parse(readFileSync(log, 'utf8'))).toEqual([
            'smart-app',
            'verify',
            '--project',
            project,
            '--format',
            'json',
          ])
          expect(readFileSync(log, 'utf8').trim().split('\n')).toHaveLength(1)
        } else {
          expect(result.status).toBe(1)
          expect(result.stderr).toContain('Task-bound Wework CLI unavailable')
          expect(existsSync(log)).toBe(false)
        }
        expect(existsSync(bareLog)).toBe(false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  test('rejects release hosts that differ from the target even when Node matches', () => {
    const workflow = readFileSync(
      resolve(process.cwd(), '../.github/workflows/wework-app.yml'),
      'utf8'
    )
    const guard = workflow.match(
      /Verify native build architecture[\s\S]*?node -e '([\s\S]*?)'/
    )?.[1]
    expect(guard).toBeDefined()
    const nativeHost = process.arch === 'arm64' ? 'ARM64' : 'X64'
    const otherHost = nativeHost === 'ARM64' ? 'X64' : 'ARM64'
    const runGuard = (host: string, target: string) =>
      spawnSync(process.execPath, ['-e', guard!], {
        encoding: 'utf8',
        env: { ...process.env, WEWORK_RUNNER_ARCH: host, WEWORK_RELEASE_ARCH: target },
      })

    expect(runGuard(nativeHost, process.arch).status).toBe(0)
    const translated = runGuard(otherHost, process.arch)
    expect(translated.status).toBe(1)
    expect(translated.stderr).toContain('requires native hardware and Node.js')
    expect(runGuard(nativeHost, process.arch === 'arm64' ? 'x64' : 'arm64').status).toBe(1)
  })

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
    const componentLayout = readFileSync(
      resolve(process.cwd(), 'electron/scripts/bundled-component-layout.cjs'),
      'utf8'
    )
    expect(componentLayout).toContain("'bundled-plugins'")
    expect(packageScript).toContain('...bundledComponentLayout.directories.map')
    expect(packageScript).toContain("join(electronRoot, 'resources', `${name}.tar.gz`)")
  })

  test('packages a runnable MCP server in the plugin example', () => {
    const resourcesDirectory = resolve(process.cwd(), 'resources')
    const mcpManifest = JSON.parse(
      readFileSync(
        resolve(resourcesDirectory, 'bundled-plugins/wework-plugin-example/.mcp.json'),
        'utf8'
      )
    ) as {
      mcpServers?: Record<
        string,
        {
          command?: string
          args?: string[]
          cwd?: string
        }
      >
    }
    const example = mcpManifest.mcpServers?.example

    expect(example).toEqual({
      command: 'node',
      args: ['./mcp/server.mjs'],
      cwd: '.',
    })
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

  test('discovers host workflow metadata from the default runtime plugin', () => {
    const root = resolve(process.cwd(), 'resources/bundled-plugins/wework-personal')
    const marketplace = JSON.parse(
      readFileSync(resolve(root, '.agents/plugins/marketplace.json'), 'utf8')
    )
    expect(
      marketplace.plugins.find((plugin: { name: string }) => plugin.name === 'wework-runtime')
        ?.policy?.installation
    ).toBe('INSTALLED_BY_DEFAULT')
    const plugin = resolve(root, 'plugins/wework-runtime')
    const manifest = JSON.parse(readFileSync(resolve(plugin, '.codex-plugin/plugin.json'), 'utf8'))
    expect(manifest.skills).toBe('./skills/')
    expect(existsSync(resolve(plugin, 'skills/coding/SKILL.md'))).toBe(false)
    for (const name of [
      'browser',
      'computer',
      'github',
      'connector-auth',
      'conversations',
      'visualize',
      'artifacts',
      'workbenches',
    ]) {
      const skill = readFileSync(resolve(plugin, 'skills', name, 'SKILL.md'), 'utf8')
      expect(skill).toMatch(/^---\nname: /)
      expect(skill).toContain('description:')
    }
    expect(readFileSync(resolve(plugin, 'skills/browser/SKILL.md'), 'utf8')).toContain(
      'browser_inspect'
    )
    expect(readFileSync(resolve(plugin, 'skills/github/SKILL.md'), 'utf8')).toContain(
      'connectorSlug=wework-github-cli'
    )
  })

  test('creates both DSH flavors through one lifecycle and preserves native installation grants', () => {
    const root = resolve(process.cwd(), 'resources/bundled-plugins/wework-personal')
    const plugin = resolve(root, 'plugins/wework-runtime')
    const skill = readFileSync(resolve(plugin, 'skills/workbenches/SKILL.md'), 'utf8')
    expect(skill).toContain('request_user_input_async')
    expect(skill).toContain('do not add a')
    expect(skill).toContain('mandatory format questionnaire')
    expect(skill).toContain('All workbenches use Wework')
    expect(skill).not.toMatch(/^wework (?:workbench|desktop) /m)
    expect(skill).toContain('do not authorize system')
    expect(skill).toContain('Do not bypass the confirmation')
    expect(skill).toContain('window.weworkWorkbench')
    expect(skill).toContain('storage.get()')
    expect(skill).toContain('storage.set(value)')
    expect(skill).toContain('storage.commit({ value, reminders? })')
    expect(skill).toContain('even `[]` requires the')
    expect(skill).toMatch(/at most 100\s+reminders with unique IDs/)
    expect(skill).toContain('`mailto:`')
    expect(skill).toContain('reminders.schedule')
    expect(existsSync(resolve(plugin, 'skills/coding'))).toBe(false)
    const hostInstructions = readFileSync(
      resolve(process.cwd(), '../executor/src/agents/codex/host_skills.rs'),
      'utf8'
    )
    expect(hostInstructions).toContain('read workbenches and use the task-bound WEWORK_CLI_PATH')
    expect(hostInstructions).toContain('Both lightweight and extended workbenches use DSH')
    const manifest = JSON.parse(readFileSync(resolve(plugin, '.codex-plugin/plugin.json'), 'utf8'))
    const claudeManifest = JSON.parse(
      readFileSync(resolve(plugin, '.claude-plugin/plugin.json'), 'utf8')
    )
    expect(claudeManifest.version).toBe(manifest.version)
    const marketplace = JSON.parse(
      readFileSync(resolve(root, '.claude-plugin/marketplace.json'), 'utf8')
    )
    expect(
      marketplace.plugins.find((entry: { name: string }) => entry.name === 'wework-runtime').version
    ).toBe(manifest.version)
  })

  test.runIf(process.platform !== 'win32').each(['available', 'missing', 'cancelled'])(
    'executes workbench skill examples through the task binding when %s',
    mode => {
      const skill = readFileSync(
        resolve(
          process.cwd(),
          'resources/bundled-plugins/wework-personal/plugins/wework-runtime/skills/workbenches/SKILL.md'
        ),
        'utf8'
      )
      const install = skill.match(/```sh\n([\s\S]*?)```/)?.[1]
      const launch = skill.match(/`("\$WEWORK_CLI_PATH" workbench launch [^`]+)`/)?.[1]
      expect(install).toBeDefined()
      expect(launch).toBeDefined()
      const root = mkdtempSync(join(tmpdir(), 'wework-skill-cli-'))
      try {
        const { environment, launcher, log, bareLog } = skillCliFixture(root)
        const project = join(root, "project with spaces and 'quotes'")
        if (mode !== 'missing') environment.WEWORK_CLI_PATH = launcher
        environment.WEWORK_TEST_CANCEL = mode === 'cancelled' ? '1' : '0'
        const installed = spawnSync(
          '/bin/sh',
          ['-c', install!.replace('/absolute/app-directory', project)],
          { env: environment, encoding: 'utf8' }
        )
        if (mode === 'available') {
          expect(installed.status, installed.stderr).toBe(0)
          const id = JSON.parse(installed.stdout).id
          const launched = spawnSync('/bin/sh', ['-c', launch!.replace('INSTALLATION_ID', id)], {
            env: environment,
            encoding: 'utf8',
          })
          expect(launched.status, launched.stderr).toBe(0)
          expect(JSON.parse(launched.stdout).id).toBe(id)
        } else {
          expect(installed.status).toBe(1)
          if (mode === 'missing')
            expect(installed.stderr).toContain('Task-bound Wework CLI unavailable')
          else expect(installed.stdout.trim()).toBe('null')
        }
        const calls = existsSync(log)
          ? readFileSync(log, 'utf8')
              .trim()
              .split('\n')
              .map(line => JSON.parse(line))
          : []
        const installArgs = ['workbench', 'install', '--project', project, '--format', 'json']
        expect(calls).toEqual(
          mode === 'missing'
            ? []
            : mode === 'cancelled'
              ? [installArgs]
              : [installArgs, ['workbench', 'launch', '--id', 'bound-app', '--format', 'json']]
        )
        expect(existsSync(bareLog)).toBe(false)
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

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

    expect(script).toContain('process.env.WEWORK_CLI_PATH')
    expect(script).toContain('spawnSync(launcher, args')
    expect(script).not.toContain("spawnSync('wework'")
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

  test.each([
    ['LF', '\n'],
    ['CRLF', '\r\n'],
  ])(
    'uses the Electron release builder and publishes both updater protocols (%s)',
    (_name, lineEnding) => {
      const workflow = readFileSync(
        resolve(process.cwd(), '../.github/workflows/wework-app.yml'),
        'utf8'
      ).replace(/\r?\n/g, lineEnding)
      const signingKeychainStep = workflow.match(
        / {6}- name: Prepare Apple signing keychain\r?\n(?:(?!\r?\n {6}- name:)[\s\S])*/
      )?.[0]
      const packageManifest = JSON.parse(
        readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')
      ) as {
        scripts: Record<string, string>
      }
      const builderConfig = readFileSync(
        resolve(process.cwd(), 'electron/electron-builder.config.cjs'),
        'utf8'
      )
      const packageAssetsScript = readFileSync(
        resolve(process.cwd(), 'electron/scripts/prepare-package-assets.mjs'),
        'utf8'
      )

      expect(workflow).toContain('pnpm --filter wework build:release')
      expect(packageManifest.scripts['build:release']).toContain(
        'pnpm --dir electron build:release'
      )
      expect(packageAssetsScript).toMatch(
        /WEWORK_SOURCE_SHA\?\.trim\(\)\s*\|\|\s*process\.env\.GITHUB_SHA\?\.trim\(\)/
      )
      expect(builderConfig).toContain('appId: identity.identifier')
      expect(builderConfig).toContain('productName: identity.productName')
      expect(builderConfig).toContain('executableName: identity.executableName')
      expect(builderConfig).toContain('weworkAppId: identity.identifier')
      expect(signingKeychainStep).toContain('security import')
      expect(signingKeychainStep).toContain('security list-keychains -d user -s')
      expect(signingKeychainStep).toContain(
        'echo "APPLE_SIGNING_IDENTITY=$identity" >> "$GITHUB_ENV"'
      )
      expect(signingKeychainStep).toContain('echo "CSC_KEYCHAIN=$keychain_path" >> "$GITHUB_ENV"')
      expect(signingKeychainStep).toContain(
        'echo "MACOS_KEYCHAIN_PATH=$keychain_path" >> "$GITHUB_ENV"'
      )
      expect(workflow).not.toMatch(/^\s+CSC_LINK:/m)
      expect(workflow).not.toMatch(/^\s+CSC_KEY_PASSWORD:/m)
      expect(workflow).toContain('generate-desktop-update-manifests.mjs')
      expect(workflow).toContain('plan-desktop-release.mjs')
      const concurrencyGroup = workflow.match(/^ {2}group: (.+)$/m)?.[1].trim()
      expect(concurrencyGroup).toContain(
        `inputs.verification_run_id != '' || (contains(fromJSON('["app-update-refresh","app-update-retry"]'), inputs.verification_checkpoint) && inputs.verification_source_run_id != '' && !inputs.publish_release)`
      )
      expect(concurrencyGroup).toContain(
        'github.ref, inputs.verification_run_id || inputs.verification_source_run_id)'
      )
      expect(concurrencyGroup).toMatch(/\|\| github\.workflow \}\}$/)
      expect(workflow).not.toContain('group: ${{ github.workflow }}-${{ github.ref }}')
      expect(workflow).not.toContain('prepare-rolling-desktop-installers.mjs')
      expect(workflow).toContain('CURRENT_SOURCE_REF')
      expect(workflow).toContain('RELEASE_KIND')
      expect(workflow).toContain('- name: Prepare desktop release assets')
      expect(workflow).toContain('release-manifests/*')
      expect(workflow).toContain("! -name 'WeworkComponent_*.tar.gz'")
      expect(workflow).toMatch(
        /node wework\/scripts\/upload-desktop-component-assets\.mjs\s+\\\s+release-assets version "\$RELEASE_TAG"/
      )
      expect(workflow).toContain('desktop-component-release.mjs release-assets shared')
      expect(workflow).toContain('Reusing immutable component asset')
      expect(workflow).toContain('collect-harness-runtime-release-assets.mjs')
      const publishJob = workflow.slice(workflow.indexOf('  publish:'))
      expect(publishJob).toMatch(
        /Checkout release source[\s\S]*?uses: \.\/\.github\/actions\/setup-node-workspace[\s\S]*?collect-harness-runtime-release-assets\.mjs/
      )
      expect(workflow).toContain('Reusing immutable Harness Runtime asset')
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
      expect(workflow).not.toContain('"$RELEASE_KIND" == "component"')
      expect(workflow).toContain('Release $RELEASE_TAG is already published. Use a new version.')
      expect(workflow.indexOf('- name: Validate release target')).toBeLessThan(
        workflow.indexOf('- name: Commit Wework version files')
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
      expect(workflow).toContain('PREVIOUS_TAG: ${{ steps.previous-release.outputs.tag }}')
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
    }
  )

  test('publishes packaged Electron artifacts for all desktop platforms', () => {
    const workflow = readFileSync(
      resolve(process.cwd(), '../.github/workflows/wework-app.yml'),
      'utf8'
    )

    expect(workflow).toMatch(/name: macOS arm64\s+runner: macos-15\s+platform: macos\s+arch: arm64/)
    expect(workflow).toMatch(
      /name: macOS x64\s+runner: macos-15-intel\s+platform: macos\s+arch: x64/
    )
    expect(workflow).not.toContain('Install Rosetta 2')
    expect(workflow).not.toContain('node_arch')
    expect(workflow).toContain('WEWORK_RUNNER_ARCH: ${{ runner.arch }}')
    expect(workflow).toContain('process.arch !== expected || host !== expected')
    expect(workflow.indexOf('- name: Verify native build architecture')).toBeGreaterThan(
      workflow.indexOf('- name: Set up Node.js')
    )
    expect(workflow.indexOf('- name: Verify native build architecture')).toBeLessThan(
      workflow.indexOf('- name: Install workspace dependencies')
    )
    expect(workflow).toContain('- name: Upload formal release verification diagnostics')
    expect(workflow).toContain('if: failure() && matrix.platform ==')
    expect(workflow).toContain('wework/test-results/desktop-e2e/')
    expect(workflow).toContain('WEWORK_ELECTRON_DEPENDENCIES_READY: "true"')
    expect(workflow).toContain('WEWORK_E2E_PARALLEL_CHECKPOINTS: "1"')
    expect(workflow).toContain('--parallel-segments release-package-startup,component-update')
    expect(workflow).toContain('node wework/scripts/verify-release-upgrades.mjs')
    const upgradeVerifier = readFileSync(
      resolve(process.cwd(), 'scripts/verify-release-upgrades.mjs'),
      'utf8'
    )
    expect(upgradeVerifier).toContain(
      'diagnosticCheckpoint || upgradeVerificationCheckpoint(platform)'
    )
    expect(workflow).toContain('windows-latest')
    expect(workflow).toContain('ubuntu-latest')
    expect(workflow).toContain('macOS arm64')
    expect(workflow).toContain('macOS x64')
    expect(workflow).toContain('merge-multiple: true')
  })
})
