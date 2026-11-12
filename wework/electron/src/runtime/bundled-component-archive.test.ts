import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { afterEach, expect, test } from 'vitest'
import {
  materializeBundledComponentArchive,
  type BundledComponentArchiveMaterializationOptions,
} from './bundled-component-archive.js'
import { hashComponentPath, sha256 } from './component-content-hash.js'
import { ComponentUpdateManager, MANAGED_COMPONENT_IDS } from './component-update-manager.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'bundled-component-'))
  roots.push(root)
  const source = join(root, 'source')
  const resources = join(root, 'resources')
  const cache = join(root, 'cache')
  await mkdir(source)
  await mkdir(resources)
  await writeFile(join(source, 'plugin.js'), 'export const delivered = true\n')
  const archivePath = join(resources, 'component.tar.gz')
  await tar.create({ cwd: source, file: archivePath, gzip: true, portable: true }, ['.'])
  const archive = {
    path: 'component.tar.gz',
    sha256: await sha256(archivePath),
    bytes: (await stat(archivePath)).size,
  }
  const content = await hashComponentPath(source)
  const materialize = (options?: BundledComponentArchiveMaterializationOptions) =>
    materializeBundledComponentArchive(resources, cache, archive, content, options)
  return { root, resources, archivePath, archive, content, cache, materialize }
}

test('extracts exact delivered component bytes and reuses the verified physical program', async () => {
  const f = await fixture()
  const stages: Array<{ stage: string; phase: string }> = []
  const first = await f.materialize({
    stagePrefix: 'test-component',
    onStage: event => stages.push(event),
  })
  const physical = await realpath(first)
  expect(await readFile(join(first, 'plugin.js'), 'utf8')).toBe('export const delivered = true\n')
  const warmStages: Array<{ stage: string; phase: string }> = []
  expect(
    await realpath(
      await f.materialize({
        stagePrefix: 'test-component',
        onStage: event => warmStages.push(event),
      })
    )
  ).toBe(physical)
  expect(stages).toContainEqual(
    expect.objectContaining({ stage: 'test-component-source-verify', phase: 'completed' })
  )
  expect(stages).toContainEqual(
    expect.objectContaining({ stage: 'test-component-extract', phase: 'completed' })
  )
  expect(warmStages).toContainEqual(
    expect.objectContaining({ stage: 'test-component-source-verify', phase: 'completed' })
  )
  expect(warmStages).toContainEqual(
    expect.objectContaining({ stage: 'test-component-content-verify', phase: 'completed' })
  )
  await rm(f.cache, { recursive: true, force: true })
  expect(await stat(f.archivePath)).toMatchObject({ size: f.archive.bytes })
})

test('a warm program never bypasses verification of the delivered archive', async () => {
  const f = await fixture()
  await f.materialize()
  const damaged = await readFile(f.archivePath)
  damaged[damaged.length - 1] ^= 1
  await writeFile(f.archivePath, damaged)
  await expect(f.materialize()).rejects.toThrow('archive integrity mismatch')
})

test('does not publish a tree whose complete content digest differs', async () => {
  const f = await fixture()
  await expect(
    materializeBundledComponentArchive(f.resources, f.cache, f.archive, 'a'.repeat(64))
  ).rejects.toThrow('content checksum mismatch')
  await expect(stat(join(f.cache, f.archive.sha256))).rejects.toMatchObject({ code: 'ENOENT' })
})

test('rejects lexical and physical archive escapes before materialization', async () => {
  const f = await fixture()
  await expect(
    materializeBundledComponentArchive(
      f.resources,
      f.cache,
      { ...f.archive, path: '../outside.tar.gz' },
      f.content
    )
  ).rejects.toThrow('metadata is invalid')
  const outside = join(f.root, 'outside.tar.gz')
  await writeFile(outside, await readFile(f.archivePath))
  await rm(f.archivePath)
  await symlink(outside, f.archivePath)
  await expect(f.materialize()).rejects.toThrow('escapes its package')
})

test('startup composes the delivered archived plugin and static files without loose package directories', async () => {
  const f = await fixture()
  const components: Record<
    string,
    { version: string; path: string; sha256: string; archive?: typeof f.archive }
  > = {}
  for (const id of MANAGED_COMPONENT_IDS) {
    const root = join(f.resources, id)
    await mkdir(root)
    await writeFile(join(root, 'component.txt'), id)
    components[id] = { version: '1.0.0', path: id, sha256: '' }
  }
  const core = join(f.resources, 'weworkCorePlugins')
  const app = join(core, 'wework-app')
  await mkdir(join(app, 'web'), { recursive: true })
  await writeFile(join(app, 'package.json'), '{}')
  await writeFile(join(app, 'web/code.js'), 'delivered web code')
  const staticRoot = join(f.resources, 'weworkAppStatic')
  for (const name of ['vendor', 'wasm']) {
    await mkdir(join(staticRoot, name))
    await writeFile(join(staticRoot, name, 'data.bin'), name)
  }
  const codex = join(f.resources, 'codex')
  await writeFile(join(codex, 'WEGENT_CODEX_BINARY.json'), JSON.stringify({ binaryPath: 'codex' }))
  await writeFile(join(codex, 'codex'), 'binary')
  await writeFile(
    join(codex, process.platform === 'win32' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host'),
    'host'
  )
  for (const [id, component] of Object.entries(components)) {
    component.sha256 = await hashComponentPath(join(f.resources, id))
    if (!['weworkCorePlugins', 'weworkAppStatic', 'bundledPlugins'].includes(id)) continue
    const archive = join(f.resources, `${id}.tar.gz`)
    await tar.create({ cwd: join(f.resources, id), file: archive, gzip: true }, ['.'])
    component.archive = {
      path: `${id}.tar.gz`,
      sha256: await sha256(archive),
      bytes: (await stat(archive)).size,
    }
    await rm(join(f.resources, id), { recursive: true })
  }
  await writeFile(
    join(f.resources, 'components.json'),
    JSON.stringify({ schemaVersion: 1, appVersion: '1.0.0', components })
  )
  const manager = new ComponentUpdateManager({
    resourcesRoot: f.resources,
    dataDirectory: join(f.root, 'data'),
    currentAppVersion: '1.0.0',
    updateBaseUrl: '',
    validateExecutor: async () => {},
  })
  const first = await manager.prepareStartup()
  expect(await readFile(join(first.weworkCorePlugins, 'wework-app/web/code.js'), 'utf8')).toBe(
    'delivered web code'
  )
  expect(
    await readFile(join(first.weworkCorePlugins, 'wework-app/web/vendor/data.bin'), 'utf8')
  ).toBe('vendor')
  expect(await readFile(join(first.bundledPlugins, 'component.txt'), 'utf8')).toBe('bundledPlugins')
  expect((await manager.prepareStartup()).weworkCorePlugins).toBe(first.weworkCorePlugins)
})
