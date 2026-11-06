import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, toNamespacedPath } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { atomicReleaseWrite, ReleaseStore, type DesktopRelease } from './release-store.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wework-cleanup-test-'))
  roots.push(root)
  const store = new ReleaseStore(join(root, 'releases'))
  const release = (id: string): DesktopRelease => ({
    schemaVersion: 1,
    id,
    version: '1.1.0',
    executable: join(root, 'installed', 'host'),
    resources: join(root, 'installed', 'resources'),
    runtimeRoot: join(root, 'runtimes'),
    profileRoot: join(root, 'profile'),
    dataSchema: 1,
    readableDataSchemas: [1],
  })
  const current = release('current')
  await mkdir(current.profileRoot, { recursive: true })
  await writeFile(join(current.profileRoot, 'package.json'), '{}')
  for (const id of ['current', 'owner', 'unused']) await store.save(release(id))
  await atomicReleaseWrite(join(store.root, 'active'), current.id)
  return { root, store, current, release }
}

async function link(target: string, path: string): Promise<void> {
  await symlink(target, path, process.platform === 'win32' ? 'junction' : 'dir')
}

test.each([
  'profileRoot',
  'runtimeRoot',
  'resources',
  'executable',
  'componentDataDirectory',
] as const)('cleanup preserves the slot owning a surviving %s reference', async field => {
  const { store, current } = await fixture()
  const owned = join(store.slot('owner'), 'data')
  await mkdir(owned)
  await writeFile(join(owned, 'keep'), 'live data')
  await writeFile(join(owned, 'package.json'), '{}')
  await store.save({ ...current, [field]: owned })

  expect(await store.prune()).toEqual({ status: 'completed' })

  expect(await readFile(join(owned, 'keep'), 'utf8')).toBe('live data')
  await expect(store.read('unused')).rejects.toMatchObject({ code: 'ENOENT' })
})

test('cleanup recognizes a component owner at the slot root', async () => {
  const { store, current } = await fixture()
  await store.save({ ...current, componentDataDirectory: store.slot('owner') })

  expect(await store.prune()).toEqual({ status: 'completed' })

  expect((await store.read('owner')).id).toBe('owner')
  await expect(store.read('unused')).rejects.toMatchObject({ code: 'ENOENT' })
})

test('cleanup recognizes native namespaced paths for a component owner', async () => {
  const { store, current } = await fixture()
  await store.save({ ...current, componentDataDirectory: toNamespacedPath(store.slot('owner')) })

  expect(await store.prune()).toEqual({ status: 'completed' })

  expect((await store.read('owner')).id).toBe('owner')
  await expect(store.read('unused')).rejects.toMatchObject({ code: 'ENOENT' })
})

test('cleanup traverses shared and cyclic dependencies and expires them when unreferenced', async () => {
  const { store, current, release } = await fixture()
  await store.save({ ...release('owner'), runtimeRoot: join(store.slot('dependency'), 'runtimes') })
  await store.save({ ...release('dependency'), retainedRelease: 'owner' })
  await store.save({ ...current, profileRoot: join(store.slot('owner'), 'profile') })
  await mkdir(join(store.slot('owner'), 'profile'))
  await writeFile(join(store.slot('owner'), 'profile', 'package.json'), '{}')

  expect(await store.prune()).toEqual({ status: 'completed' })
  expect((await store.read('dependency')).id).toBe('dependency')

  await store.save(current)
  expect(await store.prune()).toEqual({ status: 'completed' })
  await expect(store.read('owner')).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(store.read('dependency')).rejects.toMatchObject({ code: 'ENOENT' })
})

test('cleanup resolves a store alias and a profile alias to their physical owner', async () => {
  const { root, store, current } = await fixture()
  const profile = join(store.slot('owner'), 'profile')
  await mkdir(profile)
  await writeFile(join(profile, 'package.json'), '{"preserved":true}')
  const profileAlias = join(root, 'live-profile')
  await link(profile, profileAlias)
  await store.save({ ...current, profileRoot: profileAlias })
  const storeAlias = join(root, 'release-alias')
  await link(store.root, storeAlias)

  expect(await new ReleaseStore(storeAlias).prune()).toEqual({ status: 'completed' })

  expect(await realpath(profileAlias)).toBe(await realpath(profile))
  expect(await readFile(join(profileAlias, 'package.json'), 'utf8')).toContain('preserved')
  await expect(store.read('unused')).rejects.toMatchObject({ code: 'ENOENT' })
})

test('cleanup retains every intermediate profile link owner', async () => {
  const { store, current, release } = await fixture()
  for (const id of ['intermediate', 'physical']) await store.save(release(id))
  const profile = join(store.slot('physical'), 'profile')
  await mkdir(profile)
  await writeFile(join(profile, 'package.json'), '{}')
  await link(profile, join(store.slot('intermediate'), 'profile'))
  await link(join(store.slot('intermediate'), 'profile'), join(store.slot('owner'), 'profile'))
  await store.save({ ...current, profileRoot: join(store.slot('owner'), 'profile') })

  expect(await store.prune()).toEqual({ status: 'completed' })

  for (const id of ['owner', 'intermediate', 'physical']) expect((await store.read(id)).id).toBe(id)
  expect(await readFile(join(store.slot('owner'), 'profile', 'package.json'), 'utf8')).toBe('{}')
})

test.each(['marker', 'preserved-data'] as const)(
  'cleanup retains dependencies of newer data referenced by %s',
  async source => {
    const { store, release } = await fixture()
    await store.save({
      ...release('owner'),
      profileRoot: join(store.slot('dependency'), 'profile'),
    })
    await store.save(release('dependency'))
    if (source === 'marker')
      await atomicReleaseWrite(join(store.slot('owner'), 'preserved-data-snapshot'), 'saved')
    else {
      const preserved = join(store.root, 'preserved-data', 'saved')
      await mkdir(preserved, { recursive: true })
      await atomicReleaseWrite(join(preserved, 'retained-release'), 'owner')
    }
    await mkdir(join(store.root, 'snapshots', 'saved'), { recursive: true })
    await writeFile(join(store.root, 'snapshots', 'saved', 'keep'), 'snapshot')

    expect(await store.prune()).toEqual({ status: 'completed' })

    expect((await store.read('dependency')).id).toBe('dependency')
    expect(await readFile(join(store.root, 'snapshots', 'saved', 'keep'), 'utf8')).toBe('snapshot')
    await expect(store.read('unused')).rejects.toMatchObject({ code: 'ENOENT' })
  }
)

test.each([
  'missing-owner',
  'corrupt-owner',
  'missing-profile',
  'broken-link',
  'corrupt-marker',
  'corrupt-activation',
] as const)('cleanup makes no deletions when ownership is uncertain: %s', async failure => {
  const { store, current } = await fixture()
  const profile = join(store.slot('owner'), 'profile')
  await store.save(
    failure === 'broken-link'
      ? { ...current, componentDataDirectory: profile }
      : { ...current, profileRoot: profile }
  )
  if (failure !== 'broken-link' && failure !== 'missing-profile') {
    await mkdir(profile)
    await writeFile(join(profile, 'package.json'), '{}')
  }
  if (failure === 'missing-owner') await rm(join(store.slot('owner'), 'release.json'))
  if (failure === 'corrupt-owner') await writeFile(join(store.slot('owner'), 'release.json'), '{}')
  if (failure === 'broken-link') await link(join(store.root, 'absent'), profile)
  if (failure === 'corrupt-marker')
    await atomicReleaseWrite(join(store.slot('owner'), 'preserved-data-snapshot'), '{')
  if (failure === 'corrupt-activation')
    await atomicReleaseWrite(join(store.root, 'last-activation.json'), '{}')
  const marker = join(store.slot('unused'), 'preserved-data-snapshot')
  const markerValue = JSON.stringify({
    kind: 'macos-source-owner',
    owner: 'expired',
    snapshot: 'old',
  })
  await atomicReleaseWrite(marker, markerValue)
  const snapshot = join(store.root, 'snapshots', 'obsolete')
  await mkdir(snapshot, { recursive: true })
  await writeFile(join(snapshot, 'keep'), 'must survive')

  expect(await store.prune()).toMatchObject({
    status: 'skipped',
    reason:
      failure === 'broken-link' ? 'Release cleanup encountered a broken link' : expect.any(String),
  })

  expect((await store.read('unused')).id).toBe('unused')
  expect(await readFile(marker, 'utf8')).toBe(markerValue)
  expect(await readFile(join(snapshot, 'keep'), 'utf8')).toBe('must survive')
  expect((await store.active())?.id).toBe('current')
})
