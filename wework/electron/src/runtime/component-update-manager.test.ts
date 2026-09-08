import { createHash } from 'node:crypto'
import { chmod, lstat, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join } from 'node:path'
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
    expect(paths.codex).toBe(
      join(fixture.resources, 'codex', 'vendor', 'test-target', 'bin', 'codex')
    )
    expect(paths.dws).toBe(join(fixture.resources, 'bin', 'dws'))
    await expect(
      readFile(join(paths.weworkCorePlugins, 'wework-app', 'web', 'code.js'), 'utf8')
    ).resolves.toBe('plugin code')
    await expect(
      readFile(join(paths.weworkCorePlugins, 'wework-app', 'web', 'vendor', 'static.js'), 'utf8')
    ).resolves.toBe('stable static')
    expect(
      (await lstat(join(paths.weworkCorePlugins, 'wework-terminal-runtime'))).isSymbolicLink()
    ).toBe(false)
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

  test('downloads only changed plugin code and composes it with unchanged static resources', async () => {
    const fixture = await createFixture()
    const update = await createCorePluginUpdate(fixture.root, 'updated plugin code')
    const requests: string[] = []
    const fetch = componentFetch(update.manifest, update.assetName, update.archive, requests)
    const manager = createManager(fixture, fetch)

    expect(await manager.stageAvailableUpdate()).toBe(true)
    const activated = await manager.prepareStartup()

    expect(requests).toEqual([
      `${updateBaseUrl}/components-beta-macos-arm64.json`,
      `${updateBaseUrl}/${update.assetName}`,
    ])
    await expect(
      readFile(join(activated.weworkCorePlugins, 'wework-app', 'web', 'code.js'), 'utf8')
    ).resolves.toBe('updated plugin code')
    await expect(
      readFile(
        join(activated.weworkCorePlugins, 'wework-app', 'web', 'vendor', 'static.js'),
        'utf8'
      )
    ).resolves.toBe('stable static')
  })

  test('does not redownload unchanged packaged components after post-package processing', async () => {
    const fixture = await createFixture()
    const update = await createCorePluginUpdate(fixture.root, 'updated plugin code')
    await writeFile(join(fixture.resources, 'bin', 'wegent-executor'), 'stripped executor')
    const requests: string[] = []
    const manager = createManager(
      fixture,
      componentFetch(update.manifest, update.assetName, update.archive, requests)
    )

    expect(await manager.stageAvailableUpdate()).toBe(true)

    expect(requests).toEqual([
      `${updateBaseUrl}/components-beta-macos-arm64.json`,
      `${updateBaseUrl}/${update.assetName}`,
    ])
  })

  test('stages a future app component set and reuses unchanged local components', async () => {
    const fixture = await createFixture()
    const targetVersion = '1.2.3-beta.5'
    const update = await createExecutorUpdate(fixture.root, 'executor-v2', targetVersion)
    const requests: string[] = []
    const fetch = componentFetch(update.manifest, update.assetName, update.archive, requests)
    const manager = createManager(fixture, fetch)

    expect(await manager.stageUpdateForApp(targetVersion, 'beta')).toBe(true)
    expect(requests).toEqual([
      `${updateBaseUrl}/components-beta-macos-arm64.json`,
      `${updateBaseUrl}/${update.assetName}`,
    ])

    await writePackagedManifest(fixture, targetVersion)
    await Promise.all(
      [
        'harness-runtime',
        'wework-core-plugins',
        'wework-app-static',
        'bundled-plugins',
        'bin',
        'codex',
      ].map(path => rm(join(fixture.resources, path), { recursive: true, force: true }))
    )
    const updatedManager = createManager(fixture, fetch, targetVersion)
    const activated = await updatedManager.prepareStartup()
    expect(await readFile(activated.executor, 'utf8')).toBe('executor-v2')
    expect(await readFile(activated.codex, 'utf8')).toBe('codex')
    expect(await readFile(join(dirname(activated.codex), 'codex-code-mode-host'), 'utf8')).toBe(
      'code-mode-host'
    )
    expect(await updatedManager.rollbackStartup()).toBe(false)
    expect(await readFile((await updatedManager.prepareStartup()).executor, 'utf8')).toBe(
      'executor-v2'
    )
  })

  test('ignores a component manifest for a future app during background checks', async () => {
    const fixture = await createFixture()
    const update = await createExecutorUpdate(fixture.root, 'executor-v2', '1.2.3-beta.5')
    const manager = createManager(
      fixture,
      componentFetch(update.manifest, update.assetName, update.archive)
    )

    await expect(manager.stageAvailableUpdate()).resolves.toBe(false)
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

  test('downloads changed content even when the component version is unchanged', async () => {
    const fixture = await createFixture()
    const update = await createExecutorUpdate(fixture.root, 'executor-rebuilt')
    update.manifest.components.executor.version = fixture.components.executor.version
    const requests: string[] = []
    const manager = createManager(
      fixture,
      componentFetch(update.manifest, update.assetName, update.archive, requests)
    )

    expect(await manager.stageAvailableUpdate()).toBe(true)
    expect(requests).toContain(`${updateBaseUrl}/${update.assetName}`)
    expect(await readFile((await manager.prepareStartup()).executor, 'utf8')).toBe(
      'executor-rebuilt'
    )
  })

  test('activates a complete Codex runtime component with its code-mode host', async () => {
    const fixture = await createFixture()
    const update = await createCodexUpdate(fixture.root, true)
    const manager = createManager(
      fixture,
      componentFetch(update.manifest, update.assetName, update.archive)
    )

    expect(await manager.stageAvailableUpdate()).toBe(true)
    const activated = await manager.prepareStartup()

    expect(await readFile(activated.codex, 'utf8')).toBe('codex-v2')
    expect(await readFile(join(dirname(activated.codex), 'codex-code-mode-host'), 'utf8')).toBe(
      'code-mode-host-v2'
    )
  })

  test('falls back to packaged Codex when an active component omits its code-mode host', async () => {
    const fixture = await createFixture()
    const update = await createCodexUpdate(fixture.root, false)
    const manager = createManager(
      fixture,
      componentFetch(update.manifest, update.assetName, update.archive)
    )

    expect(await manager.stageAvailableUpdate()).toBe(true)
    const activated = await manager.prepareStartup()

    expect(activated.codex).toBe(
      join(fixture.resources, 'codex', 'vendor', 'test-target', 'bin', 'codex')
    )
    expect(await readFile(activated.codex, 'utf8')).toBe('codex')
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
  await mkdir(join(resources, 'wework-core-plugins', 'wework-app', 'web'), { recursive: true })
  await mkdir(join(resources, 'wework-core-plugins', 'wework-terminal-runtime'), {
    recursive: true,
  })
  await mkdir(join(resources, 'wework-app-static', 'vendor'), { recursive: true })
  await mkdir(join(resources, 'wework-app-static', 'wasm'), { recursive: true })
  await mkdir(join(resources, 'bundled-plugins'), { recursive: true })
  await mkdir(join(resources, 'bin'), { recursive: true })
  const codexBin = join(resources, 'codex', 'vendor', 'test-target', 'bin')
  await mkdir(codexBin, { recursive: true })
  await writeFile(join(resources, 'harness-runtime', 'runtime.txt'), 'dsh')
  await writeFile(
    join(resources, 'wework-core-plugins', 'wework-app', 'web', 'code.js'),
    'plugin code'
  )
  await writeFile(
    join(resources, 'wework-core-plugins', 'wework-terminal-runtime', 'index.js'),
    'terminal code'
  )
  await writeFile(join(resources, 'wework-app-static', 'vendor', 'static.js'), 'stable static')
  await writeFile(join(resources, 'wework-app-static', 'wasm', 'module.wasm'), 'wasm')
  await writeFile(join(resources, 'bundled-plugins', 'marketplace.json'), 'bundled plugins')
  await writeFile(join(resources, 'bin', 'wegent-executor'), 'executor-v1')
  await writeFile(join(resources, 'bin', 'dws'), 'dws')
  await writeFile(
    join(resources, 'codex', 'WEGENT_CODEX_BINARY.json'),
    JSON.stringify({
      binaryPath: 'vendor/test-target/bin/codex',
    })
  )
  await writeFile(join(codexBin, 'codex'), 'codex')
  await writeFile(join(codexBin, 'codex-code-mode-host'), 'code-mode-host')
  const paths: Record<ManagedComponentId, string> = {
    coreDsh: 'harness-runtime',
    weworkCorePlugins: 'wework-core-plugins',
    weworkAppStatic: 'wework-app-static',
    bundledPlugins: 'bundled-plugins',
    executor: 'bin/wegent-executor',
    codex: 'codex',
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

function createManager(
  fixture: Fixture,
  fetch: typeof globalThis.fetch,
  currentAppVersion = appVersion
): ComponentUpdateManager {
  return new ComponentUpdateManager({
    resourcesRoot: fixture.resources,
    dataDirectory: fixture.data,
    updateBaseUrl,
    currentAppVersion,
    platform: 'darwin',
    arch: 'arm64',
    fetch,
  })
}

async function createExecutorUpdate(root: string, content: string, targetAppVersion = appVersion) {
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
      appVersion: targetAppVersion,
      channel: 'beta',
      platform: 'macos',
      arch: 'arm64',
      components,
    },
  }
}

async function createCorePluginUpdate(root: string, content: string) {
  const source = join(root, 'source-core-plugins')
  const archivePath = join(root, 'core-plugins.tar.gz')
  await mkdir(join(source, 'wework-app', 'web'), { recursive: true })
  await writeFile(join(source, 'wework-app', 'web', 'code.js'), content)
  await tar.c(
    {
      cwd: source,
      file: archivePath,
      gzip: true,
      mtime: new Date(0),
      portable: true,
    },
    ['.']
  )
  const archive = await readFile(archivePath)
  const archiveSha256 = sha256(archive)
  const assetName = `WeworkComponent_weworkCorePlugins_${archiveSha256}_macos_arm64.tar.gz`
  const fixture = await readFixture(root)
  const contentSha256 = await hashComponentPath(source)
  const components = Object.fromEntries(
    MANAGED_COMPONENT_IDS.map(id => {
      const packaged = fixture.components[id]
      if (id !== 'weworkCorePlugins') {
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
          version: 'wework-updated',
          contentSha256,
          archiveSha256,
          archiveBytes: archive.length,
          downloadUrl: `${updateBaseUrl}/${assetName}`,
          entryPath: '.',
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

async function createCodexUpdate(root: string, includeHost: boolean) {
  const source = join(root, `source-codex-${includeHost ? 'complete' : 'incomplete'}`)
  const archivePath = join(root, `codex-${includeHost ? 'complete' : 'incomplete'}.tar.gz`)
  const binaryDirectory = join(source, 'vendor', 'test-target', 'bin')
  await mkdir(binaryDirectory, { recursive: true })
  await writeFile(
    join(source, 'WEGENT_CODEX_BINARY.json'),
    JSON.stringify({ binaryPath: 'vendor/test-target/bin/codex' })
  )
  await writeFile(join(binaryDirectory, 'codex'), 'codex-v2')
  if (includeHost) {
    await writeFile(join(binaryDirectory, 'codex-code-mode-host'), 'code-mode-host-v2')
  }
  await tar.c(
    {
      cwd: source,
      file: archivePath,
      gzip: true,
      mtime: new Date(0),
      portable: true,
    },
    ['.']
  )
  const archive = await readFile(archivePath)
  const archiveSha256 = sha256(archive)
  const assetName = `WeworkComponent_codex_${archiveSha256}_macos_arm64.tar.gz`
  const fixture = await readFixture(root)
  const contentSha256 = await hashComponentPath(source)
  const components = Object.fromEntries(
    MANAGED_COMPONENT_IDS.map(id => {
      const packaged = fixture.components[id]
      if (id !== 'codex') {
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
          version: 'codex-v2',
          contentSha256,
          archiveSha256,
          archiveBytes: archive.length,
          downloadUrl: `${updateBaseUrl}/${assetName}`,
          entryPath: '.',
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
  archive: Uint8Array,
  requests: string[] = []
): typeof globalThis.fetch {
  return async input => {
    const url = String(input)
    requests.push(url)
    if (url.endsWith('components-beta-macos-arm64.json')) {
      return Response.json(manifest)
    }
    if (url.endsWith(assetName)) return new Response(archive)
    return new Response(null, { status: 404 })
  }
}

async function writePackagedManifest(fixture: Fixture, targetAppVersion: string): Promise<void> {
  await writeFile(
    join(fixture.resources, 'components.json'),
    JSON.stringify({
      schemaVersion: 1,
      appVersion: targetAppVersion,
      channel: 'beta',
      components: fixture.components,
    })
  )
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

test('shares a staging task and bounds component downloads to three while reporting every byte', async () => {
  const fixture = await createFixture()
  const ids: ManagedComponentId[] = ['executor', 'dws', 'bundledPlugins', 'coreDsh']
  const updates = await Promise.all(
    ids.map(id => createExecutorUpdate(fixture.root, `changed-${id}`))
  )
  const manifest = structuredClone(updates[0]!.manifest)
  const assets = new Map<string, Buffer>()
  for (let i = 0; i < ids.length; i++) {
    const update = updates[i]!
    manifest.components[ids[i]!] = update.manifest.components.executor
    assets.set(`${updateBaseUrl}/${update.assetName}`, update.archive)
  }
  let active = 0
  let maximum = 0
  let requests = 0
  let unlock!: () => void
  const gate = new Promise<void>(resolve => {
    unlock = resolve
  })
  const manager = createManager(fixture, async input => {
    const url = String(input)
    if (url.endsWith('.json')) return Response.json(manifest)
    const bytes = assets.get(url)
    if (!bytes) throw new Error(`Unexpected request: ${url}`)
    requests++
    active++
    maximum = Math.max(maximum, active)
    if (active === 3) unlock()
    await gate
    active--
    return new Response(new Uint8Array(bytes))
  })
  const reports: number[] = []
  const first = manager.stageUpdateForApp(appVersion, 'beta', false, p =>
    reports.push(p.downloadedBytes)
  )
  const duplicate = manager.stageUpdateForApp(appVersion, 'beta')
  await Promise.all([first, duplicate])
  expect(maximum).toBe(3)
  expect(requests).toBe(4)
  expect(reports.at(-1)).toBe([...assets.values()].reduce((sum, bytes) => sum + bytes.length, 0))
  await manager.stageUpdateForApp(appVersion, 'beta')
  expect(requests).toBe(4)
})
