import {
  chmod,
  cp,
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join } from 'node:path'
import { rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describe, expect, test, vi } from 'vitest'
import { parse } from 'yaml'
import {
  CORE_DSH_VERSION,
  copyManagedPlugin,
  createCoreDshLaunch,
  prepareCoreDshRuntime,
  resetCoreDshRuntime,
  selectBundledDshRuntimeMatching,
  selectCoreDshRuntime,
} from './core-dsh-runtime.js'
import { temporaryDirectory } from './test-helpers.js'
import { hashComponentPath } from './component-content-hash.js'

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
  test.each(['focus', 'developer'] as const)(
    'writes the selected %s mode during profile creation and upgrade',
    async workbenchMode => {
      const root = await temporaryDirectory('core-dsh-mode-profile-')
      try {
        const runtime = await writeRuntime(root.path, CORE_DSH_VERSION, 'a')
        const options = {
          runtimeRoot: runtime.root,
          dataDirectory: join(root.path, 'data'),
          environment: {
            WEWORK_CORE_PLUGIN_ROOT: runtime.pluginsRoot,
            WEWORK_CORE_PLUGINS_SHA256: 'f'.repeat(64),
          },
          workbenchMode,
        }
        const launch = await prepareCoreDshRuntime(options)
        const profileRoot = join(launch.dshHome, 'profiles', 'wework-core')
        const manifestPath = join(profileRoot, 'package.json')
        const expected = {
          '@wegent/dsh-ui-git': workbenchMode === 'developer',
          '@wegent/dsh-ui-home-focus': workbenchMode === 'focus',
          '@wegent/dsh-ui-home-developer': workbenchMode === 'developer',
        }
        const assertMode = async () => {
          const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
          const patch = parse(await readFile(join(profileRoot, 'cordis.patch.yml'), 'utf8'))
          expect(
            patch
              .filter((entry: { disabled: boolean }) => entry.disabled)
              .map((entry: { id: string }) => entry.id)
          ).toEqual(['hmr', 'client-hmr'])
          for (const [name, enabled] of Object.entries(expected)) {
            expect(manifest.dsh.profile.bundles.includes(name)).toBe(enabled)
          }
        }
        await assertMode()

        const statePath = join(profileRoot, '.wework-core-plugins.json')
        await writeFile(
          statePath,
          JSON.stringify({
            version: 1,
            order: ['user-plugin'],
            disabled: ['user-plugin', ...Object.keys(expected)],
          })
        )
        await rm(join(profileRoot, '.wework-runtime.json'))
        await prepareCoreDshRuntime(options)
        await assertMode()
        const state = JSON.parse(await readFile(statePath, 'utf8'))
        expect(state.order[0]).toBe('user-plugin')
        expect(state.disabled).toContain('user-plugin')
        for (const [name, enabled] of Object.entries(expected)) {
          expect(state.order).toContain(name)
          expect(state.disabled.includes(name)).toBe(!enabled)
        }
      } finally {
        await root.remove()
      }
    }
  )

  test.each([false, true])(
    'resolves profile dependencies from a composed source (linked=%s)',
    async linked => {
      const root = await temporaryDirectory('core-dsh-module-resolution-')
      try {
        const source = join(root.path, 'component', 'terminal-runtime')
        const modules = join(root.path, 'profile', 'node_modules')
        const destination = join(modules, '@wegent', 'dsh-terminal-runtime')
        await mkdir(join(source, 'web'), { recursive: true })
        await mkdir(join(modules, 'node-pty'), { recursive: true })
        await writeFile(join(source, 'index.cjs'), 'module.exports = require("node-pty")\n')
        await writeFile(join(source, 'web', 'index.html'), '<html></html>\n')
        await writeFile(join(modules, 'node-pty', 'index.js'), 'module.exports = "profile PTY"\n')

        const composedSource = join(root.path, 'composed-source')
        if (linked) {
          await symlink(source, composedSource, process.platform === 'win32' ? 'junction' : 'dir')
        }
        await copyManagedPlugin(linked ? composedSource : source, destination)

        const requirePlugin = createRequire(join(destination, 'package.json'))
        expect(requirePlugin('./index.cjs')).toBe('profile PTY')
        expect(await realpath(join(destination, 'web'))).toBe(await realpath(join(source, 'web')))
        expect((await lstat(join(destination, 'index.cjs'))).isFile()).toBe(true)
      } finally {
        await root.remove()
      }
    }
  )
  test('copies code independently while preserving linked static web resources', async () => {
    const root = await temporaryDirectory('core-dsh-linked-web-')
    try {
      const source = join(root.path, 'source')
      const web = join(root.path, 'web')
      const destination = join(root.path, 'profile', 'node_modules', 'plugin')
      await mkdir(source)
      await mkdir(web)
      await writeFile(join(source, 'index.js'), 'export const version = 1\n')
      await writeFile(join(web, 'index.html'), '<html>linked web</html>\n')
      await symlink(web, join(source, 'web'), process.platform === 'win32' ? 'junction' : 'dir')

      await copyManagedPlugin(source, destination)
      await writeFile(join(source, 'index.js'), 'export const version = 2\n')

      expect(await readFile(join(destination, 'index.js'), 'utf8')).toBe(
        'export const version = 1\n'
      )
      expect(await realpath(join(destination, 'web'))).toBe(await realpath(web))
      expect(await readFile(join(destination, 'web', 'index.html'), 'utf8')).toContain('linked web')
    } finally {
      await root.remove()
    }
  })

  test('links static web assets as Windows junctions while copying plugin modules', async () => {
    const root = await temporaryDirectory('core-dsh-windows-links-')
    try {
      const source = join(root.path, 'source')
      const assets = join(root.path, 'assets')
      const destination = join(root.path, 'destination')
      await mkdir(join(source, 'web'), { recursive: true })
      await mkdir(assets)
      await writeFile(join(assets, 'index.js'), 'window.wework = true\n')
      await symlink(
        assets,
        join(source, 'web', 'assets'),
        process.platform === 'win32' ? 'junction' : 'dir'
      )
      const directoryLinkTypes: Array<string | null | undefined> = []

      await copyManagedPlugin(source, destination, {
        platform: 'win32',
        linkDirectory: async (target, path, type) => {
          directoryLinkTypes.push(type)
          await symlink(target, path, type)
        },
      })

      const copiedAssets = join(destination, 'web', 'assets')
      expect(directoryLinkTypes).toEqual(['junction'])
      expect((await lstat(destination)).isDirectory()).toBe(true)
      expect((await lstat(join(destination, 'web'))).isSymbolicLink()).toBe(true)
      expect(await realpath(join(destination, 'web'))).toBe(await realpath(join(source, 'web')))
      expect((await lstat(copiedAssets)).isSymbolicLink()).toBe(true)
      expect(await realpath(copiedAssets)).toBe(await realpath(assets))
      await expect(readFile(join(copiedAssets, 'index.js'), 'utf8')).resolves.toBe(
        'window.wework = true\n'
      )
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
    const startupSteps: Array<[string, string]> = []

    const first = await prepareCoreDshLaunch({
      onStartupStep: (step, status) => startupSteps.push([step, status]),
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
    expect(startupSteps.filter(([step]) => step === 'core-dsh-user-plugin-recovery')).toEqual([
      ['core-dsh-user-plugin-recovery', 'started'],
      ['core-dsh-user-plugin-recovery', 'completed'],
    ])
    startupSteps.length = 0
    const second = await prepareCoreDshLaunch({
      onStartupStep: (step, status) => startupSteps.push([step, status]),
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
    expect(startupSteps.filter(([step]) => step === 'core-dsh-profile-metadata-read')).toEqual([
      ['core-dsh-profile-metadata-read', 'started'],
      ['core-dsh-profile-metadata-read', 'completed'],
    ])
    expect(startupSteps.some(([step]) => step === 'core-dsh-user-plugin-recovery')).toBe(false)
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
            '@deepseek-ai/dsh-base',
            '@wegent/dsh-electron-host',
            '@wegent/dsh-browser-runtime',
            '@wegent/dsh-secure-storage',
            '@wegent/dsh-terminal-runtime',
            '@wegent/dsh-plugin-runtime',
            '@wegent/dsh-app-wework',
            '@deepseek-ai/dsh-web-app',
            '@wegent/dsh-executor-runtime',
            '@wegent/dsh-transcript-sync',
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
      managedPluginLayout: 1,
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

  test('profiles only an explicitly enabled isolated Core process before its entry executes', async () => {
    const root = await temporaryDirectory('core-dsh-cpu-profile-')
    const runtime = await writeRuntime(root.path, CORE_DSH_VERSION, 'a')
    const options = {
      runtimeRoot: runtime.root,
      dataDirectory: join(root.path, 'data'),
      environment: { WEWORK_CORE_PLUGIN_ROOT: runtime.pluginsRoot },
    }
    const prepared = await prepareCoreDshRuntime(options)
    const privateDirectory = join(prepared.dshHome, '.cpu-profile')
    await expect(lstat(privateDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    const defaultLaunch = createCoreDshLaunch(prepared, 3080)
    for (const enabled of [undefined, '', '0', 'true']) {
      expect(
        createCoreDshLaunch(
          {
            ...prepared,
            environment: { ...prepared.environment, WEWORK_E2E_CORE_CPU_PROFILE: enabled },
          },
          3080
        ).args
      ).toEqual(defaultLaunch.args)
    }
    const profiled = await prepareCoreDshRuntime({
      ...options,
      environment: { ...options.environment, WEWORK_E2E_CORE_CPU_PROFILE: '1' },
    })
    const entry = join(root.path, 'profile-fixture.mjs')
    await cp(
      new URL('../../../dsh/electron-host', import.meta.url),
      runtime.pluginRoots['@wegent/dsh-electron-host'],
      { recursive: true }
    )
    await writeFile(
      entry,
      `let total = 0
       for (let i = 0; i < 10000000; i++) total += Math.sqrt(i)
       await globalThis[Symbol.for('wework.core.startupCpuProfiler')].complete()\n`
    )
    const launch = createCoreDshLaunch({ ...profiled, entry }, 3080)
    expect(launch.args[0]).toBe('--import')
    expect(launch.args[1]).toContain('cpu-profile-bootstrap.js')
    await promisify(execFile)(process.execPath, launch.args, {
      env: { ...process.env, ...launch.environment },
    })
    await expect(lstat(privateDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
    const logsRoot = join(profiled.dshHome, '../logs')
    const files = await readdir(logsRoot)
    expect(files).toHaveLength(1)
    const summary = JSON.parse(await readFile(join(logsRoot, files[0]), 'utf8'))
    expect(summary.scope).toBe('startup-to-endpoint')
    expect(summary.samples).toBeGreaterThan(0)
    expect(JSON.stringify(summary)).not.toContain(root.path)
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
      managedPluginLayout: 1,
    })
    await root.remove()
  })

  test.each(['refresh', 'reset'] as const)(
    'migrates legacy App web aliases safely during %s and preserves the current layout',
    async action => {
      const root = await temporaryDirectory('core-dsh-app-web-layout-')
      try {
        const runtime = await writeRuntime(root.path, CORE_DSH_VERSION, 'a')
        const immutableAssets = join(root.path, 'immutable-assets')
        const appWeb = join(runtime.pluginRoots['@wegent/dsh-app-wework'], 'web')
        await mkdir(immutableAssets)
        await mkdir(appWeb)
        await writeFile(join(immutableAssets, 'renderer.js'), 'window.wework = true\n')
        await symlink(
          immutableAssets,
          join(appWeb, 'assets'),
          process.platform === 'win32' ? 'junction' : 'dir'
        )
        const immutableHash = await hashComponentPath(immutableAssets)
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
        const appRoot = join(profileRoot, 'node_modules', '@wegent', 'dsh-app-wework')
        const stampPath = join(profileRoot, '.wework-runtime.json')
        const manifestPath = join(profileRoot, 'package.json')
        const stamp = JSON.parse(await readFile(stampPath, 'utf8'))
        delete stamp.managedPluginLayout
        await writeFile(stampPath, JSON.stringify(stamp))
        await symlink(
          appWeb,
          join(appRoot, 'web'),
          process.platform === 'win32' ? 'junction' : 'dir'
        )
        const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
        manifest.dependencies['user-plugin'] = '1.2.3'
        await writeFile(manifestPath, JSON.stringify(manifest))
        const userRoot = join(profileRoot, 'node_modules', 'user-plugin')
        await mkdir(userRoot)
        await writeFile(join(userRoot, 'package.json'), '{"name":"user-plugin","version":"1.2.3"}')
        const settingsPath = join(profileRoot, '.wework-core-plugins.json')
        await writeFile(
          settingsPath,
          '{"version":1,"order":["user-plugin"],"disabled":["user-plugin"]}'
        )

        if (action === 'reset') await resetCoreDshRuntime(options.dataDirectory)
        const migrated = await prepareCoreDshRuntime(options)

        expect(migrated.environment.WEWORK_APP_WEB_ROOT).toBe(appWeb)
        await expect(lstat(join(appRoot, 'web'))).rejects.toMatchObject({ code: 'ENOENT' })
        expect(await hashComponentPath(immutableAssets)).toBe(immutableHash)
        expect(JSON.parse(await readFile(manifestPath, 'utf8')).dependencies['user-plugin']).toBe(
          '1.2.3'
        )
        expect(await readFile(join(userRoot, 'package.json'), 'utf8')).toContain('1.2.3')
        expect(JSON.parse(await readFile(settingsPath, 'utf8')).disabled).toEqual(['user-plugin'])
        expect(JSON.parse(await readFile(stampPath, 'utf8')).managedPluginLayout).toBe(1)

        const marker = join(appRoot, 'current-layout-marker')
        await writeFile(marker, 'retained without copying')
        await prepareCoreDshRuntime(options)
        expect(await readFile(marker, 'utf8')).toBe('retained without copying')
        rmSync(appRoot, { recursive: true, force: true })
        expect(await hashComponentPath(immutableAssets)).toBe(immutableHash)
        expect(await readFile(join(appWeb, 'assets', 'renderer.js'), 'utf8')).toBe(
          'window.wework = true\n'
        )
      } finally {
        await root.remove()
      }
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
    ])
    expect(manifest.dsh.profile.bundles).toEqual([
      '@deepseek-ai/dsh-base',
      '@wegent/dsh-electron-host',
      '@wegent/dsh-browser-runtime',
      '@wegent/dsh-secure-storage',
      '@wegent/dsh-terminal-runtime',
      '@wegent/dsh-plugin-runtime',
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
      ['@wegent/dsh-conversation-export', 'wework-conversation-export'],
      ['@wegent/dsh-electron-host', 'wework-electron-host'],
      ['@wegent/dsh-browser-runtime', 'wework-browser-runtime'],
      ['@wegent/dsh-secure-storage', 'wework-secure-storage'],
      ['@wegent/dsh-executor-runtime', 'wework-executor-runtime'],
      ['@wegent/dsh-terminal-runtime', 'wework-terminal-runtime'],
      ['@wegent/dsh-transcript-sync', 'wework-transcript-sync'],
      ['@wegent/dsh-plugin-runtime', 'wework-plugin-runtime'],
      ['@wegent/dsh-ui-core-apps', 'wework-ui-core-apps'],
      ['@wegent/dsh-ui-core-settings', 'wework-ui-core-settings'],
      ['@wegent/dsh-ui-plugin-center', 'wework-ui-plugin-center'],
      ['@wegent/dsh-ui-applications', 'wework-ui-applications'],
      ['@wegent/dsh-ui-automations', 'wework-ui-automations'],
      ['@wegent/dsh-ui-cloud-work', 'wework-ui-cloud-work'],
      ['@wegent/dsh-wework-plugin-developer', 'wework-plugin-developer'],
      ['@wegent/dsh-ui-home-focus', 'wework-ui-home-focus'],
      ['@wegent/dsh-ui-home-developer', 'wework-ui-home-developer'],
      ['@wegent/dsh-ui-git', 'wework-ui-git'],
      ['@wegent/dsh-ui-outputs', 'wework-ui-outputs'],
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
