import { createHash } from 'node:crypto'
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as tar from 'tar'
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  materializeBundledRuntimes,
  type RuntimeMaterializationProgress,
} from './bundled-runtime-materializer.js'
import { resolveWorkbenchProjectPnpmCommand } from './workbench-dsh-runtime.js'

vi.mock('../host/cloud-http.js', () => ({
  cloudFetch: (...args: Parameters<typeof fetch>) => fetch(...args),
}))

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('materializeBundledRuntimes', () => {
  test('reports active phases and omits archive work when the runtime is already ready', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-runtime-progress-'))
    roots.push(root)
    const resources = join(root, 'resources')
    const cache = join(root, 'cache')
    await mkdir(resources)
    const core = await runtimeArchive(resources, 'core', '0.2.0-rc.2', 'a', ['core', 'workbench'])
    await writeFile(
      join(resources, 'runtimes.json'),
      JSON.stringify({ runtimes: [core, { ...core, role: 'workbench' }] })
    )
    const events: { stage: string; phase: string; elapsedMs: number }[] = []
    const options = { onProgress: (event: (typeof events)[number]) => events.push(event) }

    await expect(materializeBundledRuntimes(resources, cache, ['core'], options)).resolves.toBe(
      cache
    )
    for (const stage of [
      'catalog-read',
      'runtime-probe',
      'archive-resolve',
      'archive-extract',
      'runtime-publish',
      'catalog-write',
    ]) {
      expect(events.filter(event => event.stage === stage).map(event => event.phase)).toEqual([
        'started',
        'completed',
      ])
    }
    expect(events.every(event => event.elapsedMs >= 0)).toBe(true)
    expect(JSON.stringify(events)).not.toContain(root)
    const identity = await readFile(join(cache, core.sourceFingerprint, 'runtime.json'), 'utf8')
    expect(JSON.parse(identity).roles).toEqual(['core', 'workbench'])

    events.length = 0
    await materializeBundledRuntimes(resources, cache, ['core'], options)
    expect(events.some(event => event.stage === 'archive-extract')).toBe(false)
    expect(
      events.some(event => event.stage === 'catalog-write' && event.phase === 'completed')
    ).toBe(true)
  })

  test('retains integrity failures when progress diagnostics throw', async () => {
    const root = await mkdtemp(join(tmpdir(), 'wework-runtime-progress-error-'))
    roots.push(root)
    const resources = join(root, 'resources')
    const cache = join(root, 'cache')
    await mkdir(resources)
    const core = await runtimeArchive(resources, 'core', '0.2.0-rc.2', 'a', ['core', 'workbench'])
    await writeFile(
      join(resources, 'runtimes.json'),
      JSON.stringify({ runtimes: [core, { ...core, role: 'workbench' }] })
    )
    await writeFile(join(resources, core.assetName), 'corrupt archive')
    const phases: string[] = []
    await expect(
      materializeBundledRuntimes(resources, cache, ['core'], {
        onProgress: (event: { stage: string; phase: string }) => {
          phases.push(`${event.stage}:${event.phase}`)
          throw new Error('Diagnostic sink unavailable')
        },
      })
    ).rejects.toThrow('Bundled DSH runtime integrity mismatch')
    expect(phases).toContain('archive-resolve:failed')
    expect(phases).toContain('runtime-publish:failed')
    expect(phases).not.toContain('catalog-write:completed')
    await expect(readFile(join(cache, core.sourceFingerprint, 'runtime.json'))).rejects.toThrow()
  })

  test.each(['reuseRoot', 'immutableRoot'] as const)(
    'reports delivered archive checks with %s without hiding failures or extracting a warm runtime',
    async mode => {
      const f = await downloadableRuntimeFixture()
      const source = join(f.root, 'source')
      const shared = join(f.root, 'prepared')
      await materializeBundledRuntimes(
        f.resources,
        source,
        ['core'],
        mode === 'immutableRoot' ? { immutableRoot: shared } : {}
      )
      const options = mode === 'reuseRoot' ? { reuseRoot: source } : { immutableRoot: shared }
      const events: { stage: string; phase: string; elapsedMs: number }[] = []
      await materializeBundledRuntimes(f.resources, join(f.root, 'target'), ['core'], {
        ...options,
        onProgress: event => events.push(event),
      })
      expect(
        events.filter(event => event.stage === 'archive-resolve').map(event => event.phase)
      ).toEqual(['started', 'completed'])
      expect(events.some(event => event.stage === 'archive-extract')).toBe(false)
      expect(events.every(event => event.elapsedMs >= 0)).toBe(true)
      expect(JSON.stringify(events)).not.toContain(f.root)

      const archive = join(f.resources, f.core.assetName)
      const bytes = await readFile(archive)
      bytes[0] ^= 1
      await writeFile(archive, bytes)
      const failed = join(f.root, 'failed-target')
      const phases: string[] = []
      await expect(
        materializeBundledRuntimes(f.resources, failed, ['core'], {
          ...options,
          onProgress: event => {
            phases.push(`${event.stage}:${event.phase}`)
            throw new Error('Diagnostic sink unavailable')
          },
        })
      ).rejects.toThrow('integrity mismatch')
      expect(phases).toContain('archive-resolve:failed')
      expect(phases).toContain('runtime-publish:failed')
      await expect(stat(join(failed, f.core.sourceFingerprint))).rejects.toMatchObject({
        code: 'ENOENT',
      })
    }
  )

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
    const events: RuntimeMaterializationProgress[] = []
    const options = { onProgress: (event: RuntimeMaterializationProgress) => events.push(event) }

    await materializeBundledRuntimes(resources, cache, ['core'], options)
    const identityPath = join(cache, core.sourceFingerprint, 'runtime.json')
    const original = await stat(identityPath)
    await rm(join(resources, core.assetName))

    await materializeBundledRuntimes(resources, cache, ['workbench'], options)
    await materializeBundledRuntimes(resources, cache, ['core', 'workbench'], options)

    expect((await stat(identityPath)).ino).toBe(original.ino)
    expect(JSON.parse(await readFile(identityPath, 'utf8')).roles).toEqual(['core', 'workbench'])
    expect(JSON.parse(await readFile(join(cache, 'runtimes.json'), 'utf8')).runtimes).toEqual([
      core,
      workbench,
    ])
    expect(
      events
        .filter(event => ['archive-resolve', 'archive-extract'].includes(event.stage))
        .map(({ stage, phase }) => [stage, phase])
    ).toEqual([
      ['archive-resolve', 'started'],
      ['archive-resolve', 'completed'],
      ['archive-extract', 'started'],
      ['archive-extract', 'completed'],
    ])
    for (const event of events) {
      expect(event.elapsedMs).toBeGreaterThanOrEqual(0)
      if (event.stage.startsWith('archive-')) {
        expect(event.role).toBe('core')
        expect(event.archiveBytes).toBe(core.archiveBytes)
      }
    }
    expect(JSON.stringify(events)).not.toContain(root)
    expect(JSON.stringify(events)).not.toContain(core.assetName)
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

  test('extracts runtimes without depending on PATH', async () => {
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

describe('installed immutable runtime reuse', () => {
  test('checkpoint directory junction cleanup cannot delete the shared prepared programs', async () => {
    const f = await downloadableRuntimeFixture()
    const shared = join(f.root, 'shared-programs')
    await mkdir(shared)
    const cases = [join(f.root, 'checkpoint-one'), join(f.root, 'checkpoint-two')]
    for (const checkpoint of cases) {
      await mkdir(checkpoint)
      const immutableRoot = join(checkpoint, '.prepared')
      await symlink(shared, immutableRoot, process.platform === 'win32' ? 'junction' : 'dir')
      await materializeBundledRuntimes(
        f.resources,
        join(checkpoint, 'slot'),
        ['core', 'workbench'],
        { immutableRoot }
      )
    }
    const secondProgram = join(cases[1], 'slot', f.core.sourceFingerprint, 'runtime.json')
    const original = await realpath(secondProgram)
    expect(await realpath(join(cases[0], 'slot', f.core.sourceFingerprint, 'runtime.json'))).toBe(
      original
    )
    await rm(cases[0], { recursive: true, force: true })
    expect(await realpath(secondProgram)).toBe(original)
    const third = join(f.root, 'checkpoint-three')
    await mkdir(third)
    const immutableRoot = join(third, '.prepared')
    await symlink(shared, immutableRoot, process.platform === 'win32' ? 'junction' : 'dir')
    await materializeBundledRuntimes(f.resources, join(third, 'slot'), ['core', 'workbench'], {
      immutableRoot,
    })
    expect(await realpath(join(third, 'slot', f.core.sourceFingerprint, 'runtime.json'))).toBe(
      original
    )
    expect(JSON.parse(await readFile(secondProgram, 'utf8')).sourceFingerprint).toBe(
      f.core.sourceFingerprint
    )
  })

  test('shares target programs across preparations without publishing future roles in the source catalog', async () => {
    const f = await downloadableRuntimeFixture()
    await mkdir(f.cache)
    const sourceCatalog = '{"runtimes":[{"role":"core","dshVersion":"source"}]}'
    await writeFile(join(f.cache, 'runtimes.json'), sourceCatalog)
    const immutableRoot = join(f.cache, '.prepared')
    const first = join(f.root, 'first-target')
    const second = join(f.root, 'second-target')
    await materializeBundledRuntimes(f.resources, first, ['core', 'workbench'], { immutableRoot })
    const original = await realpath(join(first, f.core.sourceFingerprint))
    const inode = (await stat(join(original, 'runtime.json'))).ino
    await materializeBundledRuntimes(f.resources, second, ['core', 'workbench'], { immutableRoot })
    expect(await realpath(join(second, f.core.sourceFingerprint))).toBe(original)
    expect((await stat(join(second, f.core.sourceFingerprint, 'runtime.json'))).ino).toBe(inode)
    await writeFile(join(first, 'runtimes.json'), '{"runtimes":[]}')
    expect(await readFile(join(f.cache, 'runtimes.json'), 'utf8')).toBe(sourceCatalog)
    expect(JSON.parse(await readFile(join(second, 'runtimes.json'), 'utf8')).runtimes).toEqual([
      ...f.catalog.runtimes,
      ...f.catalog.downloadableRuntimes,
    ])
    await rm(first, { recursive: true, force: true })
    await stat(join(original, 'runtime.json'))
  })

  test('a published target cache cannot bypass verification of each delivered archive', async () => {
    const f = await downloadableRuntimeFixture()
    const immutableRoot = join(f.root, 'prepared')
    await materializeBundledRuntimes(f.resources, join(f.root, 'first'), ['core'], {
      immutableRoot,
    })
    const archive = join(f.resources, f.core.assetName)
    const bytes = await readFile(archive)
    bytes[0] ^= 1
    await writeFile(archive, bytes)
    await expect(
      materializeBundledRuntimes(f.resources, join(f.root, 'second'), ['core'], { immutableRoot })
    ).rejects.toThrow('integrity mismatch')
  })

  test('different delivered archive hashes never reuse published content with the same fingerprint', async () => {
    const f = await downloadableRuntimeFixture()
    const immutableRoot = join(f.root, 'prepared')
    const first = join(f.root, 'first')
    await materializeBundledRuntimes(f.resources, first, ['core'], { immutableRoot })
    const original = await realpath(join(first, f.core.sourceFingerprint))
    const archive = join(f.resources, f.core.assetName)
    await tar.c({ cwd: original, file: archive, gzip: true, mtime: new Date(0) }, ['.'])
    const bytes = await readFile(archive)
    const changed = {
      ...f.core,
      archiveSha256: createHash('sha256').update(bytes).digest('hex'),
      archiveBytes: bytes.length,
    }
    expect(changed.archiveSha256).not.toBe(f.core.archiveSha256)
    await writeFile(
      join(f.resources, 'runtimes.json'),
      JSON.stringify({ runtimes: [changed, { ...changed, role: 'workbench' }] })
    )
    const second = join(f.root, 'second')
    await materializeBundledRuntimes(f.resources, second, ['core'], { immutableRoot })
    expect(await realpath(join(second, f.core.sourceFingerprint))).not.toBe(original)
  })

  test('shares verified program files while keeping catalogs and release cleanup independent', async () => {
    const f = await downloadableRuntimeFixture()
    await materializeBundledRuntimes(f.resources, f.cache)
    const sourceCatalog = await readFile(join(f.cache, 'runtimes.json'), 'utf8')
    const slot = join(f.root, 'release-slot')
    await materializeBundledRuntimes(f.resources, slot, ['core', 'workbench'], {
      reuseRoot: f.cache,
    })
    const source = join(f.cache, f.core.sourceFingerprint, 'runtime.json')
    expect(await realpath(join(slot, f.core.sourceFingerprint, 'runtime.json'))).toBe(
      await realpath(source)
    )
    await writeFile(join(slot, 'runtimes.json'), '{"runtimes":[]}')
    expect(await readFile(join(f.cache, 'runtimes.json'), 'utf8')).toBe(sourceCatalog)
    await rm(slot, { recursive: true, force: true })
    expect(JSON.parse(await readFile(source, 'utf8')).sourceFingerprint).toBe(
      f.core.sourceFingerprint
    )
  })

  test('does not reuse a fingerprint with a different archive binding', async () => {
    const f = await downloadableRuntimeFixture()
    await materializeBundledRuntimes(f.resources, f.cache)
    const saved = JSON.parse(await readFile(join(f.cache, 'runtimes.json'), 'utf8'))
    saved.runtimes[0].archiveSha256 = 'f'.repeat(64)
    await writeFile(join(f.cache, 'runtimes.json'), JSON.stringify(saved))
    const slot = join(f.root, 'release-slot')
    await materializeBundledRuntimes(f.resources, slot, ['core', 'workbench'], {
      reuseRoot: f.cache,
    })
    expect(await realpath(join(slot, f.core.sourceFingerprint))).not.toBe(
      await realpath(join(f.cache, f.core.sourceFingerprint))
    )
    expect(JSON.parse(await readFile(join(f.cache, 'runtimes.json'), 'utf8'))).toEqual(saved)
  })

  test('a ready installed cache never bypasses integrity of the delivered archive', async () => {
    const f = await downloadableRuntimeFixture()
    await materializeBundledRuntimes(f.resources, f.cache)
    const archive = join(f.resources, f.core.assetName)
    const bytes = await readFile(archive)
    bytes[0] ^= 1
    await writeFile(archive, bytes)
    const slot = join(f.root, 'release-slot')
    await expect(
      materializeBundledRuntimes(f.resources, slot, ['core'], { reuseRoot: f.cache })
    ).rejects.toThrow('integrity mismatch')
    await expect(stat(join(slot, f.core.sourceFingerprint))).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  test('an incompatible installed role is preserved while the target prepares its own content', async () => {
    const f = await downloadableRuntimeFixture()
    await materializeBundledRuntimes(f.resources, f.cache)
    const source = join(f.cache, f.core.sourceFingerprint, 'runtime.json')
    const identity = JSON.parse(await readFile(source, 'utf8'))
    identity.roles = ['workbench']
    await writeFile(source, JSON.stringify(identity))
    const slot = join(f.root, 'release-slot')
    await materializeBundledRuntimes(f.resources, slot, ['core'], { reuseRoot: f.cache })
    expect(
      JSON.parse(await readFile(join(slot, f.core.sourceFingerprint, 'runtime.json'), 'utf8')).roles
    ).toContain('core')
    expect(JSON.parse(await readFile(source, 'utf8'))).toEqual(identity)
  })

  test('rejects conflicting archive identities for two roles sharing a fingerprint', async () => {
    const f = await downloadableRuntimeFixture()
    f.catalog.runtimes[1].archiveSha256 = 'f'.repeat(64)
    await writeFile(join(f.resources, 'runtimes.json'), JSON.stringify(f.catalog))
    await expect(materializeBundledRuntimes(f.resources, f.cache)).rejects.toThrow(
      'conflicting archives'
    )
  })
})

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
