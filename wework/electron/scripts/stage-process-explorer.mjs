import { createHash } from 'node:crypto'
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { acquireProcessLock } from '../../scripts/lib/process-lock.mjs'

// Wework's renderer and the Electron host use separate pnpm workspaces. The
// host cannot depend on the root package without pulling that package's
// toolchain into the Electron workspace, so the build stages the pure
// contract/core/host sources into a gitignored directory before tsc runs.
const electronRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const entries = ['contract.ts', 'core', 'host']

export async function stageProcessExplorer({ sourceRoot, targetRoot }) {
  await mkdir(dirname(targetRoot), { recursive: true })
  const release = await acquireProcessLock(`${targetRoot}.lock`)
  let staging
  try {
    const hash = createHash('sha256')
    for (const entry of entries) await fingerprint(join(sourceRoot, entry), entry, hash)
    const digest = hash.digest('hex')
    const current = await readFile(join(targetRoot, '.source-sha256'), 'utf8').catch(error => {
      if (error.code === 'ENOENT') return null
      throw error
    })
    // A second typecheck/test invocation must not delete sources the first is reading.
    if (current === digest) return
    staging = await mkdtemp(join(dirname(targetRoot), '.process-explorer-'))
    for (const entry of entries) {
      await cp(join(sourceRoot, entry), join(staging, entry), {
        recursive: true,
        filter: source => included(source),
      })
    }
    await writeFile(join(staging, '.source-sha256'), digest)
    await rm(targetRoot, { recursive: true, force: true })
    await rename(staging, targetRoot)
  } finally {
    if (staging) await rm(staging, { recursive: true, force: true })
    await release()
  }
}

const included = path => !path.endsWith('.test.ts') && !path.endsWith('.test.tsx')

async function fingerprint(path, relativePath, hash) {
  if (!included(path)) return
  hash.update(`${relativePath}\0`)
  const metadata = await lstat(path)
  if (metadata.isFile()) {
    hash.update(await readFile(path))
  } else if (metadata.isDirectory()) {
    for (const entry of (await readdir(path)).sort()) {
      await fingerprint(join(path, entry), `${relativePath}/${entry}`, hash)
    }
  } else throw new Error(`Unsupported process-explorer source: ${path}`)
  hash.update('\0')
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  await stageProcessExplorer({
    sourceRoot: resolve(
      process.argv[2] ?? join(electronRoot, '../../packages/process-explorer/src')
    ),
    targetRoot: resolve(process.argv[3] ?? join(electronRoot, 'src/vendor/process-explorer')),
  })
}
