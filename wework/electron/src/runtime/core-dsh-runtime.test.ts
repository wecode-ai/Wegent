import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { CORE_DSH_VERSION, prepareCoreDshLaunch, selectCoreDshRuntime } from './core-dsh-runtime.js'
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
