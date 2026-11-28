import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readdir, readFile, realpath, rename, rm } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { atomicReleaseWrite, releaseId } from './release-store.js'

// Add new migration-owned stores here alongside their upgrade/restore E2E fixture.
// Authentication, repositories, agent Homes and cloud records are deliberately absent.
const EXECUTOR_SNAPSHOT_ENTRIES = [
  'data/tasks.sqlite',
  'data/tasks.sqlite-wal',
  'data/tasks.sqlite-shm',
] as const

const DESKTOP_SNAPSHOT_ENTRIES = [
  'app-preferences.json',
  'renderer-local-storage.json',
  'renderer-local-storage-origins.json',
  'dsh-core/wework-transcript-sync.json',
  'dsh-core/wework-transcript-sync-outbox.sqlite3',
  'dsh-core/wework-transcript-sync-outbox.sqlite3-wal',
  'dsh-core/wework-transcript-sync-outbox.sqlite3-shm',
] as const
const RELEASE_SNAPSHOT_ENTRIES = [...EXECUTOR_SNAPSHOT_ENTRIES, ...DESKTOP_SNAPSHOT_ENTRIES]

interface ReleaseSnapshot {
  schemaVersion: 1
  entries: string[]
  executorDataCaptured?: true
}

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
  const entries = [
    ...(await captureEntries(root, DESKTOP_SNAPSHOT_ENTRIES, dataDirectory)),
    ...(await captureEntries(root, EXECUTOR_SNAPSHOT_ENTRIES, executorHome)),
  ]
  await writeSnapshot(root, { schemaVersion: 1, entries, executorDataCaptured: true })
  return id
}

async function captureEntries(root: string, candidates: readonly string[], dataRoot: string) {
  const entries: string[] = []
  for (const entry of candidates) {
    const source = join(dataRoot, entry)
    if (!(await exists(source))) continue
    await assertOwnedTree(source, await realpath(dataRoot))
    await cp(source, join(root, entry), { recursive: true, preserveTimestamps: true })
    entries.push(entry)
  }
  return entries
}

function writeSnapshot(root: string, snapshot: ReleaseSnapshot): Promise<void> {
  return atomicReleaseWrite(join(root, 'snapshot.json'), JSON.stringify(snapshot))
}

async function readSnapshot(root: string): Promise<ReleaseSnapshot> {
  const snapshot = JSON.parse(
    await readFile(join(root, 'snapshot.json'), 'utf8')
  ) as ReleaseSnapshot
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
  return snapshot
}

function hasExecutorSnapshot(snapshot: ReleaseSnapshot): boolean {
  return snapshot.executorDataCaptured === true || snapshot.entries.includes('data/tasks.sqlite')
}

/** Older bridges could omit the default Workbench database from their snapshot. */
export async function completeExecutorSnapshot(
  releaseRoot: string,
  id: string,
  executorHome: string
): Promise<void> {
  const root = join(releaseRoot, 'snapshots', releaseId(id))
  const snapshot = await readSnapshot(root)
  if (hasExecutorSnapshot(snapshot)) return
  const entries = await captureEntries(root, EXECUTOR_SNAPSHOT_ENTRIES, executorHome)
  await writeSnapshot(root, {
    schemaVersion: 1,
    entries: [...snapshot.entries.filter(entry => !entry.startsWith('data/')), ...entries],
    executorDataCaptured: true,
  })
}

/** An interrupted restore resumes from its journal; newer data is never overwritten. */
export async function restoreReleaseData(
  dataDirectory: string,
  releaseRoot: string,
  id: string,
  executorHome = dataDirectory
): Promise<void> {
  const root = join(releaseRoot, 'snapshots', releaseId(id))
  const snapshot = await readSnapshot(root)
  const preserved = join(releaseRoot, 'preserved-data', id)
  await mkdir(preserved, { recursive: true, mode: 0o700 })
  const entries = hasExecutorSnapshot(snapshot)
    ? RELEASE_SNAPSHOT_ENTRIES
    : DESKTOP_SNAPSHOT_ENTRIES
  for (const entry of entries) {
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
