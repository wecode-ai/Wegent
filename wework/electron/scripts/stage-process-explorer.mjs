import { createHash } from 'node:crypto'
import { cp, lstat, mkdir, mkdtemp, rename, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { hashComponentPath } from '../../scripts/lib/component-content-hash.mjs'
import { acquireProcessLock } from '../../scripts/lib/process-lock.mjs'

// Wework's renderer and the Electron host use separate pnpm workspaces. The
// host cannot depend on the root package without pulling that package's
// toolchain into the Electron workspace, so the build stages the pure
// contract/core/host sources into a gitignored directory before tsc runs.
const electronRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

export async function stageProcessExplorer({
  sourceRoot = resolve(electronRoot, '../../packages/process-explorer/src'),
  targetRoot = resolve(electronRoot, 'src/vendor/process-explorer'),
  stagingRoot = resolve(electronRoot, '.process-explorer-staging'),
} = {}) {
  await mkdir(dirname(targetRoot), { recursive: true })
  const release = await acquireProcessLock(`${targetRoot}.lock`)
  const backup = join(
    stagingRoot,
    `${createHash('sha256').update(resolve(targetRoot)).digest('hex')}.previous`
  )
  let staging
  try {
    await recoverPublication(targetRoot, backup)
    // Use the same filesystem, outside src, so publication only renames complete trees.
    await mkdir(stagingRoot, { recursive: true })
    staging = await mkdtemp(join(stagingRoot, 'prepared-'))
    for (const entry of ['contract.ts', 'core', 'host']) {
      await cp(join(sourceRoot, entry), join(staging, entry), {
        recursive: true,
        filter: source => !source.endsWith('.test.ts') && !source.endsWith('.test.tsx'),
      })
    }
    // A parallel check may already be reading this tree after its own staging step.
    if (await contentMatches(staging, targetRoot)) return
    await publishPreparedTree(staging, targetRoot, backup)
  } finally {
    try {
      if (staging) await rm(staging, { recursive: true, force: true })
    } finally {
      await release()
    }
  }
}

async function exists(path) {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

async function recoverPublication(target, backup) {
  if (!(await exists(backup))) return
  if (await exists(target)) await rm(backup, { recursive: true, force: true })
  else await rename(backup, target)
}

async function publishPreparedTree(staging, target, backup) {
  const hadTarget = await exists(target)
  if (hadTarget) await rename(target, backup)
  try {
    await rename(staging, target)
  } catch (error) {
    if (hadTarget) {
      try {
        await rename(backup, target)
      } catch (rollbackError) {
        throw new AggregateError(
          [error, rollbackError],
          'Failed to publish and restore staged sources'
        )
      }
    }
    throw error
  }
  if (hadTarget) await rm(backup, { recursive: true, force: true })
}

async function contentMatches(source, target) {
  const expected = await hashComponentPath(source)
  try {
    return expected === (await hashComponentPath(target))
  } catch (error) {
    if (error.code === 'ENOENT') return false
    throw error
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await stageProcessExplorer()
}
