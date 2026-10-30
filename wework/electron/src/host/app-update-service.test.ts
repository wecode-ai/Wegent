import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { AppUpdateService } from './app-update-service.js'
import { atomicReleaseWrite, ReleaseStore } from '../runtime/release-store.js'
import type { UpgradeCatalog } from '../runtime/upgrade-policy.mjs'
import type { ComponentPaths } from '../runtime/component-update-manager.js'
import { currentCoreProfile } from '../runtime/release-profile.js'

const roots: string[] = []
afterEach(async () => {
  for (const path of roots.splice(0)) await rm(path, { recursive: true, force: true })
})
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'wework-updater-test-'))
  roots.push(directory)
  const store = new ReleaseStore(join(directory, 'releases'))
  await store.save({
    schemaVersion: 1,
    id: 'source',
    version: '1.0.0',
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
    currentVersion: '1.0.0',
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
test('a rolled-back target is not automatically offered again', async () => {
  const { service, store } = await fixture()
  await atomicReleaseWrite(join(store.root, 'rolled-back-versions.json'), JSON.stringify(['1.1.0']))
  await expect(service.check('stable')).rejects.toMatchObject({ code: 'UPGRADE_PATH_UNAVAILABLE' })
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

test('compatible rollback selects the retained version without preparing its host', async () => {
  const { service, store, shutdown, restart } = await fixture()
  const current = (await store.active())!
  const previous = { ...current, id: 'previous', version: '0.9.0' }
  await store.save(previous)
  await atomicReleaseWrite(join(store.root, 'active'), previous.id)
  await store.activate(current, 'snapshot')
  await store.confirm(current.id)
  await expect(service.createRollbackAction(false)()).resolves.toBeUndefined()
  expect((await store.active())?.id).toBe(previous.id)
  expect(shutdown).toHaveBeenCalledOnce()
  expect(restart).toHaveBeenCalledOnce()
})
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
