import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  CORE_DSH_VERSION,
  prepareCoreDshLaunch,
  selectBundledDshRuntimeMatching,
  selectCoreDshRuntime,
} from './core-dsh-runtime.js'
import { temporaryDirectory } from './test-helpers.js'

describe('core DSH runtime', () => {
  test('selects only the bundled core version', async () => {
    const root = await temporaryDirectory('core-dsh-selection-')
    const rc8 = await writeRuntime(root.path, '0.1.0-rc.8', '8')
    const core = await writeRuntime(root.path, CORE_DSH_VERSION, '2')
    await writeRuntime(root.path, '0.1.2-rc.1', 'f')
    await writeFile(
      join(root.path, 'runtimes.json'),
      JSON.stringify({
        runtimes: [rc8, core].map(runtime => ({
          sourceFingerprint: runtime.fingerprint,
        })),
      })
    )

    await expect(selectCoreDshRuntime(root.path, core.pluginsRoot)).resolves.toMatchObject({
      version: CORE_DSH_VERSION,
    })
    await root.remove()
  })

  test('prefers the runtime catalog over stale direct-runtime metadata', async () => {
    const root = await temporaryDirectory('core-dsh-stale-root-')
    const core = await writeRuntime(root.path, CORE_DSH_VERSION, '2')
    await writeFile(
      join(root.path, 'runtime.json'),
      JSON.stringify({
        dshVersion: '0.1.0-rc.8',
        sourceFingerprint: '8'.repeat(64),
      })
    )
    await writeFile(
      join(root.path, 'runtimes.json'),
      JSON.stringify({ runtimes: [{ sourceFingerprint: core.fingerprint }] })
    )

    await expect(selectCoreDshRuntime(root.path, core.pluginsRoot)).resolves.toMatchObject({
      version: CORE_DSH_VERSION,
    })
    await root.remove()
  })

  test('selects the highest bundled runtime satisfying a version requirement', async () => {
    const root = await temporaryDirectory('workbench-dsh-selection-')
    await writeRuntime(root.path, '0.1.0-rc.8', '8')
    await writeRuntime(root.path, '0.1.0-rc.9', '9')
    await writeRuntime(root.path, '0.1.1-rc.1', 'a')

    await expect(
      selectBundledDshRuntimeMatching(root.path, 'workbench', '>=0.1.0-rc.8 <=0.1.0-rc.9')
    ).resolves.toMatchObject({
      version: '0.1.0-rc.9',
    })
    await expect(
      selectBundledDshRuntimeMatching(root.path, 'workbench', '0.1.0-rc.8')
    ).resolves.toMatchObject({
      version: '0.1.0-rc.8',
    })
    await root.remove()
  })

  test('prepares a profile once for one runtime fingerprint', async () => {
    const root = await temporaryDirectory('core-dsh-profile-')
    const runtime = await writeRuntime(root.path, CORE_DSH_VERSION, 'a')
    const dataDirectory = join(root.path, 'data')

    const first = await prepareCoreDshLaunch({
      runtimeRoot: runtime.root,
      dataDirectory,
      environment: {
        PATH: '/usr/bin',
        WEWORK_CORE_PLUGIN_ROOT: runtime.pluginsRoot,
        WEWORK_CORE_PLUGINS_SHA256: 'f'.repeat(64),
        WEWORK_NODE_PATH: '/managed/node',
      },
      port: 3080,
    })
    const second = await prepareCoreDshLaunch({
      runtimeRoot: runtime.root,
      dataDirectory,
      environment: {
        PATH: '/usr/bin',
        WEWORK_CORE_PLUGIN_ROOT: runtime.pluginsRoot,
        WEWORK_CORE_PLUGINS_SHA256: 'f'.repeat(64),
        WEWORK_NODE_PATH: '/managed/node',
      },
      port: 3081,
    })

    expect(first.command).toBe('/managed/node')
    expect(first.args).toContain('3080')
    expect(first.environment).toMatchObject({
      DSH_HOME: join(dataDirectory, 'dsh-core'),
      WEWORK_HARNESS_API_KEY: 'wework-local-router',
    })
    expect(second.args).toContain('3081')
    expect(
      JSON.parse(
        await readFile(
          join(dataDirectory, 'dsh-core', 'profiles', 'wework-core', 'package.json'),
          'utf8'
        )
      )
    ).toMatchObject({
      dependencies: {
        '@wegent/dsh-app-wework': expect.stringContaining('wework-app'),
        '@wegent/dsh-browser-runtime': expect.stringContaining('wework-browser-runtime'),
        '@wegent/dsh-electron-host': expect.stringContaining('wework-electron-host'),
        '@wegent/dsh-executor-runtime': expect.stringContaining('wework-executor-runtime'),
        '@wegent/dsh-secure-storage': expect.stringContaining('wework-secure-storage'),
        '@wegent/dsh-terminal-runtime': expect.stringContaining('wework-terminal-runtime'),
        '@wegent/dsh-ui-core-apps': expect.stringContaining('wework-ui-core-apps'),
        '@wegent/dsh-ui-core-settings': expect.stringContaining('wework-ui-core-settings'),
        '@wegent/dsh-ui-plugin-center': expect.stringContaining('wework-ui-plugin-center'),
        '@wegent/dsh-ui-applications': expect.stringContaining('wework-ui-applications'),
        '@wegent/dsh-ui-automations': expect.stringContaining('wework-ui-automations'),
        '@wegent/dsh-ui-cloud-work': expect.stringContaining('wework-ui-cloud-work'),
        '@wegent/dsh-ui-git': expect.stringContaining('wework-ui-git'),
      },
      dsh: {
        profile: {
          bundles: [
            '@deepseek-ai/dsh-base',
            '@wegent/dsh-electron-host',
            '@wegent/dsh-browser-runtime',
            '@wegent/dsh-secure-storage',
            '@wegent/dsh-terminal-runtime',
            '@wegent/dsh-app-wework',
            '@deepseek-ai/dsh-web-app',
            '@wegent/dsh-executor-runtime',
            '@wegent/dsh-ui-core-apps',
            '@wegent/dsh-ui-core-settings',
            '@wegent/dsh-ui-plugin-center',
            '@wegent/dsh-ui-applications',
            '@wegent/dsh-ui-automations',
            '@wegent/dsh-ui-cloud-work',
            '@wegent/dsh-ui-git',
          ],
        },
      },
    })
    expect(
      JSON.parse(
        await readFile(
          join(dataDirectory, 'dsh-core', 'profiles', 'wework-core', '.wework-runtime.json'),
          'utf8'
        )
      )
    ).toEqual({
      dshVersion: CORE_DSH_VERSION,
      managedUiPlugins: true,
      role: 'core',
      sourceFingerprint: 'a'.repeat(64),
      corePluginsFingerprint: 'f'.repeat(64),
    })
    const profileModules = join(
      dataDirectory,
      'dsh-core',
      'profiles',
      'wework-core',
      'node_modules',
      '@wegent'
    )
    await expect(
      readFile(join(profileModules, 'dsh-app-wework', 'package.json'), 'utf8')
    ).resolves.toBe('{}')
    await expect(
      readFile(join(profileModules, 'dsh-electron-host', 'package.json'), 'utf8')
    ).resolves.toBe('{}')
    await expect(
      readFile(join(profileModules, 'dsh-executor-runtime', 'package.json'), 'utf8')
    ).resolves.toBe('{}')
    await expect(
      readFile(join(profileModules, 'dsh-terminal-runtime', 'package.json'), 'utf8')
    ).resolves.toBe('{}')
    await expect(
      readFile(join(profileModules, 'dsh-ui-core-apps', 'package.json'), 'utf8')
    ).resolves.toBe('{}')
    await expect(
      readFile(join(profileModules, 'dsh-ui-core-settings', 'package.json'), 'utf8')
    ).resolves.toBe('{}')
    await expect(
      readFile(join(profileModules, 'dsh-ui-plugin-center', 'package.json'), 'utf8')
    ).resolves.toBe('{}')
    await expect(
      readFile(join(profileModules, 'dsh-ui-applications', 'package.json'), 'utf8')
    ).resolves.toBe('{}')
    await expect(
      readFile(join(profileModules, 'dsh-ui-automations', 'package.json'), 'utf8')
    ).resolves.toBe('{}')
    await expect(
      readFile(join(profileModules, 'dsh-ui-cloud-work', 'package.json'), 'utf8')
    ).resolves.toBe('{}')
    await expect(
      readFile(join(profileModules, 'dsh-ui-git', 'package.json'), 'utf8')
    ).resolves.toBe('{}')
    await root.remove()
  })

  test('refreshes the profile when only the host fingerprint changes', async () => {
    const root = await temporaryDirectory('core-dsh-host-change-')
    const firstRuntime = await writeRuntime(root.path, CORE_DSH_VERSION, 'a')
    const dataDirectory = join(root.path, 'data')
    const environment = {
      PATH: '/usr/bin',
      WEWORK_CORE_PLUGINS_SHA256: 'f'.repeat(64),
      WEWORK_NODE_PATH: '/managed/node',
    }
    await prepareCoreDshLaunch({
      runtimeRoot: firstRuntime.root,
      dataDirectory,
      environment: {
        ...environment,
        WEWORK_CORE_PLUGIN_ROOT: firstRuntime.pluginsRoot,
      },
      port: 3080,
    })
    const secondRuntime = await writeRuntime(root.path, CORE_DSH_VERSION, 'b')
    const second = await prepareCoreDshLaunch({
      runtimeRoot: secondRuntime.root,
      dataDirectory,
      environment: {
        ...environment,
        WEWORK_CORE_PLUGIN_ROOT: secondRuntime.pluginsRoot,
      },
      port: 3081,
    })

    const profileRoot = join(second.dshHome, 'profiles', 'wework-core')
    const manifest = JSON.parse(await readFile(join(profileRoot, 'package.json'), 'utf8'))
    expect(manifest.dependencies['@wegent/dsh-app-wework']).toBe(
      `file:${secondRuntime.pluginRoots['@wegent/dsh-app-wework']}`
    )
    expect(
      JSON.parse(await readFile(join(profileRoot, '.wework-runtime.json'), 'utf8'))
    ).toMatchObject({
      sourceFingerprint: 'b'.repeat(64),
      corePluginsFingerprint: 'f'.repeat(64),
    })
    await root.remove()
  })

  test('keeps managed copies untouched when the fingerprint matches on restart', async () => {
    const root = await temporaryDirectory('core-dsh-fast-path-')
    const runtime = await writeRuntime(root.path, CORE_DSH_VERSION, 'a')
    const dataDirectory = join(root.path, 'data')
    const environment = {
      PATH: '/usr/bin',
      WEWORK_CORE_PLUGIN_ROOT: runtime.pluginsRoot,
      WEWORK_CORE_PLUGINS_SHA256: 'f'.repeat(64),
      WEWORK_NODE_PATH: '/managed/node',
    }
    const launch = await prepareCoreDshLaunch({
      runtimeRoot: runtime.root,
      dataDirectory,
      environment,
      port: 3080,
    })
    const pluginCopyRoot = join(
      launch.dshHome,
      'profiles',
      'wework-core',
      'node_modules',
      '@wegent',
      'dsh-app-wework'
    )
    await writeFile(join(pluginCopyRoot, 'local-helper.js'), 'local')

    await prepareCoreDshLaunch({
      runtimeRoot: runtime.root,
      dataDirectory,
      environment,
      port: 3081,
    })

    await expect(readFile(join(pluginCopyRoot, 'local-helper.js'), 'utf8')).resolves.toBe('local')
    await root.remove()
  })

  test('re-syncs managed plugin copies when only the plugin fingerprint changes', async () => {
    const root = await temporaryDirectory('core-dsh-plugin-change-')
    const runtime = await writeRuntime(root.path, CORE_DSH_VERSION, 'a')
    const dataDirectory = join(root.path, 'data')
    const environment = {
      PATH: '/usr/bin',
      WEWORK_CORE_PLUGIN_ROOT: runtime.pluginsRoot,
      WEWORK_NODE_PATH: '/managed/node',
    }
    const first = await prepareCoreDshLaunch({
      runtimeRoot: runtime.root,
      dataDirectory,
      environment,
      port: 3080,
    })
    const profileRoot = join(first.dshHome, 'profiles', 'wework-core')
    const stampPath = join(profileRoot, '.wework-runtime.json')
    const firstFingerprint = (
      JSON.parse(await readFile(stampPath, 'utf8')) as { corePluginsFingerprint: string }
    ).corePluginsFingerprint
    await writeFile(
      join(runtime.pluginRoots['@wegent/dsh-app-wework'], 'package.json'),
      '{"name":"@wegent/dsh-app-wework","version":"2.0.0"}\n'
    )

    const second = await prepareCoreDshLaunch({
      runtimeRoot: runtime.root,
      dataDirectory,
      environment,
      port: 3081,
    })

    const secondFingerprint = (
      JSON.parse(await readFile(stampPath, 'utf8')) as { corePluginsFingerprint: string }
    ).corePluginsFingerprint
    expect(secondFingerprint).not.toBe(firstFingerprint)
    expect(
      await readFile(
        join(
          second.dshHome,
          'profiles',
          'wework-core',
          'node_modules',
          '@wegent',
          'dsh-app-wework',
          'package.json'
        ),
        'utf8'
      )
    ).toBe('{"name":"@wegent/dsh-app-wework","version":"2.0.0"}\n')
    await root.remove()
  })

  test('upgrades a legacy stamp without the plugin fingerprint', async () => {
    const root = await temporaryDirectory('core-dsh-legacy-stamp-')
    const runtime = await writeRuntime(root.path, CORE_DSH_VERSION, 'a')
    const dataDirectory = join(root.path, 'data')
    const environment = {
      PATH: '/usr/bin',
      WEWORK_CORE_PLUGIN_ROOT: runtime.pluginsRoot,
      WEWORK_CORE_PLUGINS_SHA256: 'f'.repeat(64),
      WEWORK_NODE_PATH: '/managed/node',
    }
    const launch = await prepareCoreDshLaunch({
      runtimeRoot: runtime.root,
      dataDirectory,
      environment,
      port: 3080,
    })
    const stampPath = join(launch.dshHome, 'profiles', 'wework-core', '.wework-runtime.json')
    const legacy = JSON.parse(await readFile(stampPath, 'utf8')) as Record<string, unknown>
    delete legacy.corePluginsFingerprint
    await writeFile(stampPath, JSON.stringify(legacy))

    await prepareCoreDshLaunch({
      runtimeRoot: runtime.root,
      dataDirectory,
      environment,
      port: 3081,
    })

    expect(JSON.parse(await readFile(stampPath, 'utf8'))).toEqual({
      dshVersion: CORE_DSH_VERSION,
      managedUiPlugins: true,
      role: 'core',
      sourceFingerprint: 'a'.repeat(64),
      corePluginsFingerprint: 'f'.repeat(64),
    })
    await root.remove()
  })

  test('removes stale managed files when refreshing the profile', async () => {
    const root = await temporaryDirectory('core-dsh-stale-managed-file-')
    const runtime = await writeRuntime(root.path, CORE_DSH_VERSION, 'a')
    const dataDirectory = join(root.path, 'data')
    const environment = {
      PATH: '/usr/bin',
      WEWORK_CORE_PLUGIN_ROOT: runtime.pluginsRoot,
      WEWORK_NODE_PATH: '/managed/node',
    }
    const launch = await prepareCoreDshLaunch({
      runtimeRoot: runtime.root,
      dataDirectory,
      environment,
      port: 3080,
    })
    const pluginCopyRoot = join(
      launch.dshHome,
      'profiles',
      'wework-core',
      'node_modules',
      '@wegent',
      'dsh-app-wework'
    )
    await writeFile(join(pluginCopyRoot, 'stale-helper.js'), 'stale')
    await writeFile(
      join(runtime.pluginRoots['@wegent/dsh-app-wework'], 'package.json'),
      '{"name":"@wegent/dsh-app-wework","version":"2.0.0"}\n'
    )

    await prepareCoreDshLaunch({
      runtimeRoot: runtime.root,
      dataDirectory,
      environment,
      port: 3081,
    })

    await expect(readFile(join(pluginCopyRoot, 'stale-helper.js'), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    })
    expect(await readFile(join(pluginCopyRoot, 'package.json'), 'utf8')).toBe(
      '{"name":"@wegent/dsh-app-wework","version":"2.0.0"}\n'
    )
    await root.remove()
  })

  test('falls back to a deterministic plugins-root fingerprint', async () => {
    const root = await temporaryDirectory('core-dsh-fallback-fingerprint-')
    const runtime = await writeRuntime(root.path, CORE_DSH_VERSION, 'a')
    const dataDirectory = join(root.path, 'data')
    const environment = {
      PATH: '/usr/bin',
      WEWORK_CORE_PLUGIN_ROOT: runtime.pluginsRoot,
      WEWORK_NODE_PATH: '/managed/node',
    }
    const stampPath = join(
      dataDirectory,
      'dsh-core',
      'profiles',
      'wework-core',
      '.wework-runtime.json'
    )
    await prepareCoreDshLaunch({
      runtimeRoot: runtime.root,
      dataDirectory,
      environment,
      port: 3080,
    })
    const first = (
      JSON.parse(await readFile(stampPath, 'utf8')) as { corePluginsFingerprint: string }
    ).corePluginsFingerprint
    expect(first).toMatch(/^[0-9a-f]{64}$/)
    await rm(stampPath)

    await prepareCoreDshLaunch({
      runtimeRoot: runtime.root,
      dataDirectory,
      environment,
      port: 3081,
    })
    expect(
      (JSON.parse(await readFile(stampPath, 'utf8')) as { corePluginsFingerprint: string })
        .corePluginsFingerprint
    ).toBe(first)
    await root.remove()
  })

  test('prepares an empty UI plugin profile for desktop E2E composition coverage', async () => {
    const root = await temporaryDirectory('core-dsh-empty-ui-profile-')
    const runtime = await writeRuntime(root.path, CORE_DSH_VERSION, 'e')
    const dataDirectory = join(root.path, 'data')

    const launch = await prepareCoreDshLaunch({
      runtimeRoot: runtime.root,
      dataDirectory,
      environment: {
        VITE_WEWORK_E2E: 'true',
        WEWORK_CORE_PLUGIN_ROOT: runtime.pluginsRoot,
        WEWORK_E2E_EMPTY_CORE_DSH_UI_PROFILE: '1',
        WEWORK_NODE_PATH: '/managed/node',
      },
      port: 3080,
    })
    const profileRoot = join(launch.dshHome, 'profiles', 'wework-core')
    const manifest = JSON.parse(await readFile(join(profileRoot, 'package.json'), 'utf8'))

    expect(Object.keys(manifest.dependencies)).toEqual([
      '@wegent/dsh-app-wework',
      '@wegent/dsh-electron-host',
      '@wegent/dsh-browser-runtime',
      '@wegent/dsh-secure-storage',
      '@wegent/dsh-executor-runtime',
      '@wegent/dsh-terminal-runtime',
    ])
    expect(manifest.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@wegent/dsh-electron-host',
      '@wegent/dsh-browser-runtime',
      '@wegent/dsh-secure-storage',
      '@wegent/dsh-terminal-runtime',
      '@wegent/dsh-app-wework',
      '@deepseek-ai/dsh-web-app',
      '@wegent/dsh-executor-runtime',
    ])
    await expect(
      readFile(
        join(profileRoot, 'node_modules', '@wegent', 'dsh-ui-core-apps', 'package.json'),
        'utf8'
      )
    ).rejects.toMatchObject({ code: 'ENOENT' })
    expect(
      JSON.parse(await readFile(join(profileRoot, '.wework-runtime.json'), 'utf8'))
    ).toMatchObject({ managedUiPlugins: false })
    await root.remove()
  })

  test('exposes Electron Node internals required by the DSH module loader', async () => {
    const root = await temporaryDirectory('core-dsh-electron-node-')
    const runtime = await writeRuntime(root.path, CORE_DSH_VERSION, 'b')
    const launch = await prepareCoreDshLaunch({
      runtimeRoot: runtime.root,
      dataDirectory: join(root.path, 'data'),
      environment: {
        WEWORK_CORE_PLUGIN_ROOT: runtime.pluginsRoot,
        WEWORK_NODE_PATH: '/managed/node',
        WEWORK_NODE_RUNTIME_KIND: 'electron',
      },
      port: 3080,
    })

    expect(launch.args[0]).toBe('--expose-internals')
    expect(launch.args[1]).toBe(
      join(runtime.root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    )
    await root.remove()
  })

  test('preserves manually installed plugins and their build permissions', async () => {
    const root = await temporaryDirectory('core-dsh-user-plugin-')
    const firstRuntime = await writeRuntime(root.path, CORE_DSH_VERSION, 'a')
    const dataDirectory = join(root.path, 'data')
    const launch = await prepareCoreDshLaunch({
      runtimeRoot: firstRuntime.root,
      dataDirectory,
      environment: {
        WEWORK_CORE_PLUGIN_ROOT: firstRuntime.pluginsRoot,
        WEWORK_NODE_PATH: '/managed/node',
      },
      port: 3080,
    })
    const profileRoot = join(launch.dshHome, 'profiles', 'wework-core')
    const manifestPath = join(profileRoot, 'package.json')
    const workspacePath = join(profileRoot, 'pnpm-workspace.yaml')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.dependencies['dsh-turn-review'] = '1.2.3'
    manifest.dsh.profile.bundles.push('dsh-turn-review')
    await writeFile(manifestPath, JSON.stringify(manifest))
    await writeFile(
      workspacePath,
      [
        'packages:',
        '  - .',
        '',
        'allowBuilds:',
        '  "dsh-turn-review@https://example.test/archive.tgz": true',
        '  node-pty: set this to true or false',
        '',
        'nodeLinker: hoisted',
        'autoInstallPeers: false',
        '',
      ].join('\n')
    )
    await rm(join(profileRoot, '.wework-runtime.json'))

    const nextRuntime = await writeRuntime(root.path, CORE_DSH_VERSION, 'b')
    await prepareCoreDshLaunch({
      runtimeRoot: nextRuntime.root,
      dataDirectory,
      environment: {
        WEWORK_CORE_PLUGIN_ROOT: nextRuntime.pluginsRoot,
        WEWORK_NODE_PATH: '/managed/node',
      },
      port: 3081,
    })

    const nextManifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    expect(nextManifest.dependencies['dsh-turn-review']).toBe('1.2.3')
    expect(nextManifest.dsh.profile.bundles).toContain('dsh-turn-review')
    const workspace = await readFile(workspacePath, 'utf8')
    expect(workspace).toContain('  "dsh-turn-review@https://example.test/archive.tgz": true')
    expect(workspace).toContain('  node-pty: true')
    await root.remove()
  })

  test('repairs node-pty spawn helper permissions even when the profile stamp is current', async () => {
    const root = await temporaryDirectory('core-dsh-node-pty-helper-')
    const runtime = await writeRuntime(root.path, CORE_DSH_VERSION, 'a')
    const dataDirectory = join(root.path, 'data')
    const launch = await prepareCoreDshLaunch({
      runtimeRoot: runtime.root,
      dataDirectory,
      environment: {
        WEWORK_CORE_PLUGIN_ROOT: runtime.pluginsRoot,
        WEWORK_NODE_PATH: '/managed/node',
      },
      port: 3080,
    })
    const helperPath = join(
      launch.dshHome,
      'profiles',
      'wework-core',
      'node_modules',
      'node-pty',
      'prebuilds',
      'darwin-arm64',
      'spawn-helper'
    )
    await mkdir(join(helperPath, '..'), { recursive: true })
    await writeFile(helperPath, 'helper')
    await chmod(helperPath, 0o644)

    await prepareCoreDshLaunch({
      runtimeRoot: runtime.root,
      dataDirectory,
      environment: {
        WEWORK_CORE_PLUGIN_ROOT: runtime.pluginsRoot,
        WEWORK_NODE_PATH: '/managed/node',
      },
      port: 3081,
    })

    expect((await stat(helperPath)).mode & 0o777).toBe(0o755)
    await root.remove()
  })

  test('repairs stale managed paths without removing native DSH plugins', async () => {
    const root = await temporaryDirectory('core-dsh-stale-dependency-')
    const runtime = await writeRuntime(root.path, CORE_DSH_VERSION, 'a')
    const dataDirectory = join(root.path, 'data')
    const launch = await prepareCoreDshLaunch({
      runtimeRoot: runtime.root,
      dataDirectory,
      environment: {
        WEWORK_CORE_PLUGIN_ROOT: runtime.pluginsRoot,
        WEWORK_NODE_PATH: '/managed/node',
      },
      port: 3080,
    })
    const profileRoot = join(launch.dshHome, 'profiles', 'wework-core')
    const manifestPath = join(profileRoot, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.dependencies['@wegent/dsh-app-wework'] = 'file:/deleted/runtime/wework-app'
    manifest.dependencies['@wegent/dsh-sidebar-example'] = 'file:/obsolete'
    manifest.dependencies['@wework-e2e/native-dsh-consumer'] = 'file:./fixtures/consumer'
    manifest.dependencies['@wework-e2e/independent-dsh-plugin'] = '1.2.3'
    manifest.dsh.profile.bundles.push(
      '@wegent/dsh-sidebar-example',
      '@wework-e2e/native-dsh-provider',
      '@wework-e2e/native-dsh-consumer',
      '@wework-e2e/independent-dsh-plugin'
    )
    await writeFile(manifestPath, JSON.stringify(manifest))
    const consumerRoot = join(profileRoot, 'node_modules', '@wework-e2e', 'native-dsh-consumer')
    await mkdir(consumerRoot, { recursive: true })
    await writeFile(
      join(consumerRoot, 'package.json'),
      JSON.stringify({
        name: '@wework-e2e/native-dsh-consumer',
        peerDependencies: { '@wework-e2e/native-dsh-provider': '*' },
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      })
    )
    const providerRoot = join(profileRoot, 'node_modules', '@wework-e2e', 'native-dsh-provider')
    await mkdir(providerRoot, { recursive: true })
    await writeFile(
      join(providerRoot, 'package.json'),
      JSON.stringify({
        name: '@wework-e2e/native-dsh-provider',
        version: '2.1.0',
        dsh: { bundle: { patch: './cordis.patch.yml' } },
      })
    )
    const lockfilePaths = [
      join(profileRoot, 'pnpm-lock.yaml'),
      join(profileRoot, 'node_modules', '.pnpm', 'lock.yaml'),
      join(profileRoot, 'node_modules', '.modules.yaml'),
    ]
    await mkdir(join(profileRoot, 'node_modules', '.pnpm'), { recursive: true })
    await Promise.all(lockfilePaths.map(path => writeFile(path, 'stale install state')))

    await prepareCoreDshLaunch({
      runtimeRoot: runtime.root,
      dataDirectory,
      environment: {
        WEWORK_CORE_PLUGIN_ROOT: runtime.pluginsRoot,
        WEWORK_NODE_PATH: '/managed/node',
      },
      port: 3081,
    })

    const repaired = JSON.parse(await readFile(manifestPath, 'utf8'))
    expect(repaired.dependencies['@wegent/dsh-app-wework']).toBe(
      `file:${runtime.pluginRoots['@wegent/dsh-app-wework']}`
    )
    expect(repaired.dependencies).not.toHaveProperty('@wegent/dsh-sidebar-example')
    expect(repaired.dsh.profile.bundles).not.toContain('@wegent/dsh-sidebar-example')
    expect(repaired.dependencies['@wework-e2e/native-dsh-provider']).toBe('2.1.0')
    expect(repaired.dependencies['@wework-e2e/native-dsh-consumer']).toBe(
      'file:./fixtures/consumer'
    )
    expect(repaired.dsh.profile.bundles).toContain('@wework-e2e/native-dsh-provider')
    expect(repaired.dsh.profile.bundles).toContain('@wework-e2e/native-dsh-consumer')
    expect(repaired.dsh.profile.bundles.indexOf('@wework-e2e/native-dsh-provider')).toBeLessThan(
      repaired.dsh.profile.bundles.indexOf('@wework-e2e/native-dsh-consumer')
    )
    expect(repaired.dependencies['@wework-e2e/independent-dsh-plugin']).toBe('1.2.3')
    await Promise.all(
      lockfilePaths.map(path =>
        expect(readFile(path, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      )
    )
    await root.remove()
  })
})

async function writeRuntime(
  root: string,
  version: string,
  fingerprintCharacter: string
): Promise<{
  root: string
  fingerprint: string
  pluginsRoot: string
  pluginRoots: Record<string, string>
}> {
  const fingerprint = fingerprintCharacter.repeat(64)
  const runtime = join(root, fingerprint)
  const packageRoot = join(runtime, 'node_modules', '@deepseek-ai', 'dsh')
  const pluginsRoot = join(root, 'core-plugins', fingerprint)
  const pluginRoots = Object.fromEntries(
    [
      ['@wegent/dsh-app-wework', 'wework-app'],
      ['@wegent/dsh-electron-host', 'wework-electron-host'],
      ['@wegent/dsh-browser-runtime', 'wework-browser-runtime'],
      ['@wegent/dsh-secure-storage', 'wework-secure-storage'],
      ['@wegent/dsh-executor-runtime', 'wework-executor-runtime'],
      ['@wegent/dsh-terminal-runtime', 'wework-terminal-runtime'],
      ['@wegent/dsh-ui-core-apps', 'wework-ui-core-apps'],
      ['@wegent/dsh-ui-core-settings', 'wework-ui-core-settings'],
      ['@wegent/dsh-ui-plugin-center', 'wework-ui-plugin-center'],
      ['@wegent/dsh-ui-applications', 'wework-ui-applications'],
      ['@wegent/dsh-ui-automations', 'wework-ui-automations'],
      ['@wegent/dsh-ui-cloud-work', 'wework-ui-cloud-work'],
      ['@wegent/dsh-ui-git', 'wework-ui-git'],
    ].map(([packageName, directory]) => [packageName, join(pluginsRoot, directory)])
  )
  await mkdir(join(packageRoot, 'lib'), { recursive: true })
  await Promise.all(Object.values(pluginRoots).map(root => mkdir(root, { recursive: true })))
  await writeFile(
    join(runtime, 'runtime.json'),
    JSON.stringify({
      dshVersion: version,
      role: version === CORE_DSH_VERSION ? 'core' : 'workbench',
      sourceFingerprint: fingerprint,
    })
  )
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ version }))
  await writeFile(join(packageRoot, 'lib', 'bin.js'), '')
  await Promise.all(
    Object.values(pluginRoots).map(root => writeFile(join(root, 'package.json'), '{}'))
  )
  return {
    root: runtime,
    fingerprint,
    pluginsRoot,
    pluginRoots,
  }
}
