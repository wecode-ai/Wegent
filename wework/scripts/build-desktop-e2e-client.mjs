#!/usr/bin/env node

import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { build } from 'vite'

const outputDirectory = process.argv[2]
if (!outputDirectory) throw new Error('A desktop E2E client output directory is required')

const require = createRequire(new URL('../../packages/chat-core/package.json', import.meta.url))
const weworkRequire = createRequire(new URL('../package.json', import.meta.url))
for (const [name, entry] of [
  ['socket.io-client', require.resolve('socket.io-client')],
  ['smol-toml', weworkRequire.resolve('smol-toml')],
]) {
  await build({
    configFile: false,
    publicDir: false,
    ssr: { noExternal: true },
    build: {
      ssr: entry,
      outDir: resolve(outputDirectory),
      emptyOutDir: false,
      minify: false,
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: `${name}.cjs` },
      },
    },
  })
}
