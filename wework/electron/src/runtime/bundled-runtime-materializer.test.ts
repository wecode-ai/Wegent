import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { materializeBundledRuntimes } from './bundled-runtime-materializer.js'
import { resolveWorkbenchProjectPnpmCommand } from './workbench-dsh-runtime.js'

vi.mock('../host/cloud-http.js', () => ({
  cloudFetch: (...args: Parameters<typeof fetch>) => fetch(...args),
}))

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
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

  test('reports archive entries while unpacking a runtime', async () => {
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
    const entries: string[] = []

    await materializeBundledRuntimes(resources, cache, ['core'], {
      onEntry: entry => entries.push(entry),
    })

    expect(entries).toContain('runtime.json')
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
  const packageRoot = join(staging, 'node_modules', '@deepseek-ai', 'dsh')
  const pnpmRoot = join(staging, 'node_modules', 'pnpm', 'bin')
  await mkdir(join(packageRoot, 'lib'), { recursive: true })
  await mkdir(pnpmRoot, { recursive: true })
  await writeFile(join(packageRoot, 'package.json'), JSON.stringify({ version: dshVersion }))
  await writeFile(join(packageRoot, 'lib', 'bin.js'), '')
  await writeFile(join(pnpmRoot, 'pnpm.cjs'), '')
  const assetName = `${role}-${dshVersion}.tar.gz`
  const archive = join(resources, assetName)
  await tar.c({ cwd: staging, file: archive, gzip: true }, ['.'])
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

async function downloadableRuntimeFixture() {
  const root = await mkdtemp(join(tmpdir(), 'wework-runtime-download-'))
  roots.push(root)
  const resources = join(root, 'resources')
  const cache = join(root, 'cache')
  await mkdir(resources)
  const core = await runtimeArchive(resources, 'core', '0.2.0-rc.2', 'a', ['core', 'workbench'])
  const legacy = {
    ...(await runtimeArchive(resources, 'workbench', '0.1.0-rc.8', 'b')),
    downloadUrl:
      'https://github.com/wecode-ai/Wegent/releases/download/wework-updater/legacy.tar.gz',
  }
  const bytes = await readFile(join(resources, legacy.assetName))
  await rm(join(resources, legacy.assetName))
  const catalog = {
    runtimes: [core, { ...core, role: 'workbench' }],
    downloadableRuntimes: [legacy],
  }
  await writeFile(join(resources, 'runtimes.json'), JSON.stringify(catalog))
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => new Response(bytes))
  const materialize = () =>
    materializeBundledRuntimes(resources, cache, ['workbench'], {
      versionRequirement: legacy.dshVersion,
      fetch: fetchImpl,
    })
  return { root, resources, cache, core, legacy, bytes, catalog, fetchImpl, materialize }
}

describe('downloadable DSH runtimes', () => {
  test('aborts stalled downloads and removes their temporary files', async () => {
    const f = await downloadableRuntimeFixture()
    f.fetchImpl.mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), {
            once: true,
          })
        })
    )
    vi.useFakeTimers()
    try {
      const rejected = expect(f.materialize()).rejects.toThrow()
      await vi.waitFor(() => expect(f.fetchImpl).toHaveBeenCalledTimes(1))
      await vi.advanceTimersByTimeAsync(60_000)
      await rejected
    } finally {
      vi.useRealTimers()
    }
    expect(await readdir(join(f.cache, 'archives'))).toEqual([])
  })

  test('downloads legacy runtimes when source development resources share the runtime cache', async () => {
    const f = await downloadableRuntimeFixture()
    vi.stubGlobal('fetch', f.fetchImpl)
    const command = await resolveWorkbenchProjectPnpmCommand({
      runtimeRoot: f.resources,
      versionRequirement: f.legacy.dshVersion,
      environment: { WEWORK_HARNESS_RESOURCE_ROOT: f.resources },
    })
    expect(command.argsPrefix).toContain(
      join(f.resources, f.legacy.sourceFingerprint, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    )
    await resolveWorkbenchProjectPnpmCommand({
      runtimeRoot: f.resources,
      versionRequirement: f.legacy.dshVersion,
      environment: { WEWORK_HARNESS_RESOURCE_ROOT: f.resources },
    })
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
  })
  test('prepares legacy runtimes for project scripts through the shared Workbench resolver', async () => {
    const f = await downloadableRuntimeFixture()
    vi.stubGlobal('fetch', f.fetchImpl)
    const command = await resolveWorkbenchProjectPnpmCommand({
      runtimeRoot: f.cache,
      versionRequirement: f.legacy.dshVersion,
      environment: {
        WEWORK_HARNESS_RESOURCE_ROOT: f.resources,
        WEWORK_NODE_PATH: process.execPath,
      },
    })
    expect(command.argsPrefix).toContain(
      join(f.cache, f.legacy.sourceFingerprint, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
    )
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
  })
  test('keeps Core and default Workbench offline and does not eagerly fetch legacy runtimes', async () => {
    const f = await downloadableRuntimeFixture()
    await materializeBundledRuntimes(f.resources, f.cache, ['core'], { fetch: f.fetchImpl })
    await materializeBundledRuntimes(f.resources, f.cache, ['workbench'], {
      versionRequirement: '>=0.1.0-rc.8',
      fetch: f.fetchImpl,
    })
    expect(f.fetchImpl).not.toHaveBeenCalled()
    await expect(stat(join(f.cache, f.legacy.sourceFingerprint))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  test('downloads once for concurrent requests, validates and reuses the cache offline', async () => {
    const f = await downloadableRuntimeFixture()
    await Promise.all([f.materialize(), f.materialize()])
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
    expect(f.fetchImpl).toHaveBeenCalledWith(
      f.legacy.downloadUrl,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    )
    expect(await readFile(join(f.cache, 'archives', f.legacy.assetName))).toEqual(f.bytes)
    f.fetchImpl.mockRejectedValue(new Error('offline'))
    await f.materialize()
    await rm(join(f.cache, f.legacy.sourceFingerprint), { recursive: true, force: true })
    await f.materialize()
    expect(f.fetchImpl).toHaveBeenCalledTimes(1)
    expect(
      JSON.parse(await readFile(join(f.cache, 'runtimes.json'), 'utf8')).runtimes
    ).toHaveLength(3)
  })

  test('repairs a corrupt archive cache before extraction', async () => {
    const f = await downloadableRuntimeFixture()
    await f.materialize()
    await rm(join(f.cache, f.legacy.sourceFingerprint), { recursive: true, force: true })
    await writeFile(join(f.cache, 'archives', f.legacy.assetName), Buffer.alloc(f.bytes.length))
    await f.materialize()
    expect(f.fetchImpl).toHaveBeenCalledTimes(2)
    expect(await readFile(join(f.cache, 'archives', f.legacy.assetName))).toEqual(f.bytes)
  })

  test.each(['HTTP', 'network', 'truncated', 'oversized', 'checksum'])(
    'rejects %s failures, removes partial files, and allows recovery',
    async failure => {
      const f = await downloadableRuntimeFixture()
      if (failure === 'HTTP') f.fetchImpl.mockResolvedValueOnce(new Response(null, { status: 404 }))
      if (failure === 'network') f.fetchImpl.mockRejectedValueOnce(new Error('network unavailable'))
      if (failure === 'truncated')
        f.fetchImpl.mockResolvedValueOnce(new Response(f.bytes.subarray(0, 5)))
      if (failure === 'oversized')
        f.fetchImpl.mockResolvedValueOnce(
          new Response(Buffer.concat([f.bytes, Buffer.from('extra')]))
        )
      if (failure === 'checksum')
        f.fetchImpl.mockResolvedValueOnce(new Response(Buffer.alloc(f.bytes.length)))
      await expect(f.materialize()).rejects.toThrow(
        failure === 'network'
          ? 'network unavailable'
          : failure === 'HTTP'
            ? 'HTTP 404'
            : failure === 'checksum'
              ? 'checksum mismatch'
              : 'size mismatch'
      )
      await expect(stat(join(f.cache, f.legacy.sourceFingerprint))).rejects.toMatchObject({
        code: 'ENOENT',
      })
      expect(await readdir(join(f.cache, 'archives'))).toEqual([])
      expect((await readdir(f.cache)).filter(name => name.startsWith('.content-'))).toEqual([])
      await f.materialize()
      expect(f.fetchImpl).toHaveBeenCalledTimes(2)
    }
  )

  test('rejects unsupported requirements before making a network request', async () => {
    const f = await downloadableRuntimeFixture()
    await expect(
      materializeBundledRuntimes(f.resources, f.cache, ['workbench'], {
        versionRequirement: '9.0.0',
        fetch: f.fetchImpl,
      })
    ).rejects.toThrow('missing a requested runtime: 9.0.0')
    expect(f.fetchImpl).not.toHaveBeenCalled()
  })

  test.each(['http://example.com/runtime.tar.gz', 'file:///tmp/runtime.tar.gz'])(
    'rejects insecure download URL %s',
    async downloadUrl => {
      const f = await downloadableRuntimeFixture()
      f.legacy.downloadUrl = downloadUrl
      await writeFile(join(f.resources, 'runtimes.json'), JSON.stringify(f.catalog))
      await expect(f.materialize()).rejects.toThrow('require HTTPS')
      expect(f.fetchImpl).not.toHaveBeenCalled()
    }
  )

  test('rejects archive paths escaping the resource and cache directories', async () => {
    const f = await downloadableRuntimeFixture()
    f.legacy.assetName = '../escape.tar.gz'
    await writeFile(join(f.resources, 'runtimes.json'), JSON.stringify(f.catalog))
    await expect(f.materialize()).rejects.toThrow('descriptor is invalid')
    expect(f.fetchImpl).not.toHaveBeenCalled()
  })
})
