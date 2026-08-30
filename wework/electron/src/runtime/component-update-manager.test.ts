import { createHash } from 'node:crypto'
import { chmod, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, describe, expect, test } from 'vitest'
import * as tar from 'tar'
import {
  ComponentUpdateManager,
  hashComponentPath,
  MANAGED_COMPONENT_IDS,
  type ManagedComponentId,
} from './component-update-manager.js'

const temporaryDirectories: string[] = []
const appVersion = '1.2.3-beta.4'
const updateBaseUrl = 'https://updates.example/releases/download/wework-updater'

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true }))
  )
})

describe('ComponentUpdateManager', () => {
  test('uses packaged components when no update has been staged', async () => {
    const fixture = await createFixture()
    const manager = createManager(fixture, async () => new Response(null, { status: 404 }))

    const paths = await manager.prepareStartup()

    expect(paths.coreDsh).toBe(join(fixture.resources, 'harness-runtime'))
    expect(paths.bundledPlugins).toBe(join(fixture.resources, 'bundled-plugins'))
    expect(paths.executor).toBe(join(fixture.resources, 'bin', 'wegent-executor'))
    expect(paths.dws).toBe(join(fixture.resources, 'bin', 'dws'))
    expect(paths.contentSha256.weworkCorePlugins).toBe(
      await hashComponentPath(join(fixture.resources, 'wework-core-plugins'))
    )
  })

  test('downloads changed components and atomically activates them on next startup', async () => {
    const fixture = await createFixture()
    const update = await createExecutorUpdate(fixture.root, 'executor-v2')
    const fetch = componentFetch(update.manifest, update.assetName, update.archive)
    const manager = createManager(fixture, fetch)

    expect(await manager.stageAvailableUpdate()).toBe(true)
    const activated = await manager.prepareStartup()
    expect(await readFile(activated.executor, 'utf8')).toBe('executor-v2')
    expect(activated.contentSha256.executor).toBe(update.manifest.components.executor.contentSha256)
    expect((await stat(activated.executor)).mode & 0o111).not.toBe(0)
    await manager.confirmStartup()

    const restarted = createManager(fixture, fetch)
    expect(await readFile((await restarted.prepareStartup()).executor, 'utf8')).toBe('executor-v2')
  })

  test('downloads a changed component outside the manifest origin and path', async () => {
    const fixture = await createFixture()
    const update = await createExecutorUpdate(fixture.root, 'executor-v2')
    update.manifest.components.executor.downloadUrl = `http://components.example/independent-release/${update.assetName}`
    const manager = createManager(
      fixture,
      componentFetch(update.manifest, update.assetName, update.archive)
    )

    expect(await manager.stageAvailableUpdate()).toBe(true)
    expect(await readFile((await manager.prepareStartup()).executor, 'utf8')).toBe('executor-v2')
  })

  test('rolls back an unconfirmed component set after a failed startup', async () => {
    const fixture = await createFixture()
    const first = await createExecutorUpdate(fixture.root, 'executor-v2')
    let activeUpdate = first
    const fetch: typeof globalThis.fetch = async input =>
      componentFetch(activeUpdate.manifest, activeUpdate.assetName, activeUpdate.archive)(input)
    const manager = createManager(fixture, fetch)
    await manager.stageAvailableUpdate()
    await manager.prepareStartup()
    await manager.confirmStartup()

    activeUpdate = await createExecutorUpdate(fixture.root, 'executor-v3')
    await manager.stageAvailableUpdate()
    expect(await readFile((await manager.prepareStartup()).executor, 'utf8')).toBe('executor-v3')
    expect(await manager.rollbackStartup()).toBe(true)

    expect(await readFile((await manager.prepareStartup()).executor, 'utf8')).toBe('executor-v2')
  })

  test('automatically rolls back when the previous process did not confirm startup', async () => {
    const fixture = await createFixture()
    const update = await createExecutorUpdate(fixture.root, 'executor-v2')
    const fetch = componentFetch(update.manifest, update.assetName, update.archive)
    const manager = createManager(fixture, fetch)
    await manager.stageAvailableUpdate()
    expect(await readFile((await manager.prepareStartup()).executor, 'utf8')).toBe('executor-v2')

    const restarted = createManager(fixture, fetch)
    expect(await readFile((await restarted.prepareStartup()).executor, 'utf8')).toBe('executor-v1')
  })

  test('rejects a corrupt archive without staging it', async () => {
    const fixture = await createFixture()
    const update = await createExecutorUpdate(fixture.root, 'executor-v2')
    const corrupt = Buffer.from('corrupt')
    const fetch = componentFetch(update.manifest, update.assetName, corrupt)
    const manager = createManager(fixture, fetch)

    await expect(manager.stageAvailableUpdate()).rejects.toThrow('archive size mismatch')
    expect(await readFile((await manager.prepareStartup()).executor, 'utf8')).toBe('executor-v1')
  })
})

interface Fixture {
  root: string
  resources: string
  data: string
  components: Record<ManagedComponentId, { version: string; path: string; sha256: string }>
}

async function createFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'wework-components-'))
  temporaryDirectories.push(root)
  const resources = join(root, 'resources')
  const data = join(root, 'data')
  await mkdir(join(resources, 'harness-runtime'), { recursive: true })
  await mkdir(join(resources, 'wework-core-plugins'), { recursive: true })
  await mkdir(join(resources, 'bundled-plugins'), { recursive: true })
  await mkdir(join(resources, 'bin'), { recursive: true })
  await mkdir(join(resources, 'codex'), { recursive: true })
  await writeFile(join(resources, 'harness-runtime', 'runtime.txt'), 'dsh')
  await writeFile(join(resources, 'wework-core-plugins', 'plugin.txt'), 'plugins')
  await writeFile(join(resources, 'bundled-plugins', 'marketplace.json'), 'bundled plugins')
  await writeFile(join(resources, 'bin', 'wegent-executor'), 'executor-v1')
  await writeFile(join(resources, 'bin', 'dws'), 'dws')
  await writeFile(join(resources, 'codex', 'codex'), 'codex')
  const paths: Record<ManagedComponentId, string> = {
    coreDsh: 'harness-runtime',
    weworkCorePlugins: 'wework-core-plugins',
    bundledPlugins: 'bundled-plugins',
    executor: 'bin/wegent-executor',
    codex: 'codex/codex',
    dws: 'bin/dws',
  }
  const components = Object.fromEntries(
    await Promise.all(
      MANAGED_COMPONENT_IDS.map(async id => [
        id,
        {
          version: '1.0.0',
          path: paths[id],
          sha256: await hashComponentPath(join(resources, paths[id])),
        },
      ])
    )
  ) as Fixture['components']
  await writeFile(
    join(resources, 'components.json'),
    JSON.stringify({
      schemaVersion: 1,
      appVersion,
      channel: 'beta',
      components,
    })
  )
  return { root, resources, data, components }
}

function createManager(fixture: Fixture, fetch: typeof globalThis.fetch): ComponentUpdateManager {
  return new ComponentUpdateManager({
    resourcesRoot: fixture.resources,
    dataDirectory: fixture.data,
    updateBaseUrl,
    currentAppVersion: appVersion,
    platform: 'darwin',
    arch: 'arm64',
    fetch,
  })
}

async function createExecutorUpdate(root: string, content: string) {
  const source = join(root, `source-${content}`)
  const archivePath = join(root, `${content}.tar.gz`)
  await mkdir(source, { recursive: true })
  const executable = join(source, 'wegent-executor')
  await writeFile(executable, content)
  await chmod(executable, 0o755)
  await tar.c(
    {
      cwd: source,
      file: archivePath,
      gzip: true,
      mtime: new Date(0),
      portable: true,
    },
    [basename(executable)]
  )
  const archive = await readFile(archivePath)
  const archiveSha256 = sha256(archive)
  const assetName = `WeworkComponent_executor_${archiveSha256}_macos_arm64.tar.gz`
  const fixture = await readFixture(root)
  const components = Object.fromEntries(
    MANAGED_COMPONENT_IDS.map(id => {
      const packaged = fixture.components[id]
      if (id !== 'executor') {
        return [
          id,
          {
            version: packaged.version,
            contentSha256: packaged.sha256,
            archiveSha256: '0'.repeat(64),
            archiveBytes: 1,
            downloadUrl: `${updateBaseUrl}/unused-${id}.tar.gz`,
            entryPath: '.',
          },
        ]
      }
      return [
        id,
        {
          version: content,
          contentSha256: sha256(Buffer.from(content)),
          archiveSha256,
          archiveBytes: archive.length,
          downloadUrl: `${updateBaseUrl}/${assetName}`,
          entryPath: basename(executable),
        },
      ]
    })
  )
  return {
    assetName,
    archive,
    manifest: {
      schemaVersion: 1,
      appVersion,
      channel: 'beta',
      platform: 'macos',
      arch: 'arm64',
      components,
    },
  }
}

async function readFixture(root: string): Promise<Fixture> {
  const resources = join(root, 'resources')
  const manifest = JSON.parse(await readFile(join(resources, 'components.json'), 'utf8')) as {
    components: Fixture['components']
  }
  await stat(resources)
  return {
    root,
    resources,
    data: join(root, 'data'),
    components: manifest.components,
  }
}

function componentFetch(
  manifest: object,
  assetName: string,
  archive: Uint8Array
): typeof globalThis.fetch {
  return async input => {
    const url = String(input)
    if (url.endsWith('components-beta-macos-arm64.json')) {
      return Response.json(manifest)
    }
    if (url.endsWith(assetName)) return new Response(archive)
    return new Response(null, { status: 404 })
  }
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}
