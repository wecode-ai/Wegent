#!/usr/bin/env node

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, watch } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEBOUNCE_DELAY_MS = 350
const EXIT_RESTART_DELAY_MS = 1000
const EXIT_RESTART_MAX_DELAY_MS = 10_000
const EXIT_RESTART_STABLE_MS = 10_000
const PARENT_CHECK_INTERVAL_MS = 250

const scriptDir = dirname(fileURLToPath(import.meta.url))
const executorDir = resolve(
  process.env.WEGENT_EXECUTOR_SOURCE_DIR || join(scriptDir, '..', '..', 'executor')
)
const manifestPath = join(executorDir, 'Cargo.toml')
const targetDir = resolve(
  process.cwd(),
  process.env.WEGENT_EXECUTOR_TARGET_DIR ||
    process.env.CARGO_TARGET_DIR ||
    join(executorDir, 'target')
)
const executorBinary = join(
  targetDir,
  'debug',
  process.platform === 'win32' ? 'wegent-executor.exe' : 'wegent-executor'
)
const executorArgs = process.argv.slice(2)
const expectedParentPid = process.ppid

let child = null
let buildProcess = null
let debounceTimer = null
let restartTimer = null
let restartStabilityTimer = null
let rebuilding = false
let rebuildPending = false
let shuttingDown = false
let unexpectedExitCount = 0
let lastAttemptedSourceFingerprint = null
const pendingInput = []
const watchers = []

function log(message) {
  process.stderr.write(`${message}\n`)
}

function pipeBuildOutput(stream) {
  stream?.on('data', chunk => process.stderr.write(chunk))
}

function hashPath(hash, path) {
  const entries = readdirSync(path, { withFileTypes: true }).sort((left, right) =>
    left.name.localeCompare(right.name)
  )
  for (const entry of entries) {
    const entryPath = join(path, entry.name)
    if (entry.isDirectory()) {
      hashPath(hash, entryPath)
    } else if (entry.isFile()) {
      hash.update(relative(executorDir, entryPath))
      hash.update(readFileSync(entryPath))
    }
  }
}

function sourceFingerprint() {
  const hash = createHash('sha256')
  for (const path of [manifestPath, join(executorDir, 'Cargo.lock')]) {
    hash.update(relative(executorDir, path))
    hash.update(readFileSync(path))
  }
  hashPath(hash, join(executorDir, 'src'))
  return hash.digest('hex')
}

function runBuild() {
  return new Promise((resolveBuild, rejectBuild) => {
    const build = spawn(
      'cargo',
      ['build', '--manifest-path', manifestPath, '--bin', 'wegent-executor'],
      {
        cwd: executorDir,
        env: {
          ...process.env,
          CARGO_TARGET_DIR: targetDir,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    )
    buildProcess = build
    pipeBuildOutput(build.stdout)
    pipeBuildOutput(build.stderr)
    build.once('error', error => {
      if (buildProcess === build) buildProcess = null
      rejectBuild(error)
    })
    build.once('exit', code => {
      if (buildProcess === build) buildProcess = null
      resolveBuild(code === 0)
    })
  })
}

function stopChild() {
  const runningChild = child
  child = null
  clearTimeout(restartStabilityTimer)
  restartStabilityTimer = null
  if (!runningChild) return Promise.resolve()
  if (runningChild.exitCode !== null || runningChild.signalCode !== null) {
    return Promise.resolve()
  }

  return new Promise(resolveStop => {
    const forceKillTimer = setTimeout(() => {
      runningChild.kill('SIGKILL')
    }, 2000)
    runningChild.once('exit', () => {
      clearTimeout(forceKillTimer)
      resolveStop()
    })
    runningChild.kill('SIGTERM')
  })
}

function startChild() {
  if (!existsSync(executorBinary)) {
    throw new Error(`executor binary was not created: ${executorBinary}`)
  }

  const nextChild = spawn(executorBinary, executorArgs, {
    cwd: executorDir,
    env: process.env,
    stdio: ['pipe', 'inherit', 'inherit'],
  })
  child = nextChild
  nextChild.once('spawn', () => {
    clearTimeout(restartStabilityTimer)
    restartStabilityTimer = setTimeout(() => {
      restartStabilityTimer = null
      unexpectedExitCount = 0
    }, EXIT_RESTART_STABLE_MS)
  })
  nextChild.stdin.on('error', () => {})
  for (const chunk of pendingInput.splice(0)) {
    nextChild.stdin.write(chunk)
  }
  nextChild.once('error', error => {
    if (child !== nextChild) return
    child = null
    log(`failed to start executor: ${error.message}`)
    scheduleUnexpectedExitRestart()
  })
  nextChild.once('exit', (code, signal) => {
    if (child !== nextChild) return
    child = null
    log(`executor exited code=${code ?? 'none'} signal=${signal ?? 'none'}; restarting`)
    scheduleUnexpectedExitRestart()
  })
}

process.stdin.on('data', chunk => {
  if (child?.stdin.writable) {
    child.stdin.write(chunk)
    return
  }
  pendingInput.push(chunk)
})
process.stdin.on('end', () => void shutdown())

function scheduleUnexpectedExitRestart() {
  if (shuttingDown) return
  clearTimeout(restartStabilityTimer)
  restartStabilityTimer = null
  clearTimeout(restartTimer)
  unexpectedExitCount += 1
  const delay = Math.min(
    EXIT_RESTART_DELAY_MS * 2 ** (unexpectedExitCount - 1),
    EXIT_RESTART_MAX_DELAY_MS
  )
  restartTimer = setTimeout(() => {
    restartTimer = null
    try {
      startChild()
    } catch (error) {
      log(`failed to restart executor: ${error instanceof Error ? error.message : error}`)
      void shutdown(1)
    }
  }, delay)
}

async function rebuildAndRestart() {
  if (shuttingDown) return
  if (rebuilding) {
    rebuildPending = true
    return
  }

  rebuilding = true
  try {
    do {
      rebuildPending = false
      clearTimeout(restartTimer)
      restartTimer = null
      const fingerprint = sourceFingerprint()
      if (fingerprint === lastAttemptedSourceFingerprint) {
        log('executor source unchanged; skipping duplicate rebuild')
        break
      }
      lastAttemptedSourceFingerprint = fingerprint
      await stopChild()
      if (shuttingDown) break

      const built = await runBuild()
      if (!built) {
        log('executor build failed; waiting for the next source change')
        if (rebuildPending) continue
        break
      }
      unexpectedExitCount = 0
      if (!shuttingDown) startChild()
    } while (rebuildPending && !shuttingDown)
  } finally {
    rebuilding = false
  }
}

function scheduleSourceRestart() {
  if (shuttingDown) return
  clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    log('executor source changed; rebuilding')
    runRebuild()
  }, DEBOUNCE_DELAY_MS)
}

function runRebuild() {
  void rebuildAndRestart().catch(error => {
    log(`wegent-executor dev reload failed: ${error instanceof Error ? error.message : error}`)
    void shutdown(1)
  })
}

function registerWatcher(watcher) {
  watcher.on('error', error => {
    log(`executor source watcher failed: ${error.message}`)
    void shutdown(1)
  })
  watchers.push(watcher)
}

function startWatching() {
  const sourceDir = join(executorDir, 'src')
  registerWatcher(watch(sourceDir, { recursive: true }, scheduleSourceRestart))
  registerWatcher(
    watch(executorDir, (_event, filename) => {
      if (filename === 'Cargo.toml' || filename === 'Cargo.lock') {
        scheduleSourceRestart()
      }
    })
  )
  log(`wegent-executor dev reload watching ${executorDir}`)
}

async function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  clearTimeout(debounceTimer)
  clearTimeout(restartTimer)
  clearTimeout(restartStabilityTimer)
  for (const watcher of watchers) watcher.close()
  buildProcess?.kill('SIGTERM')
  await stopChild()
  process.exit(exitCode)
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => void shutdown())
}

setInterval(() => {
  if (expectedParentPid > 1 && process.ppid !== expectedParentPid) {
    log('wegent-executor dev reload parent exited; shutting down')
    void shutdown()
  }
}, PARENT_CHECK_INTERVAL_MS)

try {
  startWatching()
  await rebuildAndRestart()
} catch (error) {
  log(`wegent-executor dev reload failed: ${error instanceof Error ? error.message : error}`)
  await shutdown(1)
}
