import { cp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
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

// Share the existing authenticated Runtime transport with native app owners.
const chatSource = resolve(electronRoot, '../../packages/chat-core/src')
const chatTarget = resolve(electronRoot, 'src/vendor/chat-core')
await mkdir(chatTarget, { recursive: true })
for (const entry of [
  'runtime-ipc.ts',
  'runtime-transcript-transport.ts',
  'socket/authenticatedSocketClient.ts',
]) {
  const source = join(chatSource, entry)
  const target = join(chatTarget, entry)
  await mkdir(dirname(target), { recursive: true })
  const text = (await readFile(source, 'utf8'))
    .replaceAll('"./socket"', '"./socket/authenticatedSocketClient.js"')
    .replaceAll('"./runtime-transcript-transport"', '"./runtime-transcript-transport.js"')
  await writeFile(target, text)
}
