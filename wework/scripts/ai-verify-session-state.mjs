import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { acquireProcessLock } from './lib/process-lock.mjs'

/** Mutate the latest persisted state under the existing cross-process lock. */
export async function updateSessionState(path, update, fallback) {
  const release = await acquireProcessLock(`${path}.lock`, { pollIntervalMs: 5 })
  const pending = `${path}.${randomUUID()}.pending`
  try {
    let session
    try {
      session = JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      if (error.code !== 'ENOENT' || !fallback) throw error
      session = structuredClone(fallback)
    }
    await update(session)
    await writeFile(pending, `${JSON.stringify(session, null, 2)}\n`, { mode: 0o600 })
    await rename(pending, path)
    return session
  } finally {
    try {
      await rm(pending, { force: true })
    } finally {
      await release()
    }
  }
}
