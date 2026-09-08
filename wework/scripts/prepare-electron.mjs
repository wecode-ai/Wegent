#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { wrapWindowsScriptCommand } from './child-process-command.mjs'
import { electronToolchainLockPath } from './lib/electron-toolchain-lock.mjs'
import { acquireProcessLock } from './lib/process-lock.mjs'

const weworkRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const releaseToolchainLock = await acquireProcessLock(electronToolchainLockPath)

try {
  if (process.env.WEWORK_ELECTRON_DEPENDENCIES_READY !== 'true') {
    await run(pnpmCommand, ['--dir', 'electron', 'install', '--frozen-lockfile'])
  }
  await run(process.execPath, [
    join(weworkRoot, 'electron', 'node_modules', 'electron', 'install.js'),
  ])
} finally {
  await releaseToolchainLock()
}

function run(command, args) {
  return new Promise((resolvePromise, reject) => {
    const resolved = wrapWindowsScriptCommand(command, args)
    const child = spawn(resolved.command, resolved.args, {
      cwd: weworkRoot,
      stdio: 'inherit',
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    })
  })
}
