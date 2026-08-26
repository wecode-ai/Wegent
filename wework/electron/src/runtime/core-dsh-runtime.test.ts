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
    const rc7 = await writeRuntime(root.path, '0.1.0-rc.7', '7')
    const rc8 = await writeRuntime(root.path, '0.1.0-rc.8', '8')
    const core = await writeRuntime(root.path, CORE_DSH_VERSION, '2')
    await writeRuntime(root.path, '0.1.2-rc.1', 'f')
    await writeFile(
      join(root.path, 'runtimes.json'),
      JSON.stringify({
        runtimes: [rc7, rc8, core].map(runtime => ({
          sourceFingerprint: runtime.fingerprint,
        })),
      })
    )

    await expect(selectCoreDshRuntime(root.path)).resolves.toMatchObject({
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

    await expect(selectCoreDshRuntime(root.path)).resolves.toMatchObject({
      version: CORE_DSH_VERSION,
    })
    await root.remove()
  })

  test('selects the highest bundled runtime satisfying a version requirement', async () => {
    const root = await temporaryDirectory('workbench-dsh-selection-')
    await writeRuntime(root.path, '0.1.0-rc.7', '7')
    await writeRuntime(root.path, '0.1.0-rc.8', '8')
    await writeRuntime(root.path, '0.1.1-rc.1', '9')

    await expect(
      selectBundledDshRuntimeMatching(root.path, 'workbench', '>=0.1.0-rc.7 <=0.1.0-rc.8')
    ).resolves.toMatchObject({
      version: '0.1.0-rc.8',
    })
    await expect(
      selectBundledDshRuntimeMatching(root.path, 'workbench', '0.1.0-rc.7')
    ).resolves.toMatchObject({
      version: '0.1.0-rc.7',
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
      environment: { PATH: '/usr/bin', WEWORK_NODE_PATH: '/managed/node' },
      port: 3080,
    })
    const second = await prepareCoreDshLaunch({
      runtimeRoot: runtime.root,
      dataDirectory,
      environment: { PATH: '/usr/bin', WEWORK_NODE_PATH: '/managed/node' },
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
        '@wegent/dsh-electron-host': expect.stringContaining('wework-electron-host'),
        '@wegent/dsh-executor-runtime': expect.stringContaining('wework-executor-runtime'),
        '@wegent/dsh-terminal-runtime': expect.stringContaining('wework-terminal-runtime'),
      },
      dsh: {
        profile: {
          bundles: [
            '@deepseek-ai/dsh-base',
            '@wegent/dsh-electron-host',
            '@wegent/dsh-terminal-runtime',
            '@wegent/dsh-app-wework',
            '@deepseek-ai/dsh-web-app',
            '@wegent/dsh-executor-runtime',
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
      role: 'core',
      sourceFingerprint: 'a'.repeat(64),
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
    await root.remove()
  })

  test('preserves manually installed plugins and their build permissions', async () => {
    const root = await temporaryDirectory('core-dsh-user-plugin-')
    const firstRuntime = await writeRuntime(root.path, CORE_DSH_VERSION, 'a')
    const dataDirectory = join(root.path, 'data')
    const launch = await prepareCoreDshLaunch({
      runtimeRoot: firstRuntime.root,
      dataDirectory,
      environment: { WEWORK_NODE_PATH: '/managed/node' },
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
      environment: { WEWORK_NODE_PATH: '/managed/node' },
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
      environment: { WEWORK_NODE_PATH: '/managed/node' },
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
      environment: { WEWORK_NODE_PATH: '/managed/node' },
      port: 3081,
    })

    expect((await stat(helperPath)).mode & 0o777).toBe(0o755)
    await root.remove()
  })

  test('repairs stale managed paths and removes obsolete managed sidebar plugins', async () => {
    const root = await temporaryDirectory('core-dsh-stale-dependency-')
    const runtime = await writeRuntime(root.path, CORE_DSH_VERSION, 'a')
    const dataDirectory = join(root.path, 'data')
    const launch = await prepareCoreDshLaunch({
      runtimeRoot: runtime.root,
      dataDirectory,
      environment: { WEWORK_NODE_PATH: '/managed/node' },
      port: 3080,
    })
    const profileRoot = join(launch.dshHome, 'profiles', 'wework-core')
    const manifestPath = join(profileRoot, 'package.json')
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    manifest.dependencies['@wegent/dsh-app-wework'] = 'file:/deleted/runtime/wework-app'
    manifest.dependencies['@wegent/dsh-sidebar-example'] = 'file:/obsolete'
    manifest.dependencies['dsh-turn-review'] = '1.2.3'
    manifest.dsh.profile.bundles.push('@wegent/dsh-sidebar-example', 'dsh-turn-review')
    await writeFile(manifestPath, JSON.stringify(manifest))
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
      environment: { WEWORK_NODE_PATH: '/managed/node' },
      port: 3081,
    })

    const repaired = JSON.parse(await readFile(manifestPath, 'utf8'))
    expect(repaired.dependencies['@wegent/dsh-app-wework']).toBe(`file:${runtime.appPluginRoot}`)
    expect(repaired.dependencies).not.toHaveProperty('@wegent/dsh-sidebar-example')
    expect(repaired.dsh.profile.bundles).not.toContain('@wegent/dsh-sidebar-example')
    expect(repaired.dependencies['dsh-turn-review']).toBe('1.2.3')
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
  appPluginRoot: string
  pluginRoot: string
  executorPluginRoot: string
  terminalPluginRoot: string
}> {
  const fingerprint = fingerprintCharacter.repeat(64)
  const runtime = join(root, fingerprint)
  const packageRoot = join(runtime, 'node_modules', '@deepseek-ai', 'dsh')
  const appPluginRoot = join(runtime, 'plugins', 'wework-app')
  const pluginRoot = join(runtime, 'plugins', 'wework-electron-host')
  const executorPluginRoot = join(runtime, 'plugins', 'wework-executor-runtime')
  const terminalPluginRoot = join(runtime, 'plugins', 'wework-terminal-runtime')
  await mkdir(join(packageRoot, 'lib'), { recursive: true })
  await mkdir(appPluginRoot, { recursive: true })
  await mkdir(pluginRoot, { recursive: true })
  await mkdir(executorPluginRoot, { recursive: true })
  await mkdir(terminalPluginRoot, { recursive: true })
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
  await writeFile(join(appPluginRoot, 'package.json'), '{}')
  await writeFile(join(pluginRoot, 'package.json'), '{}')
  await writeFile(join(executorPluginRoot, 'package.json'), '{}')
  await writeFile(join(terminalPluginRoot, 'package.json'), '{}')
  return {
    root: runtime,
    fingerprint,
    appPluginRoot,
    pluginRoot,
    executorPluginRoot,
    terminalPluginRoot,
  }
}
