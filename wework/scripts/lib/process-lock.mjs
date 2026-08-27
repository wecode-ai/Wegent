import { open, readFile, stat, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'

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
  } catch {
    return null
  }
}

async function removeStaleLock(lockPath) {
  const owner = await readOwner(lockPath)
  if (processIsRunning(owner?.pid)) return false
  if (!owner) {
    try {
      const metadata = await stat(lockPath)
      if (Date.now() - metadata.mtimeMs < INCOMPLETE_OWNER_GRACE_MS) return false
    } catch (error) {
      if (error?.code === 'ENOENT') return true
      throw error
    }
  }
  try {
    await unlink(lockPath)
    return true
  } catch (error) {
    if (error?.code === 'ENOENT') return true
    throw error
  }
}

export async function acquireProcessLock(lockPath, options = {}) {
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS
  const owner = {
    pid: process.pid,
    token: randomUUID(),
  }

  while (true) {
    let handle
    try {
      handle = await open(lockPath, 'wx', 0o600)
      await handle.writeFile(`${JSON.stringify(owner)}\n`)
      await handle.close()
      break
    } catch (error) {
      await handle?.close()
      if (error?.code !== 'EEXIST') throw error
      if (!(await removeStaleLock(lockPath))) {
        await delay(pollIntervalMs)
      }
    }
  }

  let released = false
  return async () => {
    if (released) return
    released = true
    const current = await readOwner(lockPath)
    if (current?.token !== owner.token) return
    try {
      await unlink(lockPath)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }
}
