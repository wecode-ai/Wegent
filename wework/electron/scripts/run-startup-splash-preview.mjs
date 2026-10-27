#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// pnpm shells set ELECTRON_RUN_AS_NODE, which would start the Electron binary as
// plain Node. Spawn it explicitly so the preview always boots a real renderer.
const require = createRequire(import.meta.url)
const electronBinary = require('electron')
const scriptPath = join(dirname(fileURLToPath(import.meta.url)), 'preview-startup-splash.cjs')
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE

const child = spawn(electronBinary, [scriptPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env: environment,
})

child.on('exit', (code, signal) => {
  if (signal) {
    process.exit(1)
  }
  process.exit(code ?? 1)
})
