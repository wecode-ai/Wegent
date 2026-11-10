import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { prepareStoppedReleaseData } from './release-after-stop-target.js'
import { atomicReleaseWrite, ReleaseStore, type DesktopRelease } from './release-store.js'

const target = vi.hoisted(() => ({ prepare: vi.fn(), migrate: vi.fn() }))
vi.mock('./component-update-manager.js', () => ({
  ComponentUpdateManager: class {
    prepareStartup = target.prepare
  },
}))
vi.mock('./codex-provider-upgrade.js', () => ({ migrateCodexProviderState: target.migrate }))

const roots: string[] = []
beforeEach(() => {
  target.prepare.mockReset()
  target.migrate.mockReset().mockResolvedValue(undefined)
})
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wework target data hook '))
  roots.push(root)
  const store = new ReleaseStore(join(root, 'releases'))
  const source: DesktopRelease = {
    schemaVersion: 1,
    id: 'source',
    version: '1.0.0',
    executable: join(root, 'source'),
    resources: join(root, 'source-resources'),
    runtimeRoot: join(root, 'runtimes'),
    profileRoot: join(root, 'profile'),
    dataSchema: 1,
    readableDataSchemas: [1],
  }
  const release: DesktopRelease = {
    ...source,
    id: 'target',
    version: '1.1.0',
    resources: join(root, 'target-resources'),
    packageSha256: 'a'.repeat(64),
  }
  await store.save(source)
  await atomicReleaseWrite(join(store.root, 'active'), source.id)
  await store.save(release)
  await store.activate(release, 'snapshot')
  const { token } = (await store.activation())!
  await atomicReleaseWrite(join(store.root, 'data-opened'), token)
  const request = {
    protocol: 1,
    release,
    token,
    storeRoot: store.root,
    dataDirectory: root,
    codexHome: join(root, 'source-codex'),
    workbenchRoot: join(root, 'source-workbench'),
  }
  const requestFile = join(store.slot(release.id), 'after-stop-request.json')
  await writeFile(requestFile, JSON.stringify(request))
  const executor = join(release.resources, 'bin', 'wegent-executor')
  target.prepare.mockResolvedValue({ executor })
  const metadata = { version: release.version, weworkAfterStopPreparation: 1, weworkDataSchema: 1 }
  return { root, store, release, request, requestFile, executor, metadata }
}

test('only the target executor migrates source-owned Homes and completion gates the receipt response', async () => {
  const context = await fixture()
  const { requestFile, release, metadata, executor, request, store } = context
  let finish!: () => void
  target.migrate.mockImplementationOnce(
    () =>
      new Promise<void>(resolve => {
        finish = resolve
      })
  )
  let complete = false
  const preparation = prepareStoppedReleaseData(requestFile, release.resources, metadata).then(
    result => {
      complete = true
      return result
    }
  )
  await vi.waitFor(() => expect(target.migrate).toHaveBeenCalledOnce())
  const [options, signal, waitForWriters] = target.migrate.mock.calls[0]
  expect(options.environment.WEWORK_EXECUTOR_PATH).toBe(executor)
  expect(options.environment.WEGENT_CODEX_HOME).toBe(request.codexHome)
  expect(options.environment.WEGENT_WORKBENCH_HOME).toBe(request.workbenchRoot)
  expect(signal).toBeUndefined()
  expect(waitForWriters).toBe(true)
  expect(complete).toBe(false)
  finish()
  expect(await preparation).toEqual({
    protocol: 1,
    token: request.token,
    releaseId: release.id,
    complete: true,
  })
  await expect(readFile(join(store.root, 'after-stop-ready.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
})

test.each(['attempted', 'wrong-token', 'wrong-package', 'relative-home', 'wrong-runtime'])(
  'rejects %s before touching session data',
  async fault => {
    const { store, request, requestFile, release, metadata } = await fixture()
    if (fault === 'attempted')
      await atomicReleaseWrite(join(store.root, 'attempted'), request.token)
    if (fault === 'wrong-token') request.token = 'another-activation'
    if (fault === 'wrong-package') request.release.packageSha256 = 'b'.repeat(64)
    if (fault === 'relative-home') request.codexHome = 'relative-codex'
    if (fault === 'wrong-runtime') metadata.version = '2.0.0'
    await writeFile(requestFile, JSON.stringify(request))
    await expect(
      prepareStoppedReleaseData(requestFile, release.resources, metadata)
    ).rejects.toThrow(/Stopped-release/)
    expect(target.prepare).not.toHaveBeenCalled()
    expect(target.migrate).not.toHaveBeenCalled()
  }
)

test('migration failure never emits successful completion or deletes the durable activation', async () => {
  const { store, requestFile, release, metadata } = await fixture()
  const activation = await store.activation()
  target.migrate.mockRejectedValueOnce(new Error('native writer unavailable'))
  await expect(prepareStoppedReleaseData(requestFile, release.resources, metadata)).rejects.toThrow(
    'native writer unavailable'
  )
  expect(await store.activation()).toEqual(activation)
  expect((await store.active())?.id).toBe(release.id)
})
