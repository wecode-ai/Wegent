#!/usr/bin/env node

import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { build } from 'vite'

const outputDirectory = process.argv[2]
if (!outputDirectory) throw new Error('A desktop E2E client output directory is required')

for (const [dependency, manifest, filename] of [
  ['socket.io-client', '../../packages/chat-core/package.json', 'socket.io-client.cjs'],
  ['yaml', '../electron/package.json', 'yaml.cjs'],
]) {
  const require = createRequire(resolve(import.meta.dirname, manifest))
  await build({
    configFile: false,
    publicDir: false,
    ssr: { noExternal: true },
    build: {
      ssr: require.resolve(dependency),
      outDir: resolve(outputDirectory),
      emptyOutDir: false,
      minify: false,
      rollupOptions: {
        output: { format: 'cjs', entryFileNames: filename },
      },
    },
  })
}
