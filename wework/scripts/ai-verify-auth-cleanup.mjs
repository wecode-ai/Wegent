import { lstat, readFile, readlink, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'

const MARKER = '.wework-managed-auth'

export function sessionExecutorHome(session) {
  return resolve(session.executorHomeOverride || join(session.directory, 'executor-home'))
}

async function entryIdentity(path) {
  try {
    const metadata = await lstat(path, { bigint: true })
    return {
      kind: metadata.isSymbolicLink() ? 'symlink' : metadata.isFile() ? 'file' : 'other',
      dev: metadata.dev.toString(),
      ino: metadata.ino.toString(),
      size: metadata.size.toString(),
      mtimeNs: metadata.mtimeNs.toString(),
      ctimeNs: metadata.ctimeNs.toString(),
      ...(metadata.isSymbolicLink()
        ? { target: resolve(dirname(path), await readlink(path)) }
        : {}),
    }
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

function sameIdentity(first, second) {
  return (
    Boolean(first && second) &&
    Object.keys(first).length === Object.keys(second).length &&
    Object.entries(first).every(([key, value]) => second[key] === value)
  )
}

export async function captureSessionAuthOwnership(
  session,
  { nativeCodexHome, platform = process.platform } = {}
) {
  const home = sessionExecutorHome(session)
  const authPath = join(home, 'codex', 'auth.json')
  return {
    version: 2,
    ownerId: randomUUID(),
    authPath,
    platform,
    nativeAuthPath: nativeCodexHome ? resolve(nativeCodexHome, 'auth.json') : null,
    authExistedAtStart: (await entryIdentity(authPath)) !== null,
    markerBefore: await entryIdentity(join(dirname(authPath), MARKER)),
    owned: null,
    cleaned: false,
  }
}

function ownershipFor(session) {
  const ownership = session.authCleanup
  return ownership?.version === 2 &&
    typeof ownership.ownerId === 'string' &&
    ownership.authPath === join(sessionExecutorHome(session), 'codex', 'auth.json') &&
    ownership.authExistedAtStart === false &&
    Object.hasOwn(ownership, 'markerBefore') &&
    typeof ownership.nativeAuthPath === 'string' &&
    ownership.nativeAuthPath !== ownership.authPath &&
    !ownership.cleaned
    ? ownership
    : null
}

/** Observe only metadata: the native writer refreshes its marker after creating auth. */
export async function observeSessionAuthOwnership(session) {
  const ownership = ownershipFor(session)
  if (!ownership) return false
  const marker = await entryIdentity(join(dirname(ownership.authPath), MARKER))
  if (marker?.kind !== 'file' || sameIdentity(marker, ownership.markerBefore)) return false
  if (sameIdentity(marker, ownership.owned?.marker)) return false
  const auth = await entryIdentity(ownership.authPath)
  let receipt
  try {
    receipt = JSON.parse(await readFile(join(dirname(ownership.authPath), MARKER), 'utf8'))
  } catch {
    return false
  }
  if (
    !receipt ||
    typeof receipt !== 'object' ||
    Array.isArray(receipt) ||
    receipt.version !== 1 ||
    receipt.ownerId !== ownership.ownerId ||
    !sameIdentity(auth, receipt.auth)
  )
    return false
  const kind = ownership.platform === 'win32' ? 'file' : 'symlink'
  if (auth?.kind !== kind) return false
  if (kind === 'symlink' && auth.target !== ownership.nativeAuthPath) return false
  ownership.owned = { auth, marker }
  return true
}

/** Preserve existing auth, replacements and unknown override homes. */
export async function cleanupSessionAuth(session) {
  if (!session.authCleanup) {
    if (session.executorHomeOverride || !session.directory) return false
    const path = join(session.directory, 'executor-home', 'codex', 'auth.json')
    if (!(await entryIdentity(path))) return false
    await rm(path, { force: true })
    return true
  }
  await observeSessionAuthOwnership(session)
  const ownership = ownershipFor(session)
  if (!ownership?.owned) return false
  const markerPath = join(dirname(ownership.authPath), MARKER)
  const auth = await entryIdentity(ownership.authPath)
  const marker = await entryIdentity(markerPath)
  if (!sameIdentity(auth, ownership.owned.auth) || !sameIdentity(marker, ownership.owned.marker))
    return false
  await rm(ownership.authPath, { force: true })
  await rm(markerPath, { force: true })
  ownership.cleaned = true
  return true
}
