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
  test('extracts only the declared Core and Workbench archives', async () => {
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

    await expect(materializeBundledRuntimes(resources, cache)).resolves.toBe(cache)
    await expect(
      readFile(join(cache, core.sourceFingerprint, 'runtime.json'), 'utf8')
    ).resolves.toContain('"role":"core"')
    await expect(
      readFile(join(cache, workbench.sourceFingerprint, 'runtime.json'), 'utf8')
    ).resolves.toContain('"role":"workbench"')

    const coreMetadata = await stat(join(cache, core.sourceFingerprint, 'runtime.json'))
    await materializeBundledRuntimes(resources, cache)
    expect((await stat(join(cache, core.sourceFingerprint, 'runtime.json'))).ino).toBe(
      coreMetadata.ino
    )
  })
})

async function runtimeArchive(
  resources: string,
  role: string,
  dshVersion: string,
  fingerprintCharacter: string
) {
  const sourceFingerprint = fingerprintCharacter.repeat(64)
  const staging = join(resources, `staging-${role}`)
  await mkdir(staging)
  await writeFile(
    join(staging, 'runtime.json'),
    JSON.stringify({ dshVersion, role, sourceFingerprint })
  )
  const assetName = `${role}.tar.gz`
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
