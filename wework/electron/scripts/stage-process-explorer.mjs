import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
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
} = {}) {
  await mkdir(dirname(targetRoot), { recursive: true })
  const release = await acquireProcessLock(`${targetRoot}.lock`)
  let staging
  try {
    // Keep temporary TypeScript sources outside src so another tsc cannot discover them.
    staging = await mkdtemp(join(tmpdir(), 'wework-process-explorer-stage-'))
    for (const entry of ['contract.ts', 'core', 'host']) {
      await cp(join(sourceRoot, entry), join(staging, entry), {
        recursive: true,
        filter: source => !source.endsWith('.test.ts') && !source.endsWith('.test.tsx'),
      })
    }
    // A parallel check may already be reading this tree after its own staging step.
    if (await contentMatches(staging, targetRoot)) return
    await rm(targetRoot, { recursive: true, force: true })
    await cp(staging, targetRoot, { recursive: true })
  } finally {
    try {
      if (staging) await rm(staging, { recursive: true, force: true })
    } finally {
      await release()
    }
  }
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
