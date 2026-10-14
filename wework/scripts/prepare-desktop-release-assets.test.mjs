import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'

import { resolveHarnessRuntimeCachePaths } from './lib/harness-runtime-cache.mjs'
import { hashComponentPath } from './lib/component-content-hash.mjs'

const execute = promisify(execFile)
const sourceRoot = process.cwd()
const roots = []
const componentIds = [
  'coreDsh',
  'weworkCorePlugins',
  'weworkAppStatic',
  'bundledPlugins',
  'executor',
  'codex',
  'dws',
]

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex')
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function prepareComponents(weworkRoot, runtimes) {
  const resources = join(weworkRoot, 'electron/resources')
  const components = {}
  for (const id of componentIds) {
    const path =
      id === 'coreDsh'
        ? 'harness-runtime'
        : id === 'executor'
          ? 'bin/wegent-executor'
          : id === 'dws'
            ? 'bin/dws'
            : id
    const target = join(resources, path)
    if (id === 'executor' || id === 'dws') {
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, `${id}:immutable-signed-content`)
    } else {
      await mkdir(target, { recursive: true })
      await writeFile(join(target, 'content'), `${id}:immutable-signed-content`)
      if (id === 'coreDsh') {
        await writeFile(join(target, 'runtimes.json'), JSON.stringify({ runtimes }))
      }
    }
    components[id] = { path, version: '1.2.3', sha256: await hashComponentPath(target) }
  }
  await writeFile(
    join(resources, 'components.json'),
    JSON.stringify({ appVersion: '1.2.3', components })
  )
  return resources
}

async function prepareRuntimeArchives(assetDirectory, platform, arch) {
  const runtimes = []
  for (const [role, dshVersion, bundled] of [
    ['core', '0.2.0-rc.2', true],
    ['workbench', '0.2.0-rc.2', true],
    ['workbench', '0.1.0-rc.8', false],
  ]) {
    const bytes = Buffer.from(`${role}:${dshVersion}:signed-archive`)
    const assetName = `harness-runtime-${platform}-${arch}-${role}-${dshVersion}-${sha256(bytes)}.tar.gz`
    await writeFile(join(assetDirectory, assetName), bytes)
    runtimes.push({
      role,
      dshVersion,
      bundled,
      assetName,
      sourceFingerprint: sha256(bytes),
      archiveSha256: sha256(bytes),
      archiveBytes: bytes.length,
    })
  }
  return runtimes
}

async function prepareFixture(platform, arch, configuredCache) {
  const root = await mkdtemp(join(tmpdir(), 'wework-release-assets-cache-'))
  roots.push(root)
  const weworkRoot = join(root, 'wework')
  for (const name of [
    'scripts/prepare-desktop-release-assets.mjs',
    'scripts/desktop-component-release.mjs',
    'scripts/collect-harness-runtime-release-assets.mjs',
    'scripts/lib/harness-runtime-cache.mjs',
    'scripts/lib/component-content-hash.mjs',
    'electron/src/runtime/component-content-hash.ts',
    'electron/src/runtime/file-operation-queue.ts',
  ]) {
    const target = join(weworkRoot, name)
    await mkdir(dirname(target), { recursive: true })
    await cp(join(sourceRoot, name), target)
  }
  await mkdir(join(weworkRoot, 'node_modules'))
  await symlink(
    await realpath(join(sourceRoot, 'node_modules/tar')),
    join(weworkRoot, 'node_modules/tar'),
    'junction'
  )
  const environment = {
    ...process.env,
    WEWORK_HARNESS_RUNTIME_CACHE_ROOT: '',
    WEWORK_HARNESS_RUNTIME_ASSET_CACHE_ROOT: configuredCache ? '../shared-cache' : '',
    WEWORK_USE_COMPONENTIZED_HOST_UPDATE: 'false',
  }
  const assetDirectory = resolveHarnessRuntimeCachePaths(weworkRoot, environment).assetDirectory
  await mkdir(assetDirectory, { recursive: true })
  const runtimes = await prepareRuntimeArchives(assetDirectory, platform, arch)
  const resources = await prepareComponents(weworkRoot, runtimes)
  const installer = join(weworkRoot, 'electron/release-installer')
  await mkdir(installer)
  const artifactNames =
    platform === 'macos'
      ? [`WeWork_1.2.3_macos_${arch}.dmg`, `WeWork_1.2.3_macos_${arch}.zip`]
      : platform === 'windows'
        ? [`WeWork_1.2.3_windows_${arch}-setup.exe`]
        : [`WeWork_1.2.3_linux_${arch === 'x64' ? 'x86_64' : arch}.AppImage`]
  for (const name of artifactNames) await writeFile(join(installer, name), 'installer')
  return { root, weworkRoot, environment, runtimes, resources }
}

test.each([
  ['linux', 'x64', false],
  ['macos', 'arm64', false],
  ['windows', 'x64', false],
  ['linux', 'x64', true],
  ['macos', 'arm64', true],
  ['windows', 'x64', true],
])(
  'collects %s %s runtime assets from the producer cache (configured=%s)',
  async (platform, arch, configured) => {
    const fixture = await prepareFixture(platform, arch, configured)
    const output = join(fixture.root, 'output')
    await execute(
      process.execPath,
      [
        join(fixture.weworkRoot, 'scripts/prepare-desktop-release-assets.mjs'),
        platform,
        arch,
        '1.2.3',
        output,
      ],
      { cwd: fixture.root, env: fixture.environment }
    )
    for (const descriptor of fixture.runtimes) {
      const bytes = await readFile(join(output, descriptor.assetName))
      expect(sha256(bytes)).toBe(descriptor.archiveSha256)
      expect(
        JSON.parse(
          await readFile(join(output, descriptor.assetName.replace(/\.tar\.gz$/, '.json')), 'utf8')
        )
      ).toEqual(descriptor)
    }
    const components = JSON.parse(
      await readFile(join(output, `components-${platform}-${arch}.json`), 'utf8')
    )
    expect(Object.keys(components.components)).toEqual(componentIds)
    expect(components.components.executor.entryPath).toBe('wegent-executor')
    expect(components.components.executor.contentSha256).toBe(
      sha256('executor:immutable-signed-content')
    )
    await expect(readFile(join(fixture.resources, 'bin/wegent-executor'), 'utf8')).resolves.toBe(
      'executor:immutable-signed-content'
    )
  }
)
