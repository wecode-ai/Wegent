import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
import { recoverReleaseLayout } from './release-layout-recovery.js'
import { releaseBridgeUserData } from './release-handoff.js'
const parentProcess = vi.hoisted(() => ({ executable: vi.fn() }))
vi.mock('./release-parent-process.js', () => ({
  releaseParentExecutable: parentProcess.executable,
}))
import { atomicReleaseWrite, ReleaseStore, type DesktopRelease } from './release-store.js'

const homes: string[] = []
afterEach(async () => {
  for (const home of homes.splice(0)) await rm(home, { recursive: true, force: true })
})

async function fixture() {
  const home = await realpath(await mkdtemp(join(tmpdir(), 'release-layout-')))
  homes.push(home)
  const desktop = join(home, '.wegent/workbench/wework/default')
  const store = new ReleaseStore(join(desktop, 'user-data/releases'))
  const source: DesktopRelease = {
    schemaVersion: 1,
    id: 'installed-source',
    version: '0.6.3',
    executable: join(home, 'installed/host'),
    resources: join(home, 'installed/resources'),
    runtimeRoot: join(home, 'runtime'),
    profileRoot: join(home, 'profile'),
    dataSchema: 1,
    readableDataSchemas: [1],
  }
  const target = { ...source, id: 'unstarted-target', version: '0.6.4-beta.1' }
  await mkdir(join(source.resources, 'app.asar'), { recursive: true })
  await writeFile(source.executable, 'source fixture')
  parentProcess.executable.mockResolvedValue(source.executable)
  await mkdir(source.profileRoot, { recursive: true })
  await mkdir(join(desktop, 'user-data/dsh-core'), { recursive: true })
  await writeFile(join(source.profileRoot, 'live-data'), 'latest source data')
  await writeFile(
    join(source.resources, 'app.asar/package.json'),
    JSON.stringify({ version: source.version })
  )
  await store.save(source)
  await store.save(target)
  await atomicReleaseWrite(join(store.root, 'active'), source.id)
  await store.activate(target, 'before-update')
  return { home, desktop, store, source, target, environment: { HOME: home } }
}

test('target preparation repairs the unstarted shipped-client activation without restoring data', async () => {
  const { desktop, store, source, target, environment } = await fixture()
  const activation = (await store.activation())!
  await recoverReleaseLayout(store, source.profileRoot, source.dataSchema, environment)
  expect(await releaseBridgeUserData(store, source.executable, join(desktop, 'user-data'))).toBe(
    join(desktop, 'user-data')
  )
  expect(await releaseBridgeUserData(store, '/unknown/host', join(desktop, 'user-data'))).toBeNull()

  expect(await realpath(join(desktop, 'releases'))).toBe(await realpath(store.root))
  expect((await store.active())?.id).toBe(source.id)
  expect(await store.activation()).toBeNull()
  expect(
    JSON.parse(await readFile(join(store.root, 'recovery', `${activation.token}.json`), 'utf8'))
  ).toEqual(activation)
  expect(JSON.parse(await readFile(join(store.root, 'rolled-back-versions.json'), 'utf8'))).toEqual(
    [target.version]
  )
  expect(await readFile(join(source.profileRoot, 'live-data'), 'utf8')).toBe('latest source data')
  // Repeating preparation reuses the same bridge and does not change source data.
  await recoverReleaseLayout(store, source.profileRoot, source.dataSchema, environment)
})

test.each(['attempted', 'data-opened', 'healthy', 'failed'])(
  'never cancels an activation with a matching %s marker',
  async marker => {
    const { store, source, target, environment } = await fixture()
    const activation = (await store.activation())!
    await atomicReleaseWrite(join(store.root, marker), activation.token)

    await expect(
      recoverReleaseLayout(store, source.profileRoot, source.dataSchema, environment)
    ).rejects.toThrow('supervised recovery')
    expect(await store.activation()).toEqual(activation)
    expect((await store.active())?.id).toBe(target.id)
    expect(await readFile(join(source.profileRoot, 'live-data'), 'utf8')).toBe('latest source data')
  }
)

test('never touches an explicit userData override', async () => {
  const { store, source, environment } = await fixture()
  const activation = await store.activation()
  await recoverReleaseLayout(store, source.profileRoot, source.dataSchema, {
    ...environment,
    WEWORK_USER_DATA_DIR: '/isolated',
  })
  expect(await store.activation()).toEqual(activation)
})

test('requires a compatible repair before a legacy source can migrate data', async () => {
  const { store, source, environment } = await fixture()
  const activation = await store.activation()
  await expect(recoverReleaseLayout(store, source.profileRoot, 2, environment)).rejects.toThrow(
    'before upgrading the data schema'
  )
  expect(await store.activation()).toEqual(activation)
})

test('never cancels a transaction on behalf of a different running host', async () => {
  const { store, source, environment } = await fixture()
  const activation = await store.activation()
  parentProcess.executable.mockResolvedValue('/different/host')
  await expect(
    recoverReleaseLayout(store, source.profileRoot, source.dataSchema, environment)
  ).rejects.toThrow('running update host')
  expect(await store.activation()).toEqual(activation)
})

test('resumes a journaled cancellation interrupted after returning to the source', async () => {
  const { store, source, environment } = await fixture()
  const activation = (await store.activation())!
  await mkdir(join(store.root, 'recovery'), { recursive: true })
  await atomicReleaseWrite(
    join(store.root, 'recovery', `${activation.token}.json`),
    JSON.stringify(activation)
  )
  await atomicReleaseWrite(join(store.root, 'active'), source.id)
  await rm(join(store.root, 'trial'))

  await recoverReleaseLayout(store, source.profileRoot, source.dataSchema, environment)

  expect(await store.activation()).toBeNull()
  expect((await store.active())?.id).toBe(source.id)
  expect(await readFile(join(source.profileRoot, 'live-data'), 'utf8')).toBe('latest source data')
})

test('rejects a different source profile and a conflicting legacy directory', async () => {
  const { home, desktop, store, source, environment } = await fixture()
  const other = join(home, 'other')
  await mkdir(other)
  await expect(recoverReleaseLayout(store, other, source.dataSchema, environment)).rejects.toThrow(
    'source profile'
  )
  await mkdir(join(desktop, 'releases'))
  await expect(
    recoverReleaseLayout(store, source.profileRoot, source.dataSchema, environment)
  ).rejects.toThrow('conflicts')
  expect(await store.activation()).not.toBeNull()
})
