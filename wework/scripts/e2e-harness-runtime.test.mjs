import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, expect, test } from 'vitest'
import { verifyDefaultOnlyDshPackage } from '../e2e/desktop/modules/dsh-runtime-cache.mjs'
import { preparePackagedHarnessRuntimeRoots } from '../e2e/desktop/modules/packaged-harness-runtime.mjs'

const run = promisify(execFile)
const temporaryDirectories = []

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))
  )
})

async function packagedRuntime() {
  const directory = await mkdtemp(join(tmpdir(), 'wework-e2e-harness-runtime-'))
  temporaryDirectories.push(directory)
  const appBinary = join(directory, 'application', 'wework')
  const resourceRoot = join(directory, 'application', 'resources', 'harness-runtime')
  const source = join(directory, 'runtime-source')
  const fingerprint = 'a'.repeat(64)
  const runtime = {
    dshVersion: '0.2.0-rc.2',
    sourceFingerprint: fingerprint,
    assetName: 'default.tar.gz',
  }
  const legacy = {
    dshVersion: '0.1.0-rc.8',
    sourceFingerprint: 'b'.repeat(64),
    assetName: 'legacy.tar.gz',
  }
  const entry = join(source, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  await mkdir(dirname(entry), { recursive: true })
  await mkdir(resourceRoot, { recursive: true })
  await writeFile(entry, 'export {}\n')
  await writeFile(
    join(source, 'runtime.json'),
    JSON.stringify({ ...runtime, roles: ['core', 'workbench'] })
  )
  const archivePath = join(resourceRoot, runtime.assetName)
  await run('tar', ['-czf', archivePath, '-C', source, '.'], { timeout: 10_000 })
  await writeFile(
    join(resourceRoot, 'runtimes.json'),
    JSON.stringify({
      runtimes: ['core', 'workbench'].map(role => ({ ...runtime, role })),
      downloadableRuntimes: [legacy],
    })
  )
  const extractions = []
  const prepare = options =>
    preparePackagedHarnessRuntimeRoots({
      appBinary,
      platform: 'linux',
      extractArchive: async (archive, target) => {
        extractions.push(target)
        await run('tar', ['-xzf', archive, '-C', target], { timeout: 10_000 })
      },
      ...options,
    })
  return { directory, resourceRoot, legacy, archivePath, extractions, prepare }
}

async function snapshotTree(directory) {
  const result = {}
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    result[entry.name] = entry.isDirectory()
      ? await snapshotTree(path)
      : {
          sha256: createHash('sha256')
            .update(await readFile(path))
            .digest('hex'),
          mtimeMs: (await stat(path)).mtimeMs,
        }
  }
  return result
}

async function addLegacyCache(root, fixture) {
  await mkdir(join(root, 'archives'), { recursive: true })
  await copyFile(fixture.archivePath, join(root, 'archives', fixture.legacy.assetName))
  await mkdir(join(root, fixture.legacy.sourceFingerprint), { recursive: true })
  const catalog = JSON.parse(await readFile(join(fixture.resourceRoot, 'runtimes.json'), 'utf8'))
  await writeFile(
    join(root, 'runtimes.json'),
    JSON.stringify({
      ...catalog,
      runtimes: [...catalog.runtimes, { ...fixture.legacy, role: 'workbench' }],
    })
  )
}

test('configured shared runtimes are reused without extraction or mutation', async () => {
  const fixture = await packagedRuntime()
  const shared = await fixture.prepare({ resultDirectory: join(fixture.directory, 'shared') })
  const before = await snapshotTree(shared.harnessRuntimeRoot)
  const resultDirectory = join(fixture.directory, 'scenario')

  const prepared = await fixture.prepare({
    configuredRuntimeRoot: shared.harnessRuntimeRoot,
    resultDirectory,
  })

  expect(prepared.harnessRuntimeRoot).toBe(shared.harnessRuntimeRoot)
  expect(fixture.extractions).toHaveLength(1)
  expect(await snapshotTree(shared.harnessRuntimeRoot)).toEqual(before)
  await expect(stat(join(resultDirectory, 'harness-runtime'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
})

test('cold-download scenarios prepare a private runtime despite a populated shared cache', async () => {
  const fixture = await packagedRuntime()
  const shared = await fixture.prepare({ resultDirectory: join(fixture.directory, 'shared') })
  await addLegacyCache(shared.harnessRuntimeRoot, fixture)
  const before = await snapshotTree(shared.harnessRuntimeRoot)

  const prepared = await fixture.prepare({
    configuredRuntimeRoot: shared.harnessRuntimeRoot,
    isolated: true,
    resultDirectory: join(fixture.directory, 'scenario'),
  })

  expect(prepared.harnessRuntimeRoot).not.toBe(shared.harnessRuntimeRoot)
  expect(fixture.extractions).toHaveLength(2)
  await verifyDefaultOnlyDshPackage(fixture.resourceRoot, prepared.harnessRuntimeRoot)
  expect(await snapshotTree(shared.harnessRuntimeRoot)).toEqual(before)
})

test('independent cold-download scenarios do not inherit another scenario legacy cache', async () => {
  const fixture = await packagedRuntime()
  const shared = await fixture.prepare({ resultDirectory: join(fixture.directory, 'shared') })
  const sharedBefore = await snapshotTree(shared.harnessRuntimeRoot)
  const first = await fixture.prepare({
    configuredRuntimeRoot: shared.harnessRuntimeRoot,
    isolated: true,
    resultDirectory: join(fixture.directory, 'first'),
  })
  await addLegacyCache(first.harnessRuntimeRoot, fixture)
  const firstBefore = await snapshotTree(first.harnessRuntimeRoot)

  const second = await fixture.prepare({
    configuredRuntimeRoot: shared.harnessRuntimeRoot,
    isolated: true,
    resultDirectory: join(fixture.directory, 'second'),
  })

  expect(second.harnessRuntimeRoot).not.toBe(first.harnessRuntimeRoot)
  await verifyDefaultOnlyDshPackage(fixture.resourceRoot, second.harnessRuntimeRoot)
  expect(await snapshotTree(first.harnessRuntimeRoot)).toEqual(firstBefore)
  expect(await snapshotTree(shared.harnessRuntimeRoot)).toEqual(sharedBefore)
})
