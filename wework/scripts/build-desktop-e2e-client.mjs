#!/usr/bin/env node

import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { build } from 'vite'

const outputDirectory = process.argv[2]
if (!outputDirectory) throw new Error('A desktop E2E client output directory is required')

const require = createRequire(new URL('../../packages/chat-core/package.json', import.meta.url))
await build({
  configFile: false,
  publicDir: false,
  ssr: { noExternal: true },
  build: {
    ssr: require.resolve('socket.io-client'),
    outDir: resolve(outputDirectory),
    emptyOutDir: false,
    minify: false,
    rollupOptions: {
      output: { format: 'cjs', entryFileNames: 'socket.io-client.cjs' },
    },
  },
})
