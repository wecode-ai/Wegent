#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { wrapWindowsScriptCommand } from './child-process-command.mjs'
import { resolveSharedHarnessRuntimeAssetCacheRoot } from './lib/harness-runtime-cache.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const weworkDir = resolve(scriptDir, '..')
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const buildEnvironment = {
  ...process.env,
  VITE_WEWORK_E2E: 'true',
  VITE_WEWORK_RELEASE_CHANNEL: 'stable',
  VITE_WEWORK_RUNTIME_MODE: 'local-first',
  WEWORK_HARNESS_RUNTIME_ASSET_CACHE_ROOT: resolveSharedHarnessRuntimeAssetCacheRoot(
    process.env,
    { platform: process.platform },
    weworkDir
  ),
}

function run(command, args, environment = process.env) {
  return new Promise((resolvePromise, reject) => {
    const resolved = wrapWindowsScriptCommand(command, args)
    const child = spawn(resolved.command, resolved.args, {
      cwd: weworkDir,
      env: environment,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    })
  })
}

await run(pnpmCommand, ['run', 'prepare:electron'])
await Promise.all([
  run(pnpmCommand, ['run', 'prepare:codex', '--materialize']),
  run(pnpmCommand, ['run', 'prepare:dws']),
])
await run(pnpmCommand, ['--dir', 'electron', 'run', 'build:package'], buildEnvironment)
