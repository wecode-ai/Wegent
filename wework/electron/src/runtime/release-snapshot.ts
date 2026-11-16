import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { atomicReleaseWrite, releaseId } from './release-store.js'

// Add new migration-owned stores here alongside their upgrade/restore E2E fixture.
// Authentication, repositories, agent Homes and cloud records are deliberately absent.
export const RELEASE_SNAPSHOT_ENTRIES = [
  'data/tasks.sqlite',
  'data/tasks.sqlite-wal',
  'data/tasks.sqlite-shm',
  'app-preferences.json',
  'renderer-local-storage.json',
  'renderer-local-storage-origins.json',
  'dsh-core/wework-transcript-sync.json',
  'dsh-core/wework-transcript-sync-outbox.sqlite3',
  'dsh-core/wework-transcript-sync-outbox.sqlite3-wal',
  'dsh-core/wework-transcript-sync-outbox.sqlite3-shm',
] as const

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

async function assertOwnedTree(path: string, owner: string): Promise<void> {
  const actual = await realpath(path)
  const offset = relative(owner, actual)
  if (offset === '..' || offset.startsWith(`..${sep}`) || isAbsolute(offset)) {
    throw new Error('Update snapshot cannot follow a path outside Wework data')
  }
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink()) throw new Error('Update snapshot requires physically owned data')
  if (metadata.isDirectory()) {
    for (const name of await readdir(path)) await assertOwnedTree(join(path, name), owner)
  } else if (!metadata.isFile()) throw new Error('Update snapshot encountered a non-file entry')
}

/** Call only after every data writer has stopped and renderer persistence has flushed. */
export async function snapshotReleaseData(
  dataDirectory: string,
  releaseRoot: string,
  executorHome = dataDirectory
): Promise<string> {
  const id = randomUUID()
  const root = join(releaseRoot, 'snapshots', id)
  await mkdir(root, { recursive: true, mode: 0o700 })
  const entries: string[] = []
  for (const entry of RELEASE_SNAPSHOT_ENTRIES) {
    const dataRoot = entry.startsWith('data/') ? executorHome : dataDirectory
    const source = join(dataRoot, entry)
    if (!(await exists(source))) continue
    await assertOwnedTree(source, await realpath(dataRoot))
    await cp(source, join(root, entry), { recursive: true, preserveTimestamps: true })
    entries.push(entry)
  }
  await atomicReleaseWrite(
    join(root, 'snapshot.json'),
    JSON.stringify({ schemaVersion: 1, entries })
  )
  return id
}

/** An interrupted restore resumes from its journal; newer data is never overwritten. */
export async function restoreReleaseData(
  dataDirectory: string,
  releaseRoot: string,
  id: string,
  executorHome = dataDirectory
): Promise<void> {
  const root = join(releaseRoot, 'snapshots', releaseId(id))
  const snapshot = JSON.parse(await readFile(join(root, 'snapshot.json'), 'utf8')) as {
    schemaVersion: number
    entries: string[]
  }
  if (
    snapshot.schemaVersion !== 1 ||
    !Array.isArray(snapshot.entries) ||
    snapshot.entries.some(
      entry =>
        !RELEASE_SNAPSHOT_ENTRIES.includes(entry as (typeof RELEASE_SNAPSHOT_ENTRIES)[number])
    )
  ) {
    throw new Error('Invalid update data snapshot')
  }
  const preserved = join(releaseRoot, 'preserved-data', id)
  await mkdir(preserved, { recursive: true, mode: 0o700 })
  for (const entry of RELEASE_SNAPSHOT_ENTRIES) {
    const destination = join(entry.startsWith('data/') ? executorHome : dataDirectory, entry)
    const backup = join(preserved, entry)
    const marker = join(preserved, `${entry.replaceAll('/', '-')}.restored`)
    if (await exists(marker)) continue
    if ((await exists(destination)) && !(await exists(backup))) {
      await mkdir(join(backup, '..'), { recursive: true, mode: 0o700 })
      await rename(destination, backup)
    }
    if (snapshot.entries.includes(entry)) {
      const source = join(root, entry)
      await assertOwnedTree(source, await realpath(root))
      await rm(destination, { recursive: true, force: true })
      await cp(source, destination, { recursive: true, preserveTimestamps: true })
    }
    await atomicReleaseWrite(marker, 'restored')
  }
}
