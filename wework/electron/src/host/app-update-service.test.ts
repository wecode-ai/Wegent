import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterEach, expect, test, vi } from 'vitest'
import { AppUpdateService } from './app-update-service.js'
import { atomicReleaseWrite, ReleaseStore, type DesktopRelease } from '../runtime/release-store.js'
import type { UpgradeCatalog } from '../runtime/upgrade-policy.mjs'
import type { ComponentPaths } from '../runtime/component-update-manager.js'
import { currentCoreProfile, profileRevision } from '../runtime/release-profile.js'
import * as physicalRelease from '../runtime/physical-release-files.js'
import * as releaseSignature from '../runtime/release-signature.js'

const roots: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true })
})

function publishNextTarget(catalog: UpgradeCatalog) {
  const target = catalog.releases[2]
  catalog.edges.push({
    ...catalog.edges[0],
    to: target.version,
    toSha256: target.sha256,
    toSourceSha: target.sourceSha,
  })
  target.notes = 'Refreshed release notes'
  return target
}

async function readyFixture(readableDataSchemas = [1], currentVersion = '1.0.0') {
  const context = await fixture(currentVersion)
  const { service, options, catalog, store } = context
  const profile = currentCoreProfile(options.dataDirectory)
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), '{}')
  const target = catalog.releases[1]
  target.readableDataSchemas = readableDataSchemas
  target.sha256 = createHash('sha256').update('damaged').digest('hex')
  catalog.edges[0].toSha256 = target.sha256
  vi.spyOn(physicalRelease, 'extractPhysicalRelease').mockImplementation(async (_archive, host) => {
    await writeFile(
      join(host, 'wework-release.json'),
      JSON.stringify({
        schemaVersion: 1,
        version: target.version,
        sourceSha: target.sourceSha,
        executable: 'host',
        resources: 'resources',
      })
    )
  })
  vi.spyOn(releaseSignature, 'verifyReleaseSignature').mockResolvedValue(undefined)
  // Unit tests isolate the target-owned preparation subprocess; the packaged
  // upgrade checkpoint exercises its real extraction, signature and runtime.
  const preparation = vi
    .spyOn(
      service as unknown as { prepareHostEnvironment: (release: DesktopRelease) => Promise<void> },
      'prepareHostEnvironment'
    )
    .mockImplementation(async release => {
      await store.save(release)
      await atomicReleaseWrite(
        join(store.slot(release.id), 'prepared.json'),
        JSON.stringify({ sourceRevision: await profileRevision(profile) })
      )
    })
  await service.check('stable')
  await service.download('stable')
  return { ...context, preparation }
}
async function fixture(currentVersion = '1.0.0') {
  const directory = await mkdtemp(join(tmpdir(), 'wework-updater-test-'))
  roots.push(directory)
  const store = new ReleaseStore(join(directory, 'releases'))
  await store.save({
    schemaVersion: 1,
    id: 'source',
    version: currentVersion,
    executable: join(directory, 'host'),
    resources: join(directory, 'resources'),
    runtimeRoot: join(directory, 'runtimes'),
    profileRoot: join(directory, 'profile'),
    dataSchema: 1,
    readableDataSchemas: [1],
  })
  await atomicReleaseWrite(join(store.root, 'active'), 'source')
  const catalog: UpgradeCatalog = {
    schemaVersion: 1,
    channel: 'stable',
    platform:
      process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
    arch: process.arch as 'arm64' | 'x64',
    releases: ['1.0.0', '1.1.0', '1.2.0'].map((version, i) => ({
      version,
      minSourceVersion: i === 0 ? '0.0.0' : '1.0.0',
      url: `https://example.com/${version}.tar.gz`,
      sha256: String(i + 1).repeat(64),
      sourceSha: String(i + 1).repeat(40),
      bytes: 7,
      dataSchema: 1,
      readableDataSchemas: [1],
      revoked: false,
    })),
    edges: [
      {
        from: '1.0.0',
        to: '1.1.0',
        fromSha256: '1'.repeat(64),
        toSha256: '2'.repeat(64),
        fromSourceSha: '1'.repeat(40),
        toSourceSha: '2'.repeat(40),
        runId: '123',
        evidenceSha256: 'a'.repeat(64),
        upgrade: 'passed',
        rollback: 'passed',
        revoked: false,
      },
    ],
  }
  if (!catalog.releases.some(release => release.version === currentVersion)) {
    catalog.releases.push({
      ...catalog.releases[0],
      version: currentVersion,
      sha256: 'b'.repeat(64),
      sourceSha: 'b'.repeat(40),
    })
  }
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockImplementation(
      async url =>
        new Response(
          String(url).endsWith('.tar.gz')
            ? 'damaged'
            : JSON.stringify({ schemaVersion: 1, upgradePolicy: catalog })
        )
    )
  const shutdown = vi.fn().mockResolvedValue(undefined)
  const restart = vi.fn()
  const options = {
    store,
    dataDirectory: directory,
    currentVersion,
    executable: join(directory, 'host'),
    resources: join(directory, 'resources'),
    runtimeRoot: join(directory, 'runtimes'),
    dataSchema: 1,
    readableDataSchemas: [1],
    updateBaseUrl: 'https://example.com',
    isPackaged: true,
    shutdown,
    restart,
    fetch,
  }
  return {
    service: new AppUpdateService(options),
    options,
    catalog,
    fetch,
    shutdown,
    restart,
    store,
  }
}
test('uses new fields on the existing component endpoint and selects a verified next hop', async () => {
  const { service, fetch } = await fixture()
  expect(await service.check('stable')).toMatchObject({
    version: '1.1.0',
    targetVersion: '1.1.0',
    path: ['1.1.0'],
  })
  expect(String(fetch.mock.calls[0][0])).toContain('/components-stable-')
})

test('a published intermediate source can prepare and install using interval evidence', async () => {
  const { service, catalog, shutdown, restart, store } = await readyFixture([1], '1.0.5')
  expect(catalog.edges.some(edge => edge.from === '1.0.5')).toBe(false)
  expect(await service.check('stable')).toMatchObject({
    currentVersion: '1.0.5',
    version: '1.1.0',
    path: ['1.1.0'],
    readyToInstall: true,
  })
  await service.createInstallAction('1.1.0')()
  expect(shutdown).toHaveBeenCalledOnce()
  expect(restart).toHaveBeenCalledOnce()
  const activation = (await store.activation())!
  expect(activation.from).toBe('source')
  expect((await store.read(activation.to)).version).toBe('1.1.0')
  expect((await store.read(activation.from)).version).toBe('1.0.5')
})

test.each(['edge', 'anchor', 'target', 'explicit-pair'])(
  'installation rechecks interval %s revocation before shutdown',
  async revoked => {
    const { service, catalog, shutdown } = await readyFixture([1], '1.0.5')
    const install = service.createInstallAction('1.1.0')
    if (revoked === 'edge') catalog.edges[0].revoked = true
    if (revoked === 'anchor') catalog.releases[0].revoked = true
    if (revoked === 'target') catalog.releases[1].revoked = true
    if (revoked === 'explicit-pair') {
      const source = catalog.releases.find(release => release.version === '1.0.5')!
      catalog.edges.push({
        ...catalog.edges[0],
        from: source.version,
        fromSha256: source.sha256,
        fromSourceSha: source.sourceSha,
        revoked: true,
      })
    }
    await expect(install()).rejects.toThrow('revoked or changed')
    expect(shutdown).not.toHaveBeenCalled()
  }
)
test('never treats the absence of an upgrade policy as permission to update directly', async () => {
  const { service, fetch } = await fixture()
  fetch.mockResolvedValue(new Response(JSON.stringify({ schemaVersion: 1, appVersion: '1.2.0' })))
  await expect(service.check('stable')).rejects.toThrow('no verified upgrade policy')
})

test('records rollback failures before shutdown without losing the original error', async () => {
  const { options } = await fixture()
  const log = vi.fn()
  const service = new AppUpdateService({ ...options, log })
  await expect(service.createRollbackAction(false)()).rejects.toThrow('No previous healthy release')
  expect(log).toHaveBeenCalledWith({
    event: 'release-operation-failed',
    stopping: false,
    message: 'No previous healthy release is available',
  })
  expect(service.downloadProgress()).toMatchObject({ phase: 'failed' })
})

test('diagnostic failures do not hide the original rollback failure', async () => {
  const { options } = await fixture()
  const diagnostic = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const service = new AppUpdateService({
      ...options,
      log: () => {
        throw new Error('Log unavailable')
      },
    })
    await expect(service.createRollbackAction(false)()).rejects.toThrow(
      'No previous healthy release'
    )
    expect(diagnostic).toHaveBeenCalledOnce()
  } finally {
    diagnostic.mockRestore()
  }
})
test('reports an unavailable path separately from already being up to date', async () => {
  const { service, catalog } = await fixture()
  catalog.edges = []
  await expect(service.check('stable')).rejects.toMatchObject({ code: 'UPGRADE_PATH_UNAVAILABLE' })
})
test('rejects a policy for another platform or channel', async () => {
  const { service, catalog } = await fixture()
  catalog.channel = 'beta'
  await expect(service.check('stable')).rejects.toThrow('target mismatch')
})
test('a rolled-back target remains reachable but cannot download without explicit confirmation', async () => {
  const { service, store, fetch, shutdown } = await fixture()
  await atomicReleaseWrite(join(store.root, 'rolled-back-versions.json'), JSON.stringify(['1.1.0']))
  const update = await service.check('stable')
  expect(update).toMatchObject({
    version: '1.1.0',
    retryConfirmation: { reason: 'legacy-rollback' },
  })
  await expect(service.download('stable')).rejects.toMatchObject({
    code: 'UPDATE_RETRY_CONFIRMATION_REQUIRED',
  })
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('.tar.gz'))).toHaveLength(0)
  expect(shutdown).not.toHaveBeenCalled()
  await expect(service.download('stable', update!.retryConfirmation!.token)).rejects.toThrow(
    'integrity'
  )
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('.tar.gz'))).toHaveLength(1)
  expect(await store.rollbackHistory()).toHaveLength(1)
})

test.each(['update-rollback-history.json', 'rolled-back-versions.json'])(
  'unreadable %s blocks checks and downloads until repaired',
  async name => {
    const { service, store, fetch, shutdown, restart } = await fixture()
    const path = join(store.root, name)
    await atomicReleaseWrite(path, '{')

    await expect(service.check('stable')).rejects.toThrow()
    await expect(service.download('stable')).rejects.toThrow()

    expect(await readFile(path, 'utf8')).toBe('{')
    expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('.tar.gz'))).toHaveLength(0)
    expect(shutdown).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
    expect((await store.active())?.id).toBe('source')

    await atomicReleaseWrite(path, '[]')
    expect(await service.check('stable')).toMatchObject({ version: '1.1.0' })
  }
)

test.each(['update-rollback-history.json', 'rolled-back-versions.json'])(
  'damage to %s after preparation cannot bypass the install consent check',
  async name => {
    const { service, store, shutdown, restart } = await readyFixture()
    const install = service.createInstallAction()
    const path = join(store.root, name)
    await atomicReleaseWrite(path, '{')

    await expect(install()).rejects.toThrow()

    expect(await readFile(path, 'utf8')).toBe('{')
    expect(shutdown).not.toHaveBeenCalled()
    expect(restart).not.toHaveBeenCalled()
    expect((await store.active())?.id).toBe('source')
    expect(await store.activation()).toBeNull()
  }
)

test('retry consent is bound to the failed attempt and cannot authorize a different attempt', async () => {
  const { service, store, fetch } = await fixture()
  const failed = { token: 'first', version: '1.1.0', reason: 'startup-failed' }
  await atomicReleaseWrite(
    join(store.root, 'update-rollback-history.json'),
    JSON.stringify([failed])
  )
  const update = await service.check('stable')
  await atomicReleaseWrite(
    join(store.root, 'update-rollback-history.json'),
    JSON.stringify([{ ...failed, token: 'second' }])
  )
  await expect(service.download('stable', update!.retryConfirmation!.token)).rejects.toMatchObject({
    code: 'UPDATE_RETRY_CONFIRMATION_REQUIRED',
  })
  expect(service.downloadProgress().update?.retryConfirmation?.token).not.toBe(
    update!.retryConfirmation!.token
  )
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('.tar.gz'))).toHaveLength(0)
})

test('local retry confirmation never overrides a revoked server release', async () => {
  const { service, store, catalog, fetch } = await fixture()
  await atomicReleaseWrite(join(store.root, 'rolled-back-versions.json'), JSON.stringify(['1.1.0']))
  const update = await service.check('stable')
  catalog.releases[1].revoked = true
  await expect(service.download('stable', update!.retryConfirmation!.token)).rejects.toMatchObject({
    code: 'UPGRADE_PATH_UNAVAILABLE',
  })
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('.tar.gz'))).toHaveLength(0)
})
test('corrupt downloads fail once, retain the active release, and never shut down the app', async () => {
  const { service, fetch, shutdown, restart, store } = await fixture()
  await service.check('stable')
  const results = await Promise.allSettled([service.download(), service.download()])
  expect(results.every(result => result.status === 'rejected')).toBe(true)
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('.tar.gz'))).toHaveLength(1)
  expect(service.downloadProgress()).toMatchObject({
    phase: 'failed',
    failure: { message: 'Release package integrity check failed' },
  })
  expect((await store.active())?.id).toBe('source')
  expect(shutdown).not.toHaveBeenCalled()
  expect(restart).not.toHaveBeenCalled()
  expect(() => service.createInstallAction()).toThrow('not ready')
})

test('retains a running thin installation without copying or preparing its host', async () => {
  const { options, store, fetch, shutdown } = await fixture()
  await rm(join(store.root, 'active'))
  const profile = currentCoreProfile(options.dataDirectory)
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), '{"name":"running-profile"}')
  const components = { executor: '/running/executor' } as ComponentPaths
  const service = new AppUpdateService({ ...options, runningComponents: () => components })
  await service.check('stable')
  // There is deliberately no host, preparation CLI, or bundled component tree.
  // Reaching download integrity validation proves source preparation was removed.
  await expect(service.download()).rejects.toThrow('Release package integrity check failed')
  const baseline = (await store.active())!
  expect(baseline).toMatchObject({
    executable: options.executable,
    resources: options.resources,
    runtimeRoot: options.runtimeRoot,
    componentDataDirectory: options.dataDirectory,
    profileRoot: await realpath(profile),
  })
  expect(
    JSON.parse(await readFile(join(store.slot(baseline.id), 'prepared.json'), 'utf8'))
  ).toEqual({ components })
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('.tar.gz'))).toHaveLength(1)
  expect(shutdown).not.toHaveBeenCalled()
  expect(await readFile(join(profile, 'package.json'), 'utf8')).toContain('running-profile')
})

test('registers the actual manually installed version and retains its live profile owner', async () => {
  const { options, store } = await fixture()
  const source = (await store.active())!
  source.profileRoot = join(store.slot(source.id), 'profile')
  await store.save(source)
  await atomicReleaseWrite(join(store.root, 'previousHealthy'), source.id)
  await mkdir(source.profileRoot, { recursive: true })
  await writeFile(join(source.profileRoot, 'keep.json'), '{"task":"keep"}')
  const profile = currentCoreProfile(options.dataDirectory)
  await mkdir(join(profile, '..'), { recursive: true })
  await symlink(source.profileRoot, profile, 'junction')
  const service = new AppUpdateService({
    ...options,
    currentVersion: '1.1.0',
    runningComponents: () => ({ executor: '/actual/executor' }) as ComponentPaths,
  })
  const register = () =>
    (
      service as unknown as {
        registerInstalledRelease(): Promise<void>
      }
    ).registerInstalledRelease()
  await register()
  const installed = (await store.active())!
  expect(installed).toMatchObject({
    version: '1.1.0',
    retainedRelease: source.id,
    profileRoot: await realpath(source.profileRoot),
  })
  expect(installed.id).toMatch(/^installed-1\.1\.0-/)
  expect(await service.previousRelease()).toBeNull()
  await register()
  expect((await store.active())?.id).toBe(installed.id)
  await store.prune()
  expect(await readFile(join(profile, 'keep.json'), 'utf8')).toBe('{"task":"keep"}')
})

test('does not offer a stale rollback belonging to a different installed version', async () => {
  const { options, store } = await fixture()
  const source = (await store.active())!
  await store.save({ ...source, id: 'old', version: '0.9.0' })
  await atomicReleaseWrite(join(store.root, 'previousHealthy'), 'old')
  const service = new AppUpdateService({ ...options, currentVersion: '1.1.0' })
  expect(await service.previousRelease()).toBeNull()
})

test.each(['replaced', 'missing-components', 'activation', 'different-path'] as const)(
  'reconciles a Windows installation before startup readiness: %s',
  async mode => {
    const { options, store, fetch } = await fixture()
    const source = { ...(await store.active())!, id: 'installed-source' }
    await store.save(source)
    await atomicReleaseWrite(join(store.root, 'active'), source.id)
    await atomicReleaseWrite(join(store.root, 'previousHealthy'), 'source')
    const profile = currentCoreProfile(options.dataDirectory)
    await mkdir(profile, { recursive: true })
    await writeFile(join(profile, 'task.json'), '{"task":"keep"}')
    if (mode === 'activation') {
      const target = { ...source, id: 'installed-target' }
      await store.save(target)
      await store.activate(target, 'snapshot')
    }
    const before = await store.active()
    const service = new AppUpdateService({
      ...options,
      currentVersion: '1.1.0',
      executable:
        mode === 'different-path' ? join(options.dataDirectory, 'other/host') : options.executable,
    })
    const components = { executor: join(options.dataDirectory, 'new/executor') } as ComponentPaths
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' })
    try {
      if (mode === 'missing-components') {
        await expect(service.reconcileInstalledRelease(null)).rejects.toThrow(
          'The running release component composition is unavailable'
        )
        expect(await store.active()).toEqual(before)
      } else if (mode === 'replaced') {
        const installed = await service.reconcileInstalledRelease(components)
        expect(installed).toMatchObject({
          version: '1.1.0',
          executable: options.executable,
          retainedRelease: source.id,
          profileRoot: await realpath(profile),
        })
        expect(await store.active()).toEqual(installed)
        expect(await readFile(join(store.root, 'bridge'), 'utf8')).toBe(options.executable)
        expect(await service.previousRelease()).toBeNull()
        expect(
          JSON.parse(await readFile(join(store.slot(installed!.id), 'prepared.json'), 'utf8'))
        ).toEqual({ components })
        expect(await service.reconcileInstalledRelease(components)).toBeNull()
        expect(await store.active()).toEqual(installed)
      } else {
        expect(await service.reconcileInstalledRelease(components)).toBeNull()
        expect(await store.active()).toEqual(before)
      }
      expect(fetch).not.toHaveBeenCalled()
      expect(await readFile(join(profile, 'task.json'), 'utf8')).toBe('{"task":"keep"}')
    } finally {
      Object.defineProperty(process, 'platform', platform)
    }
  }
)

test('waits for running component readiness before inspecting the profile or downloading', async () => {
  const { options, store, fetch } = await fixture()
  await rm(join(store.root, 'active'))
  const ready = Promise.withResolvers<ComponentPaths>()
  const runningComponents = vi.fn(() => ready.promise)
  const service = new AppUpdateService({ ...options, runningComponents })
  await service.check('stable')
  const downloading = service.download()
  await vi.waitFor(() => expect(runningComponents).toHaveBeenCalledOnce())
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('.tar.gz'))).toHaveLength(0)
  const profile = currentCoreProfile(options.dataDirectory)
  await mkdir(profile, { recursive: true })
  await writeFile(join(profile, 'package.json'), '{}')
  ready.resolve({ executor: '/running/executor' } as ComponentPaths)
  await expect(downloading).rejects.toThrow('Release package integrity check failed')
})

test('preserves component startup errors without registering an unusable baseline', async () => {
  const { options, store } = await fixture()
  await rm(join(store.root, 'active'))
  const error = new Error('Packaged executor is incompatible')
  const service = new AppUpdateService({
    ...options,
    runningComponents: async () => {
      throw error
    },
  })
  await service.check('stable')
  await expect(service.download()).rejects.toBe(error)
  expect(await store.active()).toBeNull()
})

test.each([false, true])(
  'rollback retains its transaction until bootstrap (restore=%s)',
  async restoreRequired => {
    const { service, store, shutdown, restart } = await fixture()
    const current = (await store.active())!
    const previous = {
      ...current,
      id: 'previous',
      version: '0.9.0',
      readableDataSchemas: restoreRequired ? [2] : current.readableDataSchemas,
    }
    await store.save(previous)
    await atomicReleaseWrite(join(store.root, 'active'), previous.id)
    await store.activate(current, 'snapshot')
    await store.confirm(current.id)
    await expect(service.createRollbackAction(restoreRequired)()).resolves.toBeUndefined()
    expect((await store.active())?.id).toBe(current.id)
    expect(await store.activation()).toMatchObject({
      from: previous.id,
      to: current.id,
      rollbackRequested: true,
      restoreRequired,
    })
    expect(shutdown).toHaveBeenCalledOnce()
    expect(restart).toHaveBeenCalledOnce()
  }
)
test('rollback cannot restore incompatible data without an explicit boolean confirmation', async () => {
  const { service, store } = await fixture()
  const previous = {
    ...(await store.read('source')),
    id: 'previous',
    version: '0.9.0',
    readableDataSchemas: [2],
  }
  await store.save(previous)
  await atomicReleaseWrite(join(store.root, 'previousHealthy'), 'previous')
  await expect(service.createRollbackAction(false)()).rejects.toThrow('requires confirmation')
})

test.each(['delayed download', 'failed retry'])(
  '%s refreshes the verified target and release notes',
  async mode => {
    const { service, catalog, fetch } = await fixture()
    await service.check('stable')
    if (mode === 'failed retry')
      await expect(service.download('stable')).rejects.toThrow('integrity')
    fetch.mockClear()
    const target = publishNextTarget(catalog)

    await expect(service.download('stable')).rejects.toThrow('integrity')

    expect(
      fetch.mock.calls.filter(([url]) => String(url).endsWith('.tar.gz')).map(([url]) => url)
    ).toEqual([target.url])
    expect(service.downloadProgress()).toMatchObject({
      phase: 'failed',
      update: { version: target.version, body: target.notes, path: [target.version] },
    })
  }
)

test('refresh failure never falls back to the previously checked package', async () => {
  const { service, fetch } = await fixture()
  await service.check('stable')
  fetch.mockClear().mockRejectedValueOnce(new Error('Catalog offline'))

  await expect(service.download('stable')).rejects.toThrow('Catalog offline')

  expect(fetch).toHaveBeenCalledOnce()
  expect(service.downloadProgress()).toMatchObject({
    phase: 'failed',
    failure: { message: 'Catalog offline' },
  })
})

test('withdrawn targets clear the old offer without downloading an obsolete package', async () => {
  const { service, catalog, fetch } = await fixture()
  await service.check('stable')
  catalog.releases = catalog.releases.slice(0, 1)
  catalog.edges = []
  fetch.mockClear()

  await service.download('stable')

  expect(fetch).toHaveBeenCalledOnce()
  expect(service.downloadProgress()).toMatchObject({ phase: 'upToDate', update: null })
  expect(() => service.createInstallAction('1.1.0')).toThrow('not ready')
})

test('revoked paths remain errors and are never treated as permission to download an old target', async () => {
  const { service, catalog, fetch } = await fixture()
  await service.check('stable')
  catalog.edges[0].revoked = true
  fetch.mockClear()

  await expect(service.download('stable')).rejects.toMatchObject({
    code: 'UPGRADE_PATH_UNAVAILABLE',
  })

  expect(fetch).toHaveBeenCalledOnce()
  expect(service.downloadProgress()).toMatchObject({
    phase: 'failed',
    failure: { code: 'UPGRADE_PATH_UNAVAILABLE' },
  })
})

test('downloads wait for an earlier check and coalesce checks around the refreshed target', async () => {
  const { service, catalog, fetch } = await fixture()
  const held = Promise.withResolvers<Response>()
  fetch.mockReturnValueOnce(held.promise)
  const checking = service.check('stable')
  const results = Promise.allSettled([service.download('stable'), service.download('stable')])
  const observed = service.check('stable')
  expect(fetch).toHaveBeenCalledOnce()
  held.resolve(new Response(JSON.stringify({ upgradePolicy: catalog })))
  await checking
  publishNextTarget(catalog)

  expect(await observed).toMatchObject({ version: '1.2.0' })
  expect((await results).every(result => result.status === 'rejected')).toBe(true)
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('.tar.gz'))).toHaveLength(1)
  expect(service.downloadProgress().update?.version).toBe('1.2.0')
})

test('serializes checks for different channels instead of allowing a late result to overwrite the target', async () => {
  const { service, catalog, fetch } = await fixture()
  const held = Promise.withResolvers<Response>()
  const stable = JSON.stringify({ upgradePolicy: catalog })
  fetch.mockReturnValueOnce(held.promise)
  const first = service.check('stable')
  catalog.channel = 'beta'
  publishNextTarget(catalog)
  const second = service.check('beta')
  expect(fetch).toHaveBeenCalledOnce()
  held.resolve(new Response(stable))

  expect(await first).toMatchObject({ version: '1.1.0' })
  expect(await second).toMatchObject({ version: '1.2.0' })
  expect(fetch).toHaveBeenCalledTimes(2)
})

test('reuses a ready package without another catalog or archive request', async () => {
  const { service, fetch, preparation } = await readyFixture()
  const ready = service.downloadProgress()
  fetch.mockClear()

  await Promise.all([service.download('stable'), service.download('stable')])

  expect(service.downloadProgress()).toEqual(ready)
  expect(fetch).not.toHaveBeenCalled()
  expect(preparation).toHaveBeenCalledOnce()
})

test('reusing a prepared package binds the newly confirmed channel without downloading again', async () => {
  const { service, store, catalog, fetch, preparation, shutdown } = await readyFixture()
  await atomicReleaseWrite(
    join(store.root, 'update-rollback-history.json'),
    JSON.stringify([{ token: 'failed-attempt', version: '1.1.0', reason: 'startup-failed' }])
  )
  const stable = await service.check('stable')
  expect(stable?.readyToInstall).toBe(false)
  await service.download('stable', stable!.retryConfirmation!.token)
  expect(service.downloadProgress().update?.readyToInstall).toBe(true)
  catalog.channel = 'beta'
  const beta = await service.check('beta')
  expect(beta?.readyToInstall).toBe(false)
  expect(beta!.retryConfirmation!.token).not.toBe(stable!.retryConfirmation!.token)
  await expect(service.download('beta', stable!.retryConfirmation!.token)).rejects.toMatchObject({
    code: 'UPDATE_RETRY_CONFIRMATION_REQUIRED',
  })
  fetch.mockClear()
  await service.download('beta', beta!.retryConfirmation!.token)
  expect(service.downloadProgress().update?.readyToInstall).toBe(true)
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('.tar.gz'))).toHaveLength(0)
  expect(preparation).toHaveBeenCalledOnce()
  shutdown.mockRejectedValueOnce(new Error('Reached shutdown after current retry consent'))
  await expect(service.createInstallAction('1.1.0')()).rejects.toThrow('Reached shutdown')
  expect(shutdown).toHaveBeenCalledOnce()
})

test('revalidates the requested channel after an earlier check changes the prepared offer', async () => {
  const { service, catalog, fetch, preparation } = await readyFixture()
  catalog.releases[1].notes = 'Stable offer'
  const stable = JSON.stringify({ upgradePolicy: catalog })
  const held = Promise.withResolvers<Response>()
  fetch.mockClear().mockReturnValueOnce(held.promise)
  const checking = service.check('beta')
  const downloading = service.download('stable')
  catalog.channel = 'beta'
  catalog.releases[1].notes = 'Beta offer'
  fetch.mockResolvedValue(new Response(stable))
  held.resolve(new Response(JSON.stringify({ upgradePolicy: catalog })))

  expect(await checking).toMatchObject({ body: 'Beta offer' })
  await downloading

  expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
    expect.stringContaining('/components-beta-'),
    expect.stringContaining('/components-stable-'),
  ])
  expect(service.downloadProgress()).toMatchObject({
    phase: 'ready',
    update: { body: 'Stable offer' },
  })
  expect(preparation).toHaveBeenCalledOnce()
})

test('rejects an obsolete installation version and revalidates a deferred installation', async () => {
  const { service, catalog, shutdown } = await readyFixture()
  expect(() => service.createInstallAction('1.2.0')).toThrow('not ready')
  const install = service.createInstallAction('1.1.0')
  publishNextTarget(catalog)
  await service.check('stable')

  expect(install).toThrow('not ready')
  expect(shutdown).not.toHaveBeenCalled()
})

test('an installation cannot start while a check may change its prepared target', async () => {
  const { service, fetch } = await readyFixture()
  const held = Promise.withResolvers<Response>()
  fetch.mockReturnValueOnce(held.promise)
  const checked = service.check('stable')

  expect(() => service.createInstallAction('1.1.0')).toThrow('not ready')
  held.reject(new Error('Catalog offline'))
  await expect(checked).rejects.toThrow('Catalog offline')
})

test('invalidates a prepared package when its declared source identity changes', async () => {
  const { service, catalog } = await readyFixture()
  expect(await service.check('stable')).toMatchObject({ readyToInstall: true })
  catalog.releases[1].sourceSha = 'd'.repeat(40)
  catalog.edges[0].toSourceSha = catalog.releases[1].sourceSha

  expect(await service.check('stable')).toMatchObject({ readyToInstall: false })

  expect(service.downloadProgress().phase).not.toBe('ready')
  expect(() => service.createInstallAction('1.1.0')).toThrow('not ready')
})

test('checking clears readiness after the prepared plugin profile changes', async () => {
  const { service, options, fetch, preparation } = await readyFixture()
  await writeFile(
    join(currentCoreProfile(options.dataDirectory), 'package.json'),
    '{"name":"changed-profile"}'
  )

  expect(await service.check('stable')).toMatchObject({ readyToInstall: false })
  expect(service.downloadProgress().phase).not.toBe('ready')
  expect(() => service.createInstallAction('1.1.0')).toThrow('not ready')
  fetch.mockClear()
  await service.download('stable')
  expect(preparation).toHaveBeenCalledTimes(2)
  expect(fetch.mock.calls.filter(([url]) => String(url).endsWith('.tar.gz'))).toHaveLength(0)
  expect(service.downloadProgress().phase).toBe('ready')
})

test('installation revalidation rejects changed source identity before shutdown', async () => {
  const { service, catalog, shutdown } = await readyFixture()
  const install = service.createInstallAction('1.1.0')
  catalog.releases[1].sourceSha = 'd'.repeat(40)
  catalog.edges[0].toSourceSha = catalog.releases[1].sourceSha

  await expect(install()).rejects.toThrow('revoked or changed')

  expect(shutdown).not.toHaveBeenCalled()
})

test('a newer safe offer cannot bypass changed retry consent for the prepared package', async () => {
  const { service, store, catalog, shutdown } = await readyFixture()
  const record = { token: 'first', version: '1.1.0', reason: 'startup-failed' }
  await atomicReleaseWrite(
    join(store.root, 'update-rollback-history.json'),
    JSON.stringify([record])
  )
  const offer = await service.check('stable')
  await service.download('stable', offer!.retryConfirmation!.token)
  publishNextTarget(catalog)
  await atomicReleaseWrite(
    join(store.root, 'update-rollback-history.json'),
    JSON.stringify([{ ...record, token: 'second' }])
  )
  await expect(service.createInstallAction('1.1.0')()).rejects.toThrow('retry confirmation changed')
  expect(shutdown).not.toHaveBeenCalled()
})

test('an unrelated failed newer offer cannot block installation of the prepared package', async () => {
  const { service, store, catalog, shutdown } = await readyFixture()
  publishNextTarget(catalog)
  await atomicReleaseWrite(
    join(store.root, 'update-rollback-history.json'),
    JSON.stringify([{ token: 'unrelated', version: '1.2.0', reason: 'startup-failed' }])
  )
  shutdown.mockRejectedValueOnce(new Error('Reached shutdown for the selected package'))
  await expect(service.createInstallAction('1.1.0')()).rejects.toThrow('Reached shutdown')
  expect(shutdown).toHaveBeenCalledOnce()
})

test('duplicate readable schemas cannot hide a changed package compatibility declaration', async () => {
  const { service, catalog } = await readyFixture([1, 1])
  catalog.releases[1].readableDataSchemas = [1, 2]

  await service.check('stable')

  expect(() => service.createInstallAction('1.1.0')).toThrow('not ready')
})

test('locks the selected target throughout installation and shutdown', async () => {
  const { service, shutdown, restart } = await readyFixture()
  const stopped = Promise.withResolvers<void>()
  shutdown.mockReturnValueOnce(stopped.promise)
  const install = service.createInstallAction('1.1.0')()
  const rejected = expect(install).rejects.toThrow('Shutdown interrupted')
  await vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce())

  await expect(service.download('stable')).rejects.toThrow('operation is in progress')
  await expect(service.check('stable')).rejects.toThrow('operation is in progress')
  expect(() => service.createInstallAction('1.1.0')).toThrow('operation is in progress')
  stopped.reject(new Error('Shutdown interrupted'))
  await rejected
  expect(restart).not.toHaveBeenCalled()
  // Once shutdown starts the runtime may be partially stopped; keep the target locked.
  await expect(service.check('stable')).rejects.toThrow('operation is in progress')
})
