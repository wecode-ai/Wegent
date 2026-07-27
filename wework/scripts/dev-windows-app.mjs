#!/usr/bin/env node
// One-command Windows desktop dev launcher for wework.
// Usage: pnpm --filter wework dev:windows [-- [options]]

import { execSync, spawn } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  statfsSync,
  writeFileSync,
} from 'node:fs'
import { createServer } from 'node:net'
import os from 'node:os'
import { delimiter, dirname, join, resolve, basename } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const DEFAULT_TARGET = 'x86_64-pc-windows-msvc'
const DEFAULT_BACKEND_PORT = '8000'
const DEFAULT_WEWORK_PORT = '1420'
const MIN_FREE_BYTES = 10 * 1024 ** 3 // 10 GiB

const WEWORK_DIR = resolve(__dirname, '..')
const PROJECT_DIR = resolve(WEWORK_DIR, '..')
const EXECUTOR_DIR = join(PROJECT_DIR, 'executor')
const TAURI_DIR = join(WEWORK_DIR, 'src-tauri')

if (process.platform !== 'win32') {
  console.error('[dev:windows] This script can only run on Windows.')
  process.exit(1)
}

function log(message) {
  console.log(`[dev:windows] ${message}`)
}

function printUsage() {
  console.log(`Usage: pnpm --filter wework dev:windows [-- [options]]

Options:
  -p, --port PORT         Vite/Tauri dev server port. Overrides WEWORK_PORT.
      --port=PORT
      --target TARGET     Windows Rust/Tauri target. Default: ${DEFAULT_TARGET}.
      --target=TARGET
      --release-ui        Run a production frontend bundle through tauri dev.
      --executor-isolation
                          Use an instance-specific Executor Home.
      --no-executor-isolation
      --shared-executor-home
                          Use the release app's persisted projects and tasks
                          (the default).
  -h, --help              Show this help.

Environment:
  WEWORK_PORT             Default dev server port when --port is not provided.
  WEWORK_HOST             Host IP used to build backend proxy targets.
  BACKEND_PORT            Backend port used when proxy targets are not set.
  CARGO_TARGET_DIR        Explicit Cargo target directory. Overrides auto cache.
  WEGENT_CARGO_TARGET_ROOT
                          Root containing shared Cargo targets.
  WEGENT_DISABLE_SHARED_CARGO_TARGET
                          Set to 1 to keep Cargo's default per-worktree target.
  WEGENT_DISABLE_SCCACHE  Set to 1 to disable automatic sccache detection.
  WEWORK_EXECUTOR_SIDECAR Executor sidecar path. Defaults to source reload sidecar.
  WEGENT_EXECUTOR_DEV_RELOAD
                          Set to 0 to run executor source once without reload.
  WEWORK_SHARED_EXECUTOR_HOME
                          Set to 1 to use the normal executor home in debug builds.
  WEWORK_PARENT_TITLE     Optional parent task title for the dev instance badge.
  WEWORK_PARENT_PROJECT   Optional parent project for the dev instance badge.
  WEWORK_PARENT_WORKSPACE Optional parent workspace for the dev instance badge.
`)
}

function parseArgs(argv) {
  const args = {
    port: null,
    target: DEFAULT_TARGET,
    releaseUi: false,
    executorIsolation: null,
    help: false,
  }

  let index = 0
  while (index < argv.length) {
    const arg = argv[index]

    const consumeValue = name => {
      if (index + 1 >= argv.length) {
        throw new Error(`${name} requires a value`)
      }
      index += 1
      return argv[index]
    }

    if (arg === '-p' || arg === '--port') {
      args.port = consumeValue(arg)
    } else if (arg.startsWith('--port=')) {
      args.port = arg.slice('--port='.length)
    } else if (arg === '--target') {
      args.target = consumeValue(arg)
    } else if (arg.startsWith('--target=')) {
      args.target = arg.slice('--target='.length)
    } else if (arg === '--release-ui') {
      args.releaseUi = true
    } else if (arg === '--executor-isolation') {
      args.executorIsolation = 'true'
    } else if (arg === '--no-executor-isolation' || arg === '--shared-executor-home') {
      args.executorIsolation = 'false'
      if (arg === '--shared-executor-home') {
        process.env.WEWORK_SHARED_EXECUTOR_HOME = '1'
      }
    } else if (arg === '-h' || arg === '--help') {
      args.help = true
    } else {
      throw new Error(`Unknown argument: ${arg}`)
    }

    index += 1
  }

  return args
}

// Load .env using a parser closer to a shell/dotenv subset so quoted values,
// inline comments, escapes, and simple variable expansion work.
function loadEnv(filePath) {
  const content = readFileSync(filePath, 'utf-8')
  const lines = content.split(/\r?\n/)

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (!line || line.startsWith('#')) {
      continue
    }

    const equalIndex = line.indexOf('=')
    if (equalIndex === -1) {
      continue
    }

    const key = line.slice(0, equalIndex).trim()
    let value = line.slice(equalIndex + 1)

    value = stripInlineComment(value)

    // Single-quoted values are literal (shell semantics); double-quoted or
    // unquoted values support variable expansion.
    const trimmed = value.trim()
    if (trimmed.length >= 2 && trimmed[0] === "'" && trimmed[trimmed.length - 1] === "'") {
      value = trimmed.slice(1, -1)
    } else {
      value = unquote(trimmed)
      value = expandVars(value)
    }

    value = value.trimEnd()

    if (key && process.env[key] === undefined) {
      process.env[key] = value
    }
  }
}

function stripInlineComment(value) {
  let inSingle = false
  let inDouble = false

  for (let index = 0; index < value.length; index += 1) {
    const ch = value[index]
    const prev = value[index - 1]

    if (ch === '"' && !inSingle && prev !== '\\') {
      inDouble = !inDouble
    } else if (ch === "'" && !inDouble && prev !== '\\') {
      inSingle = !inSingle
    } else if (ch === '#' && !inSingle && !inDouble) {
      return value.slice(0, index).trimEnd()
    }
  }

  return value
}

function unquote(value) {
  const trimmed = value.trim()
  if (trimmed.length < 2) {
    return trimmed
  }

  const first = trimmed[0]
  const last = trimmed[trimmed.length - 1]

  if (first === last && (first === '"' || first === "'")) {
    return trimmed
      .slice(1, -1)
      .replace(/\\("|')/g, '$1')
      .replace(/\\n/g, '\n')
      .replace(/\\r/g, '\r')
      .replace(/\\t/g, '\t')
  }

  return trimmed
}

function expandVars(value) {
  return value
    .replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => process.env[name] ?? '')
    .replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => process.env[name] ?? '')
}

function canonicalPath(filePath) {
  try {
    return realpathSync(filePath)
  } catch {
    return resolve(filePath)
  }
}

function getLocalIp() {
  const interfaces = os.networkInterfaces()
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if ((iface.family === 'IPv4' || iface.family === 4) && !iface.internal) {
        return iface.address
      }
    }
  }
  return '127.0.0.1'
}

function resolveBackendBaseUrl() {
  const host = process.env.WEWORK_HOST || getLocalIp()
  const port = process.env.BACKEND_PORT || DEFAULT_BACKEND_PORT
  return `http://${host}:${port}`
}

function cacheCandidates(cacheName) {
  const candidates = []

  if (process.env.WEGENT_CARGO_TARGET_ROOT) {
    candidates.push(join(process.env.WEGENT_CARGO_TARGET_ROOT.replace(/\/+$/, ''), cacheName))
    return candidates
  }

  const localAppData = process.env.LOCALAPPDATA
  const userProfile = process.env.USERPROFILE
  const home = process.env.HOME

  if (localAppData) {
    candidates.push(join(localAppData, 'wegent', 'cargo-target', cacheName))
  }

  if (userProfile) {
    candidates.push(join(userProfile, '.cache', 'wegent', 'cargo-target', cacheName))
  } else if (home) {
    candidates.push(join(home, '.cache', 'wegent', 'cargo-target', cacheName))
  }

  // Fallback to other drives when C: is low on space.
  for (const drive of ['D:', 'E:', 'F:', 'G:', 'H:']) {
    candidates.push(join(drive, 'wegent', 'cargo-target', cacheName))
  }

  return candidates
}

function getFreeSpace(filePath) {
  try {
    const stats = statfsSync(filePath)
    return stats.bfree * stats.bsize
  } catch {
    return 0
  }
}

function hasFiles(dir) {
  try {
    return readdirSync(dir).length > 0
  } catch {
    return false
  }
}

function selectBestCacheDir(candidates, minFreeBytes = MIN_FREE_BYTES) {
  // Prefer a cache that already exists so we do not rebuild dependencies from
  // scratch across low-space migrations.
  for (const candidate of candidates) {
    if (existsSync(candidate) && hasFiles(candidate)) {
      return candidate
    }
  }

  // Otherwise pick the first drive with enough free space.
  for (const candidate of candidates) {
    try {
      mkdirSync(candidate, { recursive: true })
      if (getFreeSpace(candidate) >= minFreeBytes) {
        return candidate
      }
    } catch {
      // ignore
    }
  }

  // Last resort: use the first candidate even if it is low on space.
  const fallback = candidates[0]
  if (fallback) {
    mkdirSync(fallback, { recursive: true })
  }
  return fallback
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

  if (process.env.CARGO_TARGET_DIR && process.env.WEGENT_CARGO_TARGET_DIR_AUTO !== '1') {
    const targetDir = resolve(process.env.CARGO_TARGET_DIR)
    configureSccache(projectDir, targetDir)
    return targetDir
  }

  const targetDir = selectBestCacheDir(cacheCandidates(cacheName))
  if (!targetDir) {
    throw new Error('Unable to determine a Cargo target directory')
  }
  mkdirSync(targetDir, { recursive: true })
  configureSccache(projectDir, targetDir)
  process.env.CARGO_TARGET_DIR = targetDir
  process.env.WEGENT_CARGO_TARGET_DIR_AUTO = '1'
  return targetDir
}

function validatePort(value) {
  const num = Number(value)
  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    throw new Error(`WEWORK_PORT must be an integer between 1 and 65535. Got: ${value}`)
  }
  return num
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
  for (let port = start; port <= 65535; port += 1) {
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
  const rawArgs = process.argv.slice(2)
  const args = parseArgs(rawArgs)

  if (args.help) {
    printUsage()
    process.exit(0)
  }

  const envFile = join(PROJECT_DIR, '.env')
  if (existsSync(envFile)) {
    loadEnv(envFile)
  }

  const backendPort = process.env.BACKEND_PORT || DEFAULT_BACKEND_PORT
  const requestedPort = args.port || process.env.WEWORK_PORT || DEFAULT_WEWORK_PORT
  const basePort = validatePort(requestedPort)
  const useDevReload = process.env.WEGENT_EXECUTOR_DEV_RELOAD !== '0'
  const releaseUi = args.releaseUi
  const target = args.target

  const initialIsolation = args.executorIsolation ?? process.env.WEWORK_EXECUTOR_ISOLATION_OVERRIDE
  process.env.WEWORK_EXECUTOR_ISOLATION_OVERRIDE = initialIsolation ?? 'false'

  if (process.env.WEWORK_SHARED_EXECUTOR_HOME === '1') {
    process.env.WEWORK_EXECUTOR_ISOLATION_OVERRIDE = 'false'
  }

  const executorCacheName = useDevReload ? 'executor-dev' : 'executor'
  const executorTargetDir = configureCargoTargetDir(PROJECT_DIR, executorCacheName)

  const port = await findAvailablePort(basePort)
  if (String(port) !== String(requestedPort)) {
    log(`WEWORK_PORT=${requestedPort} is in use; using ${port} instead.`)
  }

  log(`Project directory: ${PROJECT_DIR}`)
  log(`Tauri target: ${target}`)
  log(`Vite/Tauri dev port: ${port}`)
  log(`Backend proxy target: http://localhost:${backendPort}`)
  log(`Runtime backend URL: ${resolveBackendBaseUrl()}`)
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
        target,
      ],
      { cwd: EXECUTOR_DIR }
    )

    sidecarSource = join(executorTargetDir, target, 'debug', 'wegent-executor-dev.exe')
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
        target,
      ],
      { cwd: EXECUTOR_DIR }
    )

    const sourceBinary = join(executorTargetDir, target, 'debug', 'wegent-executor.exe')
    const binariesDir = join(TAURI_DIR, 'binaries')
    const distBinary = join(EXECUTOR_DIR, 'dist', 'wegent-executor.exe')

    mkdirSync(binariesDir, { recursive: true })
    mkdirSync(join(EXECUTOR_DIR, 'dist'), { recursive: true })

    const sidecarBinary = join(binariesDir, `wegent-executor-${target}.exe`)
    copyFileSync(sourceBinary, sidecarBinary)
    copyFileSync(sourceBinary, distBinary)

    sidecarSource = sidecarBinary
  }

  if (!existsSync(sidecarSource)) {
    throw new Error(`Sidecar binary not found: ${sidecarSource}`)
  }

  log(`Sidecar source: ${sidecarSource}`)

  if (useDevReload) {
    process.env.WEGENT_EXECUTOR_TARGET_DIR = executorTargetDir
  }

  const tauriTargetDir = configureCargoTargetDir(PROJECT_DIR, 'wework-src-tauri')
  log(`Tauri target dir: ${tauriTargetDir}`)

  tmpConfig = join(TAURI_DIR, `tauri.dev.windows.${Date.now()}.json`)
  const beforeDevCommand = releaseUi
    ? `pnpm run build && pnpm exec vite preview --host 0.0.0.0 --port ${port} --strictPort`
    : `pnpm exec vite --host 0.0.0.0 --port ${port} --strictPort`

  const tauriDevConfig = {
    build: {
      devUrl: `http://localhost:${port}`,
      beforeDevCommand,
    },
  }

  if (!releaseUi) {
    const devIconIco = join(TAURI_DIR, 'icons', 'icon-dev.ico')
    if (existsSync(devIconIco)) {
      tauriDevConfig.bundle = {
        icon: ['icons/icon-dev.ico', 'icons/icon.png'],
      }
    }
  }

  writeFileSync(tmpConfig, JSON.stringify(tauriDevConfig, null, 2))

  process.env.WEWORK_EXECUTOR_SIDECAR = sidecarSource
  process.env.VITE_WEWORK_DEV_PORT = String(port)
  process.env.VITE_WEWORK_DEV_WORKTREE = PROJECT_DIR
  process.env.VITE_WEWORK_DEV_BRANCH = gitBranch(PROJECT_DIR)
  process.env.VITE_WEWORK_DEV_TITLE = devTitle()
  process.env.VITE_WEWORK_PARENT_TITLE ||= process.env.WEWORK_PARENT_TITLE || ''
  process.env.VITE_WEWORK_PARENT_PROJECT ||= process.env.WEWORK_PARENT_PROJECT || ''
  process.env.VITE_WEWORK_PARENT_WORKSPACE ||= process.env.WEWORK_PARENT_WORKSPACE || ''

  const backendBaseUrl = resolveBackendBaseUrl()
  process.env.VITE_WEGENT_BACKEND_URL ||= backendBaseUrl
  process.env.VITE_WEGENT_SOCKET_URL ||= process.env.WEGENT_SOCKET_URL || backendBaseUrl

  log('Starting Tauri dev...')
  log(`  RELEASE_UI=${releaseUi}`)
  log(`  WEWORK_PORT=${port}`)
  log(`  WEWORK_DEV_TITLE=${process.env.VITE_WEWORK_DEV_TITLE}`)
  log(`  WEWORK_DEV_WORKTREE=${process.env.VITE_WEWORK_DEV_WORKTREE}`)
  log(`  WEWORK_DEV_BRANCH=${process.env.VITE_WEWORK_DEV_BRANCH || '<detached>'}`)
  log(`  VITE_WEGENT_BACKEND_URL=${process.env.VITE_WEGENT_BACKEND_URL}`)
  log(`  VITE_WEGENT_SOCKET_URL=${process.env.VITE_WEGENT_SOCKET_URL}`)
  log(`  CARGO_TARGET_DIR=${process.env.CARGO_TARGET_DIR}`)

  try {
    const tauriArgs = ['exec', 'tauri', 'dev', '--config', tmpConfig, '--target', target]
    if (releaseUi) {
      tauriArgs.push('--release')
    }
    await run('pnpm', tauriArgs, { cwd: WEWORK_DIR })
  } finally {
    cleanup()
  }
}

main().catch(error => {
  cleanup()
  console.error(`[dev:windows] ${error.message || error}`)
  process.exit(1)
})
