import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import {
  completeExecutorSnapshot,
  restoreReleaseData,
  snapshotReleaseData,
} from './release-snapshot.js'

const roots: string[] = []
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'wework-snapshot-test-'))
  roots.push(root)
  const data = join(root, 'desktop')
  const executor = join(root, 'executor')
  const releases = join(data, 'releases')
  await mkdir(join(executor, 'data'), { recursive: true })
  await mkdir(data, { recursive: true })
  await writeFile(join(executor, 'data/tasks.sqlite'), 'before')
  await writeFile(join(data, 'app-preferences.json'), 'before')
  await writeFile(join(data, 'secure-values.json'), 'private')
  return { root, data, executor, releases }
}
test('restores managed data and preserves newer data without touching credentials', async () => {
  const { data, executor, releases } = await fixture()
  const snapshot = await snapshotReleaseData(data, releases, executor)
  await writeFile(join(executor, 'data/tasks.sqlite'), 'newer')
  await writeFile(join(data, 'app-preferences.json'), 'newer')
  await writeFile(join(data, 'secure-values.json'), 'new credential')
  await restoreReleaseData(data, releases, snapshot, executor)
  expect(await readFile(join(executor, 'data/tasks.sqlite'), 'utf8')).toBe('before')
  expect(
    await readFile(join(releases, 'preserved-data', snapshot, 'data/tasks.sqlite'), 'utf8')
  ).toBe('newer')
  expect(await readFile(join(data, 'secure-values.json'), 'utf8')).toBe('new credential')
  await restoreReleaseData(data, releases, snapshot, executor)
  expect(
    await readFile(join(releases, 'preserved-data', snapshot, 'data/tasks.sqlite'), 'utf8')
  ).toBe('newer')
})
test('completes a legacy bridge snapshot from the default Executor Home before writes', async () => {
  const { data, executor, releases } = await fixture()
  const id = await snapshotReleaseData(data, releases)
  await writeFile(
    join(releases, 'snapshots', id, 'snapshot.json'),
    JSON.stringify({ schemaVersion: 1, entries: ['app-preferences.json'] })
  )
  await completeExecutorSnapshot(releases, id, executor)
  await writeFile(join(executor, 'data/tasks.sqlite'), 'newer')
  await completeExecutorSnapshot(releases, id, executor)
  await restoreReleaseData(data, releases, id, executor)
  expect(await readFile(join(executor, 'data/tasks.sqlite'), 'utf8')).toBe('before')
  expect(await readFile(join(releases, 'preserved-data', id, 'data/tasks.sqlite'), 'utf8')).toBe(
    'newer'
  )
})
test('refuses snapshots that would traverse a user repository', async () => {
  const { root, data, executor, releases } = await fixture()
  const external = join(root, 'repository')
  await mkdir(external)
  await rm(join(executor, 'data/tasks.sqlite'))
  await symlink(
    external,
    join(executor, 'data/tasks.sqlite'),
    process.platform === 'win32' ? 'junction' : 'dir'
  )
  await expect(snapshotReleaseData(data, releases, executor)).rejects.toThrow(
    /outside|physically owned/
  )
})
