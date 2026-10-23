import {
  lstat,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  rmdir,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

const DEFAULT_POLL_INTERVAL_MS = 100
const INCOMPLETE_OWNER_GRACE_MS = 5_000

function delay(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function processIsRunning(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

async function readOwner(lockPath) {
  try {
    return JSON.parse(await readFile(lockPath, 'utf8'))
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function metadataIfPresent(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

async function removeEmptyLock(lockPath) {
  try {
    await rmdir(lockPath)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    if (['ENOTEMPTY', 'EEXIST', 'ENOTDIR'].includes(error?.code)) return false
    throw error
  }
}

async function removeLegacyLock(lockPath, metadata) {
  let owner
  try {
    owner = await readOwner(lockPath)
  } catch (error) {
    if (error?.code === 'EISDIR') return false
    if (!(error instanceof SyntaxError)) {
      const current = await metadataIfPresent(lockPath)
      if (!current || current.isDirectory()) return false
      throw error
    }
  }
  if (processIsRunning(owner?.pid)) return false
  if (!owner && Date.now() - metadata.mtimeMs < INCOMPLETE_OWNER_GRACE_MS) return false
  try {
    await unlink(lockPath)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    // New owners publish directories, which a delayed legacy unlink cannot remove.
    if ((await metadataIfPresent(lockPath))?.isDirectory()) return false
    throw error
  }
}

async function removeStaleLock(lockPath) {
  const metadata = await metadataIfPresent(lockPath)
  if (!metadata) return true
  if (metadata.isFile()) return removeLegacyLock(lockPath, metadata)
  if (!metadata.isDirectory()) throw new Error(`Invalid process lock: ${lockPath}`)
  let entries
  try {
    entries = await readdir(lockPath)
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    throw error
  }
  if (entries.length === 0) return removeEmptyLock(lockPath)
  if (entries.length !== 1 || !entries[0].startsWith('owner-')) {
    throw new Error(`Invalid process lock contents: ${lockPath}`)
  }
  const ownerPath = join(lockPath, entries[0])
  const owner = await readOwner(ownerPath)
  if (!owner) return false
  if (
    typeof owner.token !== 'string' ||
    entries[0] !== `owner-${owner.token}.json` ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0
  ) {
    throw new Error(`Invalid process lock owner: ${lockPath}`)
  }
  if (processIsRunning(owner.pid)) return false
  try {
    await unlink(ownerPath)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  // Only empty shells can disappear. A replacement owner's unique marker protects it.
  return removeEmptyLock(lockPath)
}

export async function acquireProcessLock(lockPath, options = {}) {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const owner = {
    pid: process.pid,
    token: randomUUID(),
  }
  const ownerFile = `owner-${owner.token}.json`
  const prepared = await mkdtemp(`${lockPath}.`)

  try {
    await writeFile(join(prepared, ownerFile), `${JSON.stringify(owner)}\n`, { mode: 0o600 })
    let vacantPermissionFailure = false
    while (true) {
      try {
        // Publish a complete, nonempty lock atomically; an active directory cannot be replaced.
        await rename(prepared, lockPath)
        break
      } catch (error) {
        if (['EPERM', 'EACCES'].includes(error?.code)) {
          const occupied = Boolean(await metadataIfPresent(lockPath))
          // Windows can report EPERM for an existing directory that has since disappeared.
          if (!occupied && vacantPermissionFailure) throw error
          vacantPermissionFailure = !occupied
        } else if (!['EEXIST', 'ENOTEMPTY', 'ENOTDIR'].includes(error?.code)) {
          throw error
        } else {
          vacantPermissionFailure = false
        }
        if (!(await removeStaleLock(lockPath))) {
          await delay(pollIntervalMs)
        }
      }
    }

    let released = false
    return async () => {
      if (released) return
      released = true
      try {
        await unlink(join(lockPath, ownerFile))
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error
      }
      await removeEmptyLock(lockPath)
    }
  } finally {
    // This path is private to this acquisition; never recursively remove the shared lock.
    await rm(prepared, { recursive: true, force: true })
  }
}
