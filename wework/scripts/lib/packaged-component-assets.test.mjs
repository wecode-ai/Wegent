import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extract } from 'tar'
import { afterEach, expect, test } from 'vitest'
import { componentReleaseScope, MANAGED_COMPONENT_IDS } from '../desktop-component-release.mjs'
import { hashComponentPath } from './component-content-hash.mjs'
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

test.each([
  ['macos', 'arm64', 'mac-arm64/WeWork.app/Contents/Resources'],
  ['macos', 'x64', 'mac/WeWork.app/Contents/Resources'],
  ['windows', 'arm64', 'win-arm64-unpacked/resources'],
  ['windows', 'x64', 'win-unpacked/resources'],
  ['linux', 'arm64', 'linux-arm64-unpacked/resources'],
  ['linux', 'x64', 'linux-unpacked/resources'],
])('locates delivered resources for %s/%s', (platform, arch, suffix) => {
  expect(deliveredPackagePaths('/installer', platform, arch).resourcesRoot).toBe(
    join('/installer', suffix)
  )
})

test('rejects unsupported delivered packages', () => {
  expect(() => deliveredPackagePaths('/installer', 'windows', 'ia32')).toThrow(
    'Unsupported delivered package'
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
  expect(result.sourceSha).toBe(options.manifest.sourceSha)
  expect(
    JSON.parse(await readFile(join(options.output, 'components-macos-arm64.json'), 'utf8'))
  ).toEqual(result)
  for (const [id, component] of Object.entries(result.components)) {
    const extracted = join(options.root, 'extracted', id)
    await mkdir(extracted, { recursive: true })
    await extract({ file: join(options.output, component.assetName), cwd: extracted })
    expect(await hashComponentPath(join(extracted, component.entryPath))).toBe(
      options.manifest.components[id].sha256
    )
    expect(component.version).toBe(options.manifest.components[id].version)
    expect(await hashComponentPath(join(options.output, component.assetName))).toBe(
      component.archiveSha256
    )
  }
})

test('rejects bytes changed after the delivered manifest was sealed', async () => {
  const options = await fixture()
  await writeFile(
    join(options.resourcesRoot, options.manifest.components.executor.path),
    'fixture executor'
  )
  await expect(preparePackagedComponentAssets(options)).rejects.toThrow(
    'Packaged component checksum mismatch: executor'
  )
})

test.each([
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
])('rejects invalid delivered %s', async (_name, error, change) => {
  const options = await fixture()
  change(options.manifest)
  await writeFile(options.manifestPath, JSON.stringify(options.manifest))
  await expect(preparePackagedComponentAssets(options)).rejects.toThrow(error)
})
