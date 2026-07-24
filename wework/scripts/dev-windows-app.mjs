#!/usr/bin/env node
// One-command Windows desktop dev launcher for wework.
// Usage: pnpm --filter wework dev:windows

import { execSync, spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import { delimiter, dirname, join, resolve, basename } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const TARGET = 'x86_64-pc-windows-msvc'
const WEWORK_DIR = resolve(__dirname, '..')
const PROJECT_DIR = resolve(WEWORK_DIR, '..')
const EXECUTOR_DIR = join(PROJECT_DIR, 'executor')
const TAURI_DIR = join(WEWORK_DIR, 'src-tauri')

if (process.platform !== 'win32') {
  console.error('[dev:windows] This script can only run on Windows.')
  process.exit(1)
}

const envFile = join(PROJECT_DIR, '.env')
if (existsSync(envFile)) {
  loadEnv(envFile)
}

function log(message) {
  console.log(`[dev:windows] ${message}`)
}

function loadEnv(filePath) {
  const content = readFileSync(filePath, 'utf-8')
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) {
      continue
    }
    const index = line.indexOf('=')
    if (index === -1) {
      continue
    }
    const key = line.slice(0, index).trim()
    const value = line.slice(index + 1).trim()
    if (key && process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

function canonicalPath(filePath) {
  try {
    return realpathSync(filePath)
  } catch {
    return resolve(filePath)
  }
}

function wegentCargoCacheRoot() {
  if (process.env.WEGENT_CARGO_TARGET_ROOT) {
    return process.env.WEGENT_CARGO_TARGET_ROOT.replace(/\/+$/, '')
  }
  if (process.env.XDG_CACHE_HOME) {
    return join(process.env.XDG_CACHE_HOME, 'wegent', 'cargo-target')
  }
  const home = process.env.HOME || process.env.USERPROFILE
  if (home) {
    return join(home, '.cache', 'wegent', 'cargo-target')
  }
  return ''
}

function detectSccache() {
  try {
    execSync('sccache --version', { stdio: 'ignore' })
  } catch {
    return ''
  }
  try {
    const command = process.platform === 'win32' ? 'where sccache' : 'which sccache'
    const output = execSync(command, {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'ignore'],
    })
    const first = output.split(/\r?\n/)[0].trim()
    return first || 'sccache'
  } catch {
    return 'sccache'
  }
}

function configureSccache(projectDir, targetDir) {
  if (process.env.WEGENT_DISABLE_SCCACHE === '1') {
    return
  }
  if (process.env.RUSTC_WRAPPER && process.env.WEGENT_SCCACHE_AUTO !== '1') {
    return
  }
  const sccache = detectSccache()
  if (!sccache) {
    return
  }
  process.env.RUSTC_WRAPPER = sccache
  process.env.CARGO_INCREMENTAL = '0'
  process.env.WEGENT_SCCACHE_AUTO = '1'
  if (!process.env.SCCACHE_BASEDIRS || process.env.WEGENT_SCCACHE_BASEDIRS_AUTO === '1') {
    process.env.SCCACHE_BASEDIRS = [canonicalPath(projectDir), canonicalPath(targetDir)].join(
      delimiter
    )
    process.env.WEGENT_SCCACHE_BASEDIRS_AUTO = '1'
  }
}

function configureCargoTargetDir(projectDir, cacheName) {
  if (process.env.WEGENT_DISABLE_SHARED_CARGO_TARGET === '1') {
    const targetDir = join(projectDir, 'target')
    configureSccache(projectDir, targetDir)
    process.env.CARGO_TARGET_DIR = targetDir
    return targetDir
  }
  // If the user explicitly set CARGO_TARGET_DIR and we did not auto-set it,
  // respect their choice and do not switch to a different cache.
  if (process.env.CARGO_TARGET_DIR && process.env.WEGENT_CARGO_TARGET_DIR_AUTO !== '1') {
    const targetDir = resolve(process.env.CARGO_TARGET_DIR)
    configureSccache(projectDir, targetDir)
    return targetDir
  }
  const cacheRoot = wegentCargoCacheRoot()
  if (!cacheRoot) {
    const targetDir = join(projectDir, 'target')
    configureSccache(projectDir, targetDir)
    process.env.CARGO_TARGET_DIR = targetDir
    return targetDir
  }
  const targetDir = join(cacheRoot, cacheName)
  mkdirSync(targetDir, { recursive: true })
  configureSccache(projectDir, targetDir)
  process.env.CARGO_TARGET_DIR = targetDir
  process.env.WEGENT_CARGO_TARGET_DIR_AUTO = '1'
  return targetDir
}

function canListen(port, host) {
  return new Promise(resolve => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, host, () => {
      server.close(() => resolve(true))
    })
  })
}

async function findAvailablePort(start) {
  for (let port = start; port <= 65535; port++) {
    const okLocal = await canListen(port, '127.0.0.1')
    const okAll = await canListen(port, '0.0.0.0')
    if (okLocal && okAll) {
      return port
    }
  }
  throw new Error(`No available port found from ${start} to 65535`)
}

function resolveCommand(command) {
  if (process.platform !== 'win32') {
    return command
  }
  if (command.slice(-4).includes('.')) {
    return command
  }
  const cmdPath = `${command}.cmd`
  try {
    execSync(`where ${cmdPath}`, { stdio: 'ignore' })
    return cmdPath
  } catch {
    return command
  }
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let finalCommand = resolveCommand(command)
    let finalArgs = args

    // On Windows, .cmd/.bat files must be run through cmd.exe; spawning them
    // directly leads to EINVAL.
    if (
      process.platform === 'win32' &&
      (finalCommand.endsWith('.cmd') || finalCommand.endsWith('.bat'))
    ) {
      finalArgs = ['/c', finalCommand, ...args]
      finalCommand = 'cmd.exe'
    }

    const child = spawn(finalCommand, finalArgs, {
      stdio: 'inherit',
      env: process.env,
      ...options,
    })

    child.on('error', rejectPromise)
    child.on('close', code => {
      if (code === 0 || code === null) {
        resolvePromise()
      } else {
        rejectPromise(
          new Error(`"${finalCommand} ${finalArgs.join(' ')}" exited with code ${code}`)
        )
      }
    })
  })
}

function gitBranch(cwd) {
  try {
    return execSync('git branch --show-current', { cwd, encoding: 'utf-8' }).trim()
  } catch {
    return ''
  }
}

function devTitle() {
  if (process.env.WEWORK_DEV_TITLE) {
    return process.env.WEWORK_DEV_TITLE
  }
  const branch = gitBranch(PROJECT_DIR)
  if (branch) {
    return branch
  }
  return basename(PROJECT_DIR)
}

let tmpConfig = null

function cleanup() {
  if (tmpConfig) {
    try {
      rmSync(tmpConfig, { force: true })
    } catch {
      // ignore
    }
    tmpConfig = null
  }
}

process.on('SIGINT', cleanup)
process.on('SIGTERM', cleanup)
process.on('exit', cleanup)

async function main() {
  const backendPort = process.env.BACKEND_PORT || '8000'
  const basePort = Number(process.env.WEWORK_PORT || '1420')
  const requestedPort = process.env.WEWORK_PORT
  const useDevReload = process.env.WEWORK_DISABLE_EXECUTOR_DEV_RELOAD !== '1'

  // Default to shared executor home so dev builds reuse persisted projects/tasks.
  process.env.WEWORK_EXECUTOR_ISOLATION_OVERRIDE ||= 'false'

  const executorCacheName = useDevReload ? 'executor-dev' : 'executor'
  const executorTargetDir = configureCargoTargetDir(PROJECT_DIR, executorCacheName)

  const port = await findAvailablePort(basePort)
  if (requestedPort && port !== Number(requestedPort)) {
    log(`WEWORK_PORT=${requestedPort} is in use; using ${port} instead.`)
  }

  log(`Project directory: ${PROJECT_DIR}`)
  log(`Tauri target: ${TARGET}`)
  log(`Vite/Tauri dev port: ${port}`)
  log(`Backend proxy target: http://localhost:${backendPort}`)
  log(`Executor dev-reload: ${useDevReload ? 'enabled' : 'disabled'}`)
  log(`Executor isolation: ${process.env.WEWORK_EXECUTOR_ISOLATION_OVERRIDE}`)
  log(`Executor target dir: ${executorTargetDir}`)
  if (process.env.RUSTC_WRAPPER) {
    log(`Rust wrapper: ${process.env.RUSTC_WRAPPER}`)
  } else if (process.env.WEGENT_DISABLE_SCCACHE !== '1') {
    log('Rust wrapper: none (install sccache to speed up rebuilds)')
  }

  let sidecarSource

  if (useDevReload) {
    log('Building wegent-executor-dev sidecar...')
    await run(
      'cargo',
      [
        'build',
        '--manifest-path',
        join(EXECUTOR_DIR, 'Cargo.toml'),
        '--features',
        'dev-reload',
        '--bin',
        'wegent-executor-dev',
        '--target',
        TARGET,
      ],
      { cwd: EXECUTOR_DIR }
    )

    sidecarSource = join(executorTargetDir, TARGET, 'debug', 'wegent-executor-dev.exe')
    process.env.WEGENT_EXECUTOR_SOURCE_DIR = EXECUTOR_DIR
  } else {
    log('Building wegent-executor sidecar...')
    await run(
      'cargo',
      [
        'build',
        '--manifest-path',
        join(EXECUTOR_DIR, 'Cargo.toml'),
        '--bin',
        'wegent-executor',
        '--target',
        TARGET,
      ],
      { cwd: EXECUTOR_DIR }
    )

    const sourceBinary = join(executorTargetDir, TARGET, 'debug', 'wegent-executor.exe')
    const binariesDir = join(TAURI_DIR, 'binaries')
    const distBinary = join(EXECUTOR_DIR, 'dist', 'wegent-executor.exe')

    mkdirSync(binariesDir, { recursive: true })
    mkdirSync(join(EXECUTOR_DIR, 'dist'), { recursive: true })

    const sidecarBinary = join(binariesDir, `wegent-executor-${TARGET}.exe`)
    copyFileSync(sourceBinary, sidecarBinary)
    copyFileSync(sourceBinary, distBinary)

    sidecarSource = sidecarBinary
  }

  if (!existsSync(sidecarSource)) {
    throw new Error(`Sidecar binary not found: ${sidecarSource}`)
  }

  log(`Sidecar source: ${sidecarSource}`)

  // The dev-reload sidecar internally runs `cargo build` for wegent-executor.
  // Pin it to the executor cache so it does not compete with the Tauri build.
  if (useDevReload) {
    process.env.WEGENT_EXECUTOR_TARGET_DIR = executorTargetDir
  }

  // Switch Cargo to the Tauri cache for the Tauri/Cargo build.
  const tauriTargetDir = configureCargoTargetDir(PROJECT_DIR, 'wework-src-tauri')
  log(`Tauri target dir: ${tauriTargetDir}`)

  log('Preparing bundled Codex binary...')
  process.env.WEWORK_CODEX_TARGET = TARGET
  await run('pnpm', ['run', 'prepare:codex'], { cwd: WEWORK_DIR })

  tmpConfig = join(TAURI_DIR, `tauri.dev.windows.${Date.now()}.json`)
  const tauriDevConfig = {
    build: {
      devUrl: `http://localhost:${port}`,
      beforeDevCommand: `pnpm exec vite --host 0.0.0.0 --port ${port} --strictPort`,
    },
  }
  writeFileSync(tmpConfig, JSON.stringify(tauriDevConfig, null, 2))

  process.env.WEWORK_EXECUTOR_SIDECAR = sidecarSource
  process.env.VITE_API_BASE_URL ||= '/api'
  process.env.VITE_SOCKET_BASE_URL ||= `http://localhost:${port}`
  process.env.VITE_SOCKET_PATH ||= '/socket.io'
  process.env.VITE_API_PROXY_TARGET ||= `http://localhost:${backendPort}`
  process.env.VITE_SOCKET_PROXY_TARGET ||=
    process.env.WEGENT_SOCKET_URL || `http://localhost:${backendPort}`
  process.env.VITE_WEWORK_DEV_PORT = String(port)
  process.env.VITE_WEWORK_DEV_WORKTREE = PROJECT_DIR
  process.env.VITE_WEWORK_DEV_BRANCH = gitBranch(PROJECT_DIR)
  process.env.VITE_WEWORK_DEV_TITLE = devTitle()

  log('Starting Tauri dev...')
  try {
    await run('pnpm', ['exec', 'tauri', 'dev', '--config', tmpConfig, '--target', TARGET], {
      cwd: WEWORK_DIR,
    })
  } finally {
    cleanup()
  }
}

main().catch(error => {
  cleanup()
  console.error(`[dev:windows] ${error.message || error}`)
  process.exit(1)
})
