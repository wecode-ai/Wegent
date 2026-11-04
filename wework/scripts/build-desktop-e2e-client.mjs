#!/usr/bin/env node

import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'

const outputDirectory = process.argv[2]
if (!outputDirectory) throw new Error('A desktop E2E client output directory is required')

const require = createRequire(new URL('../../packages/chat-core/package.json', import.meta.url))
const entries = [
  ['socket.io-client', require.resolve('socket.io-client')],
  ['yaml', createRequire(new URL('../electron/package.json', import.meta.url)).resolve('yaml')],
  ['lz-string', fileURLToPath(new URL('./desktop-e2e-inventory-codec.mjs', import.meta.url))],
]
for (const [name, entry] of entries) {
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
