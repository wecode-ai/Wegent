import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'

import { CORE_PLUGIN_DIRECTORIES, corePluginTarget } from './lib/core-plugin-resources.mjs'
import { prepareDevelopmentComponentResources } from './prepare-dev-component-resources.mjs'

let fixtureRoot

afterEach(async () => {
  if (fixtureRoot) await rm(fixtureRoot, { recursive: true, force: true })
  fixtureRoot = undefined
})

describe('prepare development component resources', () => {
  test('links immutable resources and copies lightweight core plugins', async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'wework-dev-resources-'))
    const weworkRoot = join(fixtureRoot, 'wework')
    const resourcesRoot = join(fixtureRoot, 'dev-resources')
    const runtimeRoot = await directory(join(fixtureRoot, 'runtime'))
    const executorPath = await file(join(fixtureRoot, 'bin', 'executor'))
    const codexPath = await file(join(fixtureRoot, 'bin', 'codex'))
    const dwsPath = await file(join(fixtureRoot, 'bin', 'dws'))

    await json(join(weworkRoot, 'package.json'), {
      version: '1.0.0',
      devDependencies: { 'dingtalk-workspace-cli': '1.2.3' },
    })
    await json(join(weworkRoot, 'electron', 'package.json'), {
      version: '2.0.0',
      devDependencies: { electron: '3.0.0' },
    })
    await directory(join(weworkRoot, 'resources', 'bundled-plugins'))
    for (const directoryName of CORE_PLUGIN_DIRECTORIES) {
      await json(join(weworkRoot, 'dsh', directoryName, 'package.json'), {
        name: directoryName,
      })
    }
    await file(join(weworkRoot, 'dsh', 'app-wework', 'web', 'generated.js'))

    await prepareDevelopmentComponentResources({
      weworkRoot,
      resourcesRoot,
      runtimeRoot,
      executorPath,
      codexPath,
      dwsPath,
      sourceSha: 'a'.repeat(40),
    })

    const manifest = JSON.parse(await readFile(join(resourcesRoot, 'components.json'), 'utf8'))
    expect(manifest.appVersion).toBe('2.0.0')
    expect(manifest.components.coreDsh.path).toBe('harness-runtime')
    expect(manifest.components.dws.version).toBe('1.2.3')
    await expect(realpath(join(resourcesRoot, 'harness-runtime'))).resolves.toBe(
      await realpath(runtimeRoot)
    )
    expect(manifest.components.weworkCorePlugins.path).toBe('wework-core-plugins')
    expect(manifest.components.weworkCorePlugins.sha256).toMatch(/^[0-9a-f]{64}$/)
    const appPluginRoot = join(
      resourcesRoot,
      manifest.components.weworkCorePlugins.path,
      corePluginTarget('app-wework')
    )
    expect((await lstat(appPluginRoot)).isSymbolicLink()).toBe(false)
    await expect(readFile(join(appPluginRoot, 'package.json'), 'utf8')).resolves.toContain(
      'app-wework'
    )
    await expect(readFile(join(appPluginRoot, 'web', 'generated.js'))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  }, 20_000)
})

async function directory(path) {
  await mkdir(path, { recursive: true })
  return path
}

async function file(path) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, '')
  return path
}

async function json(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, `${JSON.stringify(value)}\n`)
}
