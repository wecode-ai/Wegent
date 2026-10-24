import { cp, mkdir, open, rm, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Wework's renderer and the Electron host use separate pnpm workspaces. The
// host cannot depend on the root package without pulling that package's
// toolchain into the Electron workspace, so the build stages the pure
// contract/core/host sources into a gitignored directory before tsc runs.
const electronRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = resolve(electronRoot, '../../packages/process-explorer/src')
const targetRoot = resolve(electronRoot, 'src/vendor/process-explorer')
const lockPath = resolve(electronRoot, 'src/vendor/.process-explorer-staging.lock')
const LOCK_POLL_MS = 50
const LOCK_TIMEOUT_MS = 120_000
const STALE_LOCK_MS = 60_000

// The pre-push gate runs the Electron typecheck and unit tests in parallel, and
// both stage into the same directory. Serialize them so one run cannot delete
// files while the other is still copying.
async function acquireLock() {
  await mkdir(dirname(lockPath), { recursive: true })
  const startedAt = Date.now()
  while (true) {
    try {
      return await open(lockPath, 'wx')
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      const ageMs = await stat(lockPath)
        .then(stats => Date.now() - stats.mtimeMs)
        .catch(() => STALE_LOCK_MS)
      if (ageMs > STALE_LOCK_MS) {
        await rm(lockPath, { force: true })
        continue
      }
      if (Date.now() - startedAt > LOCK_TIMEOUT_MS) {
        throw new Error(`Timed out waiting for the process-explorer staging lock`)
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, LOCK_POLL_MS))
    }
  }
}

async function stage() {
  await rm(targetRoot, { recursive: true, force: true })
  await mkdir(targetRoot, { recursive: true })

  for (const entry of ['contract.ts', 'core', 'host']) {
    await cp(join(sourceRoot, entry), join(targetRoot, entry), {
      recursive: true,
      filter: source => !source.endsWith('.test.ts') && !source.endsWith('.test.tsx'),
    })
  }
}

const lock = await acquireLock()
try {
  await stage()
} finally {
  await lock.close()
  await rm(lockPath, { force: true })
}
