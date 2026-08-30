#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { wrapWindowsScriptCommand } from './child-process-command.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const weworkDir = resolve(scriptDir, '..')
const repositoryDir = resolve(weworkDir, '..')
const executorTargetDir = join(repositoryDir, 'executor', 'target', 'ai-verify')
const executorPath = join(
  resolve(executorTargetDir),
  'debug',
  process.platform === 'win32' ? 'wegent-executor.exe' : 'wegent-executor'
)
const pnpmCommand = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const buildEnvironment = {
  ...process.env,
  VITE_WEWORK_E2E: 'true',
  VITE_WEWORK_RELEASE_CHANNEL: 'stable',
  VITE_WEWORK_RUNTIME_MODE: 'local-first',
}

function run(command, args, cwd = weworkDir, environment = process.env) {
  return new Promise((resolvePromise, reject) => {
    const resolved = wrapWindowsScriptCommand(command, args)
    const child = spawn(resolved.command, resolved.args, {
      cwd,
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
  run(pnpmCommand, ['--dir', 'electron', 'run', 'build'], weworkDir, buildEnvironment),
  run(
    'cargo',
    [
      'build',
      '--manifest-path',
      join(repositoryDir, 'executor', 'Cargo.toml'),
      '--bin',
      'wegent-executor',
    ],
    repositoryDir,
    {
      ...process.env,
      CARGO_TARGET_DIR: executorTargetDir,
    }
  ),
])
await run(pnpmCommand, ['--dir', 'electron', 'run', 'prepare:package'], weworkDir, {
  ...buildEnvironment,
  WEWORK_EXECUTOR_PATH: executorPath,
  WEWORK_EXECUTOR_PROFILE: 'debug',
})
