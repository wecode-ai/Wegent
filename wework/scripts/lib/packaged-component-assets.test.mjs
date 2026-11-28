import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extract } from 'tar'
import { afterEach, test } from 'node:test'
import { componentReleaseScope, MANAGED_COMPONENT_IDS } from '../desktop-component-release.mjs'
import { hashComponentPath } from './component-content-hash.mjs'
import { packBundledComponentArchives } from './bundled-component-archives.mjs'
import {
  deliveredPackagePaths,
  preparePackagedComponentAssets,
} from './packaged-component-assets.mjs'

const temporary = []
afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wework-delivered-components-'))
  temporary.push(root)
  const { resourcesRoot } = deliveredPackagePaths(root, 'macos', 'arm64')
  const manifest = {
    schemaVersion: 1,
    appVersion: '0.6.3',
    sourceSha: 'a'.repeat(40),
    components: {},
  }
  await mkdir(resourcesRoot, { recursive: true })
  for (const id of MANAGED_COMPONENT_IDS) {
    const file = id === 'executor' || id === 'dws'
    const path = file ? `${id}.bin` : id
    const source = join(resourcesRoot, path)
    if (!file) await mkdir(source)
    await writeFile(file ? source : join(source, 'signed.bin'), `signed ${id}`)
    manifest.components[id] = {
      path,
      version: componentReleaseScope(id) === 'version' ? `wework-${'a'.repeat(12)}` : '1.0.0',
      sha256: await hashComponentPath(source),
    }
  }
  const manifestPath = join(resourcesRoot, 'components.json')
  await writeFile(manifestPath, JSON.stringify(manifest))
  return {
    root,
    resourcesRoot,
    manifest,
    manifestPath,
    output: join(root, 'assets'),
    version: '0.6.3',
    platform: 'macos',
    arch: 'arm64',
  }
}

for (const [platform, arch, suffix] of [
  ['macos', 'arm64', 'mac-arm64/WeWork.app/Contents/Resources'],
  ['macos', 'x64', 'mac/WeWork.app/Contents/Resources'],
  ['windows', 'arm64', 'win-arm64-unpacked/resources'],
  ['windows', 'x64', 'win-unpacked/resources'],
  ['linux', 'arm64', 'linux-arm64-unpacked/resources'],
  ['linux', 'x64', 'linux-unpacked/resources'],
]) {
  test(`locates delivered resources for ${platform}/${arch}`, () => {
    assert.equal(
      deliveredPackagePaths('/installer', platform, arch).resourcesRoot,
      join('/installer', suffix)
    )
  })
}

test('rejects unsupported delivered packages', () => {
  assert.throws(
    () => deliveredPackagePaths('/installer', 'windows', 'ia32'),
    /Unsupported delivered package/
  )
})

test('archives delivered signed bytes even after E2E overwrites mutable build resources', async () => {
  const options = await fixture()
  const staging = join(options.root, 'electron/resources')
  await mkdir(staging, { recursive: true })
  await writeFile(
    join(staging, 'components.json'),
    JSON.stringify({ appVersion: 'fixture', sourceSha: 'b'.repeat(40) })
  )
  const result = await preparePackagedComponentAssets(options)
  assert.equal(result.sourceSha, options.manifest.sourceSha)
  assert.deepEqual(
    JSON.parse(await readFile(join(options.output, 'components-macos-arm64.json'), 'utf8')),
    result
  )
  for (const [id, component] of Object.entries(result.components)) {
    const extracted = join(options.root, 'extracted', id)
    await mkdir(extracted, { recursive: true })
    await extract({ file: join(options.output, component.assetName), cwd: extracted })
    assert.equal(
      await hashComponentPath(join(extracted, component.entryPath)),
      options.manifest.components[id].sha256
    )
    assert.equal(component.version, options.manifest.components[id].version)
    assert.equal(
      await hashComponentPath(join(options.output, component.assetName)),
      component.archiveSha256
    )
  }
})

test('reuses and verifies the sealed bundled archive when raw small files are not delivered', async () => {
  const options = await fixture()
  const component = options.manifest.components.weworkCorePlugins
  await rename(
    join(options.resourcesRoot, component.path),
    join(options.resourcesRoot, 'wework-core-plugins')
  )
  component.path = 'wework-core-plugins'
  await writeFile(options.manifestPath, JSON.stringify(options.manifest))
  await packBundledComponentArchives(options.resourcesRoot)
  const packaged = JSON.parse(await readFile(options.manifestPath, 'utf8'))
  const archive = packaged.components.weworkCorePlugins.archive
  await packBundledComponentArchives(options.resourcesRoot)
  assert.deepEqual(
    JSON.parse(await readFile(options.manifestPath, 'utf8')).components.weworkCorePlugins.archive,
    archive
  )
  await rm(join(options.resourcesRoot, component.path), { recursive: true })
  await assert.rejects(readFile(join(options.resourcesRoot, component.path, 'signed.bin')), {
    code: 'ENOENT',
  })
  const result = await preparePackagedComponentAssets(options)
  const delivered = result.components.weworkCorePlugins
  assert.equal(delivered.archiveSha256, archive.sha256)
  assert.equal(delivered.contentSha256, component.sha256)
  assert.equal(delivered.entryPath, '.')
  const unpacked = join(options.root, 'verified-delivery')
  await mkdir(unpacked)
  await extract({ file: join(options.output, delivered.assetName), cwd: unpacked })
  assert.equal(await readFile(join(unpacked, 'signed.bin'), 'utf8'), 'signed weworkCorePlugins')
  const bytes = await readFile(join(options.resourcesRoot, archive.path))
  bytes[bytes.length - 1] ^= 1
  await writeFile(join(options.resourcesRoot, archive.path), bytes)
  await assert.rejects(preparePackagedComponentAssets(options), /archive integrity mismatch/)
})

test('rejects bytes changed after the delivered manifest was sealed', async () => {
  const options = await fixture()
  await writeFile(
    join(options.resourcesRoot, options.manifest.components.executor.path),
    'fixture executor'
  )
  await assert.rejects(
    preparePackagedComponentAssets(options),
    /Packaged component checksum mismatch: executor/
  )
})

for (const [label, message, mutate] of [
  [
    'version',
    'Delivered component manifest does not match the release',
    manifest => {
      manifest.appVersion = '0.6.2'
    },
  ],
  [
    'revision',
    'Packaged component version does not match the release: executor',
    manifest => {
      manifest.components.executor.version = `wework-${'b'.repeat(12)}`
    },
  ],
  [
    'path',
    'Packaged component path escapes the application: executor',
    manifest => {
      manifest.components.executor.path = '../outside'
    },
  ],
]) {
  test(`rejects invalid delivered ${label}`, async () => {
    const options = await fixture()
    mutate(options.manifest)
    await writeFile(options.manifestPath, JSON.stringify(options.manifest))
    await assert.rejects(preparePackagedComponentAssets(options), { message })
  })
}
