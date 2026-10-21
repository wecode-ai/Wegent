import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Wework's renderer and the Electron host use separate pnpm workspaces. The
// host cannot depend on the root package without pulling that package's
// toolchain into the Electron workspace, so the build stages the pure
// contract/core/host sources into a gitignored directory before tsc runs.
const electronRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const sourceRoot = resolve(electronRoot, '../../packages/process-explorer/src')
const targetRoot = resolve(electronRoot, 'src/vendor/process-explorer')

await rm(targetRoot, { recursive: true, force: true })
await mkdir(targetRoot, { recursive: true })

for (const entry of ['contract.ts', 'core', 'host']) {
  await cp(join(sourceRoot, entry), join(targetRoot, entry), {
    recursive: true,
    filter: source => !source.endsWith('.test.ts') && !source.endsWith('.test.tsx'),
  })
}
