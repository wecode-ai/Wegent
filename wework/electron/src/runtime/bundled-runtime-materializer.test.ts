import { createHash } from 'node:crypto'
import { lstat, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { materializeBundledRuntimes } from './bundled-runtime-materializer.js'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('materializeBundledRuntimes', () => {
  test('links a prepared core directory without extracting an archive at startup', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-runtime-directory-'))
    roots.push(root)
    const resources = join(root, 'resources')
    const cache = join(root, 'cache')
    await mkdir(resources)
    const core = {
      ...(await runtimeArchive(resources, 'core', '0.2.0-rc.2', 'a')),
      directory: 'a'.repeat(64),
    }
    const workbench = await runtimeArchive(resources, 'workbench', '0.2.0-rc.2', 'b')
    const source = join(resources, core.directory)
    await mkdir(source)
    await writeFile(join(source, 'runtime.json'), JSON.stringify(core))
    await rm(join(resources, core.assetName))
    await writeFile(
      join(resources, 'runtimes.json'),
      JSON.stringify({ runtimes: [core, workbench] })
    )
    await materializeBundledRuntimes(resources, cache, ['core'])
    const target = join(cache, core.sourceFingerprint)
    expect((await lstat(target)).isSymbolicLink()).toBe(true)
    expect(await realpath(target)).toBe(await realpath(source))
  })

  test('downloads only the requested legacy runtime and reuses it offline', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-runtime-download-'))
    roots.push(root)
    const resources = join(root, 'resources')
    const cache = join(root, 'cache')
    await mkdir(resources)
    const core = await runtimeArchive(resources, 'core', '0.2.0-rc.2', 'a')
    const current = await runtimeArchive(resources, 'workbench', '0.2.0-rc.2', 'b')
    const legacy = {
      ...(await runtimeArchive(resources, 'workbench', '0.1.0-rc.8', 'c')),
      bundled: false,
      downloadUrl: 'https://example.test/legacy.tar.gz',
    }
    const bytes = await readFile(join(resources, legacy.assetName))
    await rm(join(resources, legacy.assetName))
    await writeFile(
      join(resources, 'runtimes.json'),
      JSON.stringify({ runtimes: [core, current, legacy] })
    )
    const fetchRuntime = vi.fn<typeof fetch>(async () => new Response(bytes))

    await materializeBundledRuntimes(resources, cache, ['core'], { fetch: fetchRuntime })
    expect(fetchRuntime).not.toHaveBeenCalled()
    await materializeBundledRuntimes(resources, cache, ['workbench'], {
      versionRequirement: '0.1.0-rc.8',
      fetch: fetchRuntime,
    })
    expect(fetchRuntime).toHaveBeenCalledTimes(1)
    await expect(
      readFile(join(cache, legacy.sourceFingerprint, 'runtime.json'), 'utf8')
    ).resolves.toContain('0.1.0-rc.8')
    await expect(stat(join(cache, current.sourceFingerprint))).rejects.toThrow()
    fetchRuntime.mockImplementation(async () => {
      throw new Error('offline')
    })
    await materializeBundledRuntimes(resources, cache, ['workbench'], {
      versionRequirement: '0.1.0-rc.8',
      fetch: fetchRuntime,
    })
    expect(fetchRuntime).toHaveBeenCalledTimes(1)
  })

  test('rejects corrupt downloaded runtimes without publishing a cache entry', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-runtime-corruption-'))
    roots.push(root)
    const resources = join(root, 'resources')
    const cache = join(root, 'cache')
    await mkdir(resources)
    const core = await runtimeArchive(resources, 'core', '0.2.0-rc.2', 'a')
    const legacy = {
      ...(await runtimeArchive(resources, 'workbench', '0.1.0-rc.8', 'b')),
      bundled: false,
      downloadUrl: 'https://example.test/legacy.tar.gz',
    }
    const bytes = await readFile(join(resources, legacy.assetName))
    bytes[bytes.length - 1] ^= 1
    await writeFile(join(resources, 'runtimes.json'), JSON.stringify({ runtimes: [core, legacy] }))
    await expect(
      materializeBundledRuntimes(resources, cache, ['workbench'], {
        versionRequirement: '0.1.0-rc.8',
        fetch: async () => new Response(bytes),
      })
    ).rejects.toThrow('checksum mismatch')
    await expect(stat(join(cache, legacy.sourceFingerprint))).rejects.toThrow()
    await expect(stat(join(cache, `${legacy.sourceFingerprint}.tar.gz`))).rejects.toThrow()
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
  fingerprintCharacter: string
) {
  const sourceFingerprint = fingerprintCharacter.repeat(64)
  const staging = join(resources, `staging-${role}`)
  await mkdir(staging)
  await writeFile(
    join(staging, 'runtime.json'),
    JSON.stringify({ dshVersion, role, sourceFingerprint })
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
