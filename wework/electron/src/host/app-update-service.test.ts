import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { AppUpdateService } from './app-update-service.js'
import { atomicReleaseWrite, ReleaseStore } from '../runtime/release-store.js'
import type { UpgradeCatalog } from '../runtime/upgrade-policy.mjs'

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
