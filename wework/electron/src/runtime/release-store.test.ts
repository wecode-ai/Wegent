import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  atomicReleaseWrite,
  optionalText,
  ReleaseStore,
  type DesktopRelease,
} from './release-store.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wework-release-test-'))
  roots.push(root)
  const store = new ReleaseStore(root)
  const release = (id: string, schema: number): DesktopRelease => ({
    schemaVersion: 1,
    id,
    version: `1.${schema}.0`,
    executable: join(root, id, 'host'),
    resources: join(root, id, 'resources'),
    runtimeRoot: join(root, id, 'runtimes'),
    profileRoot: join(root, id, 'profile'),
    dataSchema: schema,
    readableDataSchemas: [schema],
  })
  const before = release('before', 1)
  const after = release('after', 2)
  await store.save(before)
  await store.save(after)
  await atomicReleaseWrite(join(root, 'active'), before.id)
  return { store, before, after, root }
}
test('activation retains its source until runtime and renderer confirmation', async () => {
  const { store, before, after, root } = await fixture()
  await store.activate(after, 'snapshot')
  expect(await store.activation()).toMatchObject({
    from: 'before',
    to: 'after',
    restoreRequired: true,
  })
  await store.confirm('before')
  expect(await store.activation()).not.toBeNull()
  await store.confirm('after')
  expect(await readFile(join(root, 'bridge'), 'utf8')).toBe(after.executable)
  expect(await store.activation()).toBeNull()
  expect(await readFile(join(root, 'previousHealthy'), 'utf8')).toBe('before')
  await store.requestRollback()
  expect((await store.rollback()).id).toBe('before')
  expect((await store.active())?.id).toBe('before')
  expect(await readFile(join(root, 'bridge'), 'utf8')).toBe(before.executable)
})
test('concurrent activation cannot overwrite the recovery journal', async () => {
  const { store, after } = await fixture()
  await store.activate(after, 'snapshot')
  await expect(store.activate(after, 'other')).rejects.toThrow('already in progress')
  expect((await store.activation())?.snapshot).toBe('snapshot')
})
test('separate controllers cannot concurrently replace the same activation journal', async () => {
  const { store, after, root } = await fixture()
  const other = new ReleaseStore(root)
  const results = await Promise.allSettled([
    store.activate(after, 'first'),
    other.activate(after, 'second'),
  ])
  expect(results.map(result => result.status)).toEqual(['fulfilled', 'rejected'])
  expect((await store.activation())?.snapshot).toBe('first')
})
test('an interrupted manual rollback retains its intent despite an earlier healthy marker', async () => {
  const { store, after, root } = await fixture()
  await store.activate(after, 'snapshot')
  const token = (await store.activation())!.token
  await atomicReleaseWrite(join(root, 'attempted'), token)
  await store.confirm(after.id)
  await store.requestRollback()
  const reopened = new ReleaseStore(root)
  expect(await optionalText(join(root, 'healthy'))).toBe(token)
  expect(await reopened.activation()).toMatchObject({
    rollbackRequested: true,
    restoreRequired: true,
    from: 'before',
    to: 'after',
  })
  expect((await reopened.rollback()).id).toBe('before')
  await expect(readFile(join(root, 'previousHealthy'))).rejects.toMatchObject({ code: 'ENOENT' })
})
test('an interrupted pointer switch still has a usable source descriptor', async () => {
  const { store, after, root } = await fixture()
  await store.activate(after, 'snapshot')
  await writeFile(join(root, 'active'), 'before')
  expect((await store.rollback()).id).toBe('before')
  expect(await store.activation()).toBeNull()
})
test('rejects path traversal and corrupt release metadata', async () => {
  const { store, root } = await fixture()
  expect(() => store.slot('../outside')).toThrow('identifier')
  await writeFile(join(root, 'slots/before/release.json'), '{}')
  await expect(store.read('before')).rejects.toThrow('descriptor')
})
test('cleanup retains the active and previous healthy release', async () => {
  const { store, before, after, root } = await fixture()
  const unused = { ...before, id: 'abandoned' }
  await store.save(unused)
  await store.activate(after, 'snapshot')
  await store.confirm(after.id)
  await store.prune()
  expect((await store.read(before.id)).id).toBe(before.id)
  expect((await store.read(after.id)).id).toBe(after.id)
  await expect(readFile(join(root, 'slots/abandoned/release.json'))).rejects.toMatchObject({
    code: 'ENOENT',
  })
})
test('cleanup preserves newer plugin data after an incompatible rollback', async () => {
  const { store, after } = await fixture()
  const release = { ...after, profileRoot: join(store.slot(after.id), 'profile') }
  await store.save(release)
  await mkdir(release.profileRoot)
  const state = join(release.profileRoot, '.wework-core-plugins.json')
  await writeFile(state, '{"disabled":["new-user-plugin"]}')
  await store.activate(release, 'snapshot')
  await atomicReleaseWrite(join(store.root, 'data-opened'), (await store.activation())!.token)
  await store.confirm(release.id)
  await store.requestRollback()
  await store.rollback()
  await store.prune()
  expect(await readFile(state, 'utf8')).toContain('new-user-plugin')
  expect(await readFile(join(store.root, 'preserved-data/snapshot/retained-release'), 'utf8')).toBe(
    release.id
  )
})
