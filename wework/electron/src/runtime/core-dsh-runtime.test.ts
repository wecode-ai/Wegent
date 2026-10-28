import { chmod, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'
import {
  CORE_DSH_VERSION,
  createCoreDshLaunch,
  prepareCoreDshRuntime,
  resetCoreDshRuntime,
  selectBundledDshRuntimeMatching,
  selectCoreDshRuntime,
} from './core-dsh-runtime.js'
import { temporaryDirectory } from './test-helpers.js'
import { writeRuntime } from './core-dsh-runtime-fixture.js'

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, chmod: vi.fn(actual.chmod) }
})

async function prepareCoreDshLaunch(
  options: Parameters<typeof prepareCoreDshRuntime>[0] & { port: number }
) {
  const { port, ...runtimeOptions } = options
  return createCoreDshLaunch(await prepareCoreDshRuntime(runtimeOptions), port)
}

describe('core DSH runtime', () => {
  test('selects the same materialized runtime for both declared roles', async () => {
    const root = await temporaryDirectory('shared-dsh-selection-')
    try {
      const runtime = await writeRuntime(root.path, CORE_DSH_VERSION, 'a')
      await writeFile(
        join(runtime.root, 'runtime.json'),
        JSON.stringify({
          dshVersion: CORE_DSH_VERSION,
          roles: ['core', 'workbench'],
          sourceFingerprint: runtime.fingerprint,
        })
      )
      await writeFile(
        join(root.path, 'runtimes.json'),
        JSON.stringify({
          runtimes: ['core', 'workbench'].map(role => ({
            role,
            sourceFingerprint: runtime.fingerprint,
          })),
        })
      )

      for (const role of ['core', 'workbench']) {
        await expect(
          selectBundledDshRuntimeMatching(root.path, role, CORE_DSH_VERSION)
        ).resolves.toMatchObject({ root: runtime.root, role, version: CORE_DSH_VERSION })
      }
      await expect(
        selectBundledDshRuntimeMatching(root.path, 'other', CORE_DSH_VERSION)
      ).rejects.toThrow('Bundled other DSH runtime')
    } finally {
      await root.remove()
    }
  })

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
        WEWORK_APP_WEB_ROOT: join(root.path, 'source-app-web'),
        WEWORK_NODE_PATH: '/managed/node',
      },
      port: 3080,
    })
    const workspacePath = join(
      dataDirectory,
      'dsh-core',
      'profiles',
      'wework-core',
      'pnpm-workspace.yaml'
    )
    const unchangedWorkspace = `${await readFile(workspacePath, 'utf8')}# keep-existing-workspace\n`
    await writeFile(workspacePath, unchangedWorkspace)
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
      WEWORK_APP_WEB_ROOT: join(root.path, 'source-app-web'),
      WEWORK_HARNESS_API_KEY: 'wework-local-router',
    })
    expect(second.args).toContain('3081')
    expect(second.environment.WEWORK_APP_WEB_ROOT).toBe(
      join(runtime.pluginRoots['@wegent/dsh-app-wework'], 'web')
    )
    await expect(readFile(workspacePath, 'utf8')).resolves.toBe(unchangedWorkspace)
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
        '@wegent/dsh-conversation-export': expect.stringContaining('wework-conversation-export'),
        '@wegent/dsh-browser-runtime': expect.stringContaining('wework-browser-runtime'),
        '@wegent/dsh-electron-host': expect.stringContaining('wework-electron-host'),
        '@wegent/dsh-executor-runtime': expect.stringContaining('wework-executor-runtime'),
        '@wegent/dsh-secure-storage': expect.stringContaining('wework-secure-storage'),
        '@wegent/dsh-terminal-runtime': expect.stringContaining('wework-terminal-runtime'),
        '@wegent/dsh-transcript-sync': expect.stringContaining('wework-transcript-sync'),
        '@wegent/dsh-plugin-runtime': expect.stringContaining('wework-plugin-runtime'),
        '@wegent/dsh-ui-core-apps': expect.stringContaining('wework-ui-core-apps'),
        '@wegent/dsh-ui-core-settings': expect.stringContaining('wework-ui-core-settings'),
        '@wegent/dsh-ui-plugin-center': expect.stringContaining('wework-ui-plugin-center'),
        '@wegent/dsh-ui-applications': expect.stringContaining('wework-ui-applications'),
        '@wegent/dsh-ui-automations': expect.stringContaining('wework-ui-automations'),
        '@wegent/dsh-ui-cloud-work': expect.stringContaining('wework-ui-cloud-work'),
        '@wegent/dsh-wework-plugin-developer': expect.stringContaining('wework-plugin-developer'),
        '@wegent/dsh-ui-home-focus': expect.stringContaining('wework-ui-home-focus'),
        '@wegent/dsh-ui-home-developer': expect.stringContaining('wework-ui-home-developer'),
        '@wegent/dsh-ui-git': expect.stringContaining('wework-ui-git'),
        '@wegent/dsh-ui-outputs': expect.stringContaining('wework-ui-outputs'),
      },
      dsh: {
        profile: {
          bundles: [
            '@wework/dsh-browser-auth',
            '@deepseek-ai/dsh-base',
            '@wegent/dsh-electron-host',
            '@wegent/dsh-browser-runtime',
            '@wegent/dsh-secure-storage',
            '@wegent/dsh-terminal-runtime',
            '@wegent/dsh-plugin-runtime',
            '@wegent/dsh-connection-runtime',
            '@wegent/dsh-connection-dingtalk',
            '@wegent/dsh-app-wework',
            '@deepseek-ai/dsh-web-app',
            '@wegent/dsh-executor-runtime',
            '@wegent/dsh-transcript-sync',
            '@deepseek-ai/dsh-experimental-voice-input-bundle',
            '@wegent/dsh-conversation-export',
            '@wegent/dsh-ui-core-apps',
            '@wegent/dsh-ui-core-settings',
            '@wegent/dsh-ui-plugin-center',
            '@wegent/dsh-ui-applications',
            '@wegent/dsh-ui-automations',
            '@wegent/dsh-ui-cloud-work',
            '@wegent/dsh-wework-plugin-developer',
            '@wegent/dsh-ui-home-focus',
            '@wegent/dsh-ui-home-developer',
            '@wegent/dsh-ui-git',
            '@wegent/dsh-ui-outputs',
            '@wegent/dsh-voice-input',
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
      managedPluginCopyVersion: 1,
      dshVersion: CORE_DSH_VERSION,
      managedUiPlugins: true,
      role: 'core',
      sourceFingerprint: 'a'.repeat(64),
      corePluginsFingerprint: 'f'.repeat(64),
      managedDependencyNames: expect.arrayContaining(['@wegent/dsh-app-wework']),
      managedBundles: expect.arrayContaining(['@deepseek-ai/dsh-experimental-voice-input-bundle']),
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
      readFile(join(profileModules, 'dsh-plugin-runtime', 'package.json'), 'utf8')
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
      readFile(join(profileModules, 'dsh-ui-home-focus', 'package.json'), 'utf8')
    ).resolves.toBe('{}')
    await expect(
      readFile(join(profileModules, 'dsh-ui-home-developer', 'package.json'), 'utf8')
    ).resolves.toBe('{}')
    await expect(
      readFile(join(profileModules, 'dsh-ui-git', 'package.json'), 'utf8')
    ).resolves.toBe('{}')
    await expect(
      readFile(join(profileModules, 'dsh-ui-outputs', 'package.json'), 'utf8')
    ).resolves.toBe('{}')
    await root.remove()
  })

  test('resolves configured and bundled Wework application web roots', async () => {
    const root = await temporaryDirectory('core-dsh-web-root-')
    try {
      const runtime = await writeRuntime(root.path, CORE_DSH_VERSION, 'a')
      const configuredWebRoot = join(root.path, 'development-web')
      const bundledWebRoot = join(runtime.pluginRoots['@wegent/dsh-app-wework'], 'web')
      const cases = [
        { value: `  ${configuredWebRoot}  `, expected: configuredWebRoot },
        { value: '', expected: bundledWebRoot },
        { value: '   ', expected: bundledWebRoot },
      ]

      for (const [index, testCase] of cases.entries()) {
        const launch = await prepareCoreDshLaunch({
          runtimeRoot: runtime.root,
          dataDirectory: join(root.path, `data-${index}`),
          environment: {
            PATH: '/usr/bin',
            WEWORK_APP_WEB_ROOT: testCase.value,
            WEWORK_CORE_PLUGIN_ROOT: runtime.pluginsRoot,
            WEWORK_CORE_PLUGINS_SHA256: 'f'.repeat(64),
            WEWORK_NODE_PATH: '/managed/node',
          },
          port: 3080 + index,
        })

        expect(launch.environment.WEWORK_APP_WEB_ROOT).toBe(testCase.expected)
      }
    } finally {
      await root.remove()
    }
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
    expect(await readFile(join(profileRoot, 'cordis.patch.yml'), 'utf8')).toBe(
      '- id: client-hmr\n  disabled: true\n'
    )
    const manifest = JSON.parse(await readFile(join(profileRoot, 'package.json'), 'utf8'))
    expect(manifest.dependencies['@wegent/dsh-app-wework']).toBe(
      `file:${secondRuntime.pluginRoots['@wegent/dsh-app-wework']}`
    )
    expect(
      JSON.parse(await readFile(join(profileRoot, '.wework-runtime.json'), 'utf8'))
    ).toMatchObject({
      sourceFingerprint: 'b'.repeat(64),
      corePluginsFingerprint: 'f'.repeat(64),
      managedBundles: expect.arrayContaining(['@deepseek-ai/dsh-experimental-voice-input-bundle']),
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
    const patchPath = join(launch.dshHome, 'profiles', 'wework-core', 'cordis.patch.yml')
    await writeFile(
      patchPath,
      '- id: client-hmr\n  disabled: false\n- id: hmr\n  disabled: false\n'
    )

    await prepareCoreDshLaunch({
      runtimeRoot: runtime.root,
      dataDirectory,
      environment,
      port: 3081,
    })

    await expect(readFile(join(pluginCopyRoot, 'local-helper.js'), 'utf8')).resolves.toBe('local')
    await expect(readFile(patchPath, 'utf8')).resolves.toBe('- id: client-hmr\n  disabled: true\n')
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

  test.each([
    'corePluginsFingerprint',
    'managedPluginCopyVersion',
    'managedBundles',
    'managedDependencyNames',
  ])('upgrades a legacy stamp without %s', async field => {
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
    delete legacy[field]
    await writeFile(stampPath, JSON.stringify(legacy))

    await prepareCoreDshLaunch({
      runtimeRoot: runtime.root,
      dataDirectory,
      environment,
      port: 3081,
    })

    expect(JSON.parse(await readFile(stampPath, 'utf8'))).toEqual({
      managedPluginCopyVersion: 1,
      dshVersion: CORE_DSH_VERSION,
      managedUiPlugins: true,
      role: 'core',
      sourceFingerprint: 'a'.repeat(64),
      corePluginsFingerprint: 'f'.repeat(64),
      managedDependencyNames: expect.arrayContaining(['@wegent/dsh-app-wework']),
      managedBundles: expect.arrayContaining(['@deepseek-ai/dsh-experimental-voice-input-bundle']),
    })
    await root.remove()
  })

  test.each([false, true])(
    'restores an official bundle with current stamp: %s',
    async currentStamp => {
      const root = await temporaryDirectory('core-dsh-bundle-upgrade-')
      const runtime = await writeRuntime(root.path, CORE_DSH_VERSION, 'a')
      const options = {
        runtimeRoot: runtime.root,
        dataDirectory: join(root.path, 'data'),
        environment: {
          WEWORK_CORE_PLUGIN_ROOT: runtime.pluginsRoot,
          WEWORK_CORE_PLUGINS_SHA256: 'f'.repeat(64),
        },
      }
      const launch = await prepareCoreDshRuntime(options)
      const profileRoot = join(launch.dshHome, 'profiles', 'wework-core')
      const manifestPath = join(profileRoot, 'package.json')
      const stampPath = join(profileRoot, '.wework-runtime.json')
      const bundle = '@deepseek-ai/dsh-experimental-voice-input-bundle'
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter(
        (name: string) => name !== bundle
      )
      const stamp = JSON.parse(await readFile(stampPath, 'utf8'))
      if (!currentStamp) stamp.managedBundles = manifest.dsh.profile.bundles
      await writeFile(manifestPath, JSON.stringify(manifest))
      await writeFile(stampPath, JSON.stringify(stamp))

      await prepareCoreDshRuntime(options)

      const updated = JSON.parse(await readFile(manifestPath, 'utf8'))
      expect(updated.dsh.profile.bundles).toContain(bundle)
      expect(JSON.parse(await readFile(stampPath, 'utf8')).managedBundles).toContain(bundle)
      await root.remove()
    }
  )

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
      '@wegent/dsh-transcript-sync',
      '@wegent/dsh-plugin-runtime',
      '@wegent/dsh-connection-runtime',
      '@wegent/dsh-connection-dingtalk',
      '@wework/dsh-browser-auth',
    ])
    expect(manifest.dsh.profile.bundles).toEqual([
      '@wework/dsh-browser-auth',
      '@deepseek-ai/dsh-base',
      '@wegent/dsh-electron-host',
      '@wegent/dsh-browser-runtime',
      '@wegent/dsh-secure-storage',
      '@wegent/dsh-terminal-runtime',
      '@wegent/dsh-plugin-runtime',
      '@wegent/dsh-connection-runtime',
      '@wegent/dsh-connection-dingtalk',
      '@wegent/dsh-app-wework',
      '@deepseek-ai/dsh-web-app',
      '@wegent/dsh-executor-runtime',
      '@wegent/dsh-transcript-sync',
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

  test('removes newer managed plugins on rollback while retaining user plugins', async () => {
    const root = await temporaryDirectory('core-dsh-rollback-profile-')
    try {
      const runtime = await writeRuntime(root.path, CORE_DSH_VERSION, 'a')
      const options = {
        runtimeRoot: runtime.root,
        dataDirectory: join(root.path, 'data'),
        environment: { WEWORK_CORE_PLUGIN_ROOT: runtime.pluginsRoot },
      }
      const launch = await prepareCoreDshRuntime(options)
      const profile = join(launch.dshHome, 'profiles', 'wework-core')
      const manifestPath = join(profile, 'package.json')
      const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
      for (const name of ['future-managed-plugin', 'user-plugin']) {
        manifest.dependencies[name] = '1.0.0'
        manifest.dsh.profile.bundles.push(name)
        await mkdir(join(profile, 'node_modules', name), { recursive: true })
        await writeFile(
          join(profile, 'node_modules', name, 'package.json'),
          JSON.stringify({ name, version: '1.0.0' })
        )
      }
      await writeFile(manifestPath, JSON.stringify(manifest))
      const stampPath = join(profile, '.wework-runtime.json')
      const stamp = JSON.parse(await readFile(stampPath, 'utf8'))
      stamp.managedDependencyNames.push('future-managed-plugin')
      stamp.managedBundles.push('future-managed-plugin')
      await writeFile(stampPath, JSON.stringify(stamp))
      await prepareCoreDshRuntime(options)
      const restored = JSON.parse(await readFile(manifestPath, 'utf8'))
      expect(restored.dependencies['future-managed-plugin']).toBeUndefined()
      expect(restored.dsh.profile.bundles).not.toContain('future-managed-plugin')
      expect(restored.dependencies['user-plugin']).toBe('1.0.0')
      expect(restored.dsh.profile.bundles).toContain('user-plugin')
    } finally {
      await root.remove()
    }
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
    await resetCoreDshRuntime(dataDirectory)

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

    expect(chmod).toHaveBeenCalledWith(helperPath, 0o755)
    if (process.platform !== 'win32') expect((await stat(helperPath)).mode & 0o777).toBe(0o755)
    expect(await readFile(helperPath, 'utf8')).toBe('helper')
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
