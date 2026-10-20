import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { afterEach, describe, expect, test } from 'vitest'
import { materializeBundledRuntimes } from './bundled-runtime-materializer.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('materializeBundledRuntimes', () => {
  test('shares one extracted archive across roles and later launches', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-shared-runtime-materializer-'))
    roots.push(root)
    const resources = join(root, 'resources')
    const cache = join(root, 'cache')
    await mkdir(resources)
    const core = await runtimeArchive(resources, 'core', '0.2.0-rc.2', 'a', ['core', 'workbench'])
    const workbench = { ...core, role: 'workbench' }
    await writeFile(
      join(resources, 'runtimes.json'),
      JSON.stringify({ runtimes: [core, workbench] })
    )

    await materializeBundledRuntimes(resources, cache, ['core'])
    const identityPath = join(cache, core.sourceFingerprint, 'runtime.json')
    const original = await stat(identityPath)
    await rm(join(resources, core.assetName))

    await materializeBundledRuntimes(resources, cache, ['workbench'])
    await materializeBundledRuntimes(resources, cache)

    expect((await stat(identityPath)).ino).toBe(original.ino)
    expect(JSON.parse(await readFile(identityPath, 'utf8')).roles).toEqual(['core', 'workbench'])
    expect(JSON.parse(await readFile(join(cache, 'runtimes.json'), 'utf8')).runtimes).toEqual([
      core,
      workbench,
    ])
  })

  test('rejects an archive that does not declare the requested role', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-invalid-runtime-role-'))
    roots.push(root)
    const resources = join(root, 'resources')
    await mkdir(resources)
    const core = await runtimeArchive(resources, 'core', '0.2.0-rc.2', 'a', ['workbench'])
    await writeFile(
      join(resources, 'runtimes.json'),
      JSON.stringify({
        runtimes: [core, { ...core, role: 'workbench' }],
      })
    )

    await expect(
      materializeBundledRuntimes(resources, join(root, 'cache'), ['core'])
    ).rejects.toThrow('Bundled DSH runtime identity is invalid')
  })

  test('extracts only requested runtimes while retaining the complete catalog', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-runtime-materializer-'))
    roots.push(root)
    const resources = join(root, 'resources')
    const cache = join(root, 'cache')
    await mkdir(resources)
    const core = await runtimeArchive(resources, 'core', '0.1.1-rc.2', 'a')
    const workbenchRc8 = await runtimeArchive(resources, 'workbench', '0.1.0-rc.8', 'b')
    const workbenchRc9 = await runtimeArchive(resources, 'workbench', '0.1.0-rc.9', 'c')
    await writeFile(
      join(resources, 'runtimes.json'),
      JSON.stringify({ runtimes: [core, workbenchRc8, workbenchRc9] })
    )

    await expect(materializeBundledRuntimes(resources, cache, ['core'])).resolves.toBe(cache)
    await expect(
      readFile(join(cache, core.sourceFingerprint, 'runtime.json'), 'utf8')
    ).resolves.toContain('"role":"core"')
    await expect(
      readFile(join(cache, workbenchRc8.sourceFingerprint, 'runtime.json'), 'utf8')
    ).rejects.toThrow()
    await expect(readFile(join(cache, 'runtimes.json'), 'utf8')).resolves.toContain(
      workbenchRc9.sourceFingerprint
    )

    await expect(materializeBundledRuntimes(resources, cache, ['workbench'])).resolves.toBe(cache)
    await expect(
      readFile(join(cache, workbenchRc8.sourceFingerprint, 'runtime.json'), 'utf8')
    ).resolves.toContain('"role":"workbench"')
    await expect(
      readFile(join(cache, workbenchRc9.sourceFingerprint, 'runtime.json'), 'utf8')
    ).resolves.toContain('"role":"workbench"')

    const coreMetadata = await stat(join(cache, core.sourceFingerprint, 'runtime.json'))
    await materializeBundledRuntimes(resources, cache)
    expect((await stat(join(cache, core.sourceFingerprint, 'runtime.json'))).ino).toBe(
      coreMetadata.ino
    )
  })

  test('rejects duplicate runtime role requests', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-runtime-materializer-'))
    roots.push(root)
    const resources = join(root, 'resources')
    const cache = join(root, 'cache')
    await mkdir(resources)
    const core = await runtimeArchive(resources, 'core', '0.1.1-rc.2', 'a')
    const workbench = await runtimeArchive(resources, 'workbench', '0.1.0-rc.8', 'b')
    await writeFile(
      join(resources, 'runtimes.json'),
      JSON.stringify({ runtimes: [core, workbench] })
    )

    await expect(materializeBundledRuntimes(resources, cache, ['core', 'core'])).rejects.toThrow(
      'Bundled Electron runtime roles are invalid'
    )
  })

  test('extracts runtimes without an external tar executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-runtime-materializer-'))
    roots.push(root)
    const resources = join(root, 'resources')
    const cache = join(root, 'cache')
    await mkdir(resources)
    const core = await runtimeArchive(resources, 'core', '0.1.1-rc.2', 'a')
    const workbench = await runtimeArchive(resources, 'workbench', '0.1.0-rc.8', 'b')
    await writeFile(
      join(resources, 'runtimes.json'),
      JSON.stringify({ runtimes: [core, workbench] })
    )

    const originalPath = process.env.PATH
    process.env.PATH = ''
    try {
      await expect(materializeBundledRuntimes(resources, cache)).resolves.toBe(cache)
    } finally {
      process.env.PATH = originalPath
    }
  })
})

async function runtimeArchive(
  resources: string,
  role: string,
  dshVersion: string,
  fingerprintCharacter: string,
  roles?: string[]
) {
  const sourceFingerprint = fingerprintCharacter.repeat(64)
  const staging = join(resources, `staging-${role}`)
  await mkdir(staging)
  await writeFile(
    join(staging, 'runtime.json'),
    JSON.stringify({ dshVersion, ...(roles ? { roles } : { role }), sourceFingerprint })
  )
  const assetName = `${role}-${dshVersion}.tar.gz`
  const archive = join(resources, assetName)
  await tar.c({ cwd: staging, file: archive, gzip: true }, ['runtime.json'])
  const bytes = await readFile(archive)
  await rm(staging, { recursive: true, force: true })
  return {
    dshVersion,
    role,
    sourceFingerprint,
    archiveSha256: createHash('sha256').update(bytes).digest('hex'),
    archiveBytes: bytes.byteLength,
    assetName,
  }
}
