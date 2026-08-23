#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const weworkDir = resolve(scriptDir, '..')
const projectDir = resolve(weworkDir, '..')
const CACHE_FORMAT_VERSION = 'wework-dev-frontend-v1'
const MAX_CACHE_ENTRIES = 6
const LOCK_POLL_MS = 100
const LOCK_TIMEOUT_MS = 10 * 60_000
const sourceRoots = [
  join('wework', 'src'),
  join('wework', 'wecode'),
  join('wework', 'public'),
  join('packages', 'chat-core', 'src'),
]
const sourceFiles = [
  join('wework', 'index.html'),
  join('wework', 'package.json'),
  join('wework', 'postcss.config.js'),
  join('wework', 'tailwind.config.js'),
  join('wework', 'tsconfig.json'),
  join('wework', 'vite.config.ts'),
  'package.json',
  'pnpm-lock.yaml',
  'pnpm-workspace.yaml',
  join('packages', 'chat-core', 'package.json'),
]
const ignoredFilePattern = /\.(?:spec|test)\.[cm]?[jt]sx?$/
const runtimeEnvironmentKeys = new Set([
  'VITE_WEWORK_DESKTOP_E2E_CONTROL_TOKEN',
  'VITE_WEWORK_DESKTOP_E2E_CONTROL_URL',
  'VITE_WEWORK_DEV_BRANCH',
  'VITE_WEWORK_DEV_PORT',
  'VITE_WEWORK_DEV_TITLE',
  'VITE_WEWORK_DEV_WORKTREE',
  'VITE_WEWORK_PARENT_PROJECT',
  'VITE_WEWORK_PARENT_TITLE',
  'VITE_WEWORK_PARENT_WORKSPACE',
])

function cacheRoot() {
  return resolve(
    process.env.WEGENT_DEV_FRONTEND_CACHE_ROOT?.trim() ||
      join(
        process.env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache'),
        'wegent',
        'dev-frontends'
      )
  )
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function gitSourceFiles() {
  const output = await new Promise((resolvePromise, reject) => {
    const child = spawn(
      'git',
      ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...sourceRoots, ...sourceFiles],
      {
        cwd: projectDir,
        stdio: ['ignore', 'pipe', 'inherit'],
      }
    )
    const chunks = []
    child.stdout.on('data', chunk => chunks.push(chunk))
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise(Buffer.concat(chunks))
      else reject(new Error(`git ls-files exited with code ${code ?? 'unknown'}`))
    })
  })
  return output
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .filter(relative => !ignoredFilePattern.test(relative))
    .sort()
}

function buildEnvironmentFingerprint() {
  return Object.entries(process.env)
    .filter(([key]) => key.startsWith('VITE_'))
    .filter(([key]) => !runtimeEnvironmentKeys.has(key))
    .sort(([left], [right]) => left.localeCompare(right))
}

async function frontendFingerprint() {
  const hash = createHash('sha256')
  hash.update(CACHE_FORMAT_VERSION)
  for (const [key, value] of buildEnvironmentFingerprint()) {
    hash.update(`\0env:${key}\0${value ?? ''}`)
  }
  for (const relative of await gitSourceFiles()) {
    hash.update(`\0file:${relative}\0`)
    hash.update(await readFile(join(projectDir, relative)))
  }
  return hash.digest('hex')
}

async function readLockPid(lockPath) {
  try {
    const value = Number.parseInt(await readFile(lockPath, 'utf8'), 10)
    return Number.isInteger(value) && value > 1 ? value : null
  } catch {
    return null
  }
}

function processExists(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function acquireLock(lockPath, readyPath) {
  const deadline = performance.now() + LOCK_TIMEOUT_MS
  while (performance.now() < deadline) {
    try {
      const lock = await open(lockPath, 'wx')
      await lock.writeFile(`${process.pid}\n`)
      await lock.close()
      return true
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (await pathExists(readyPath)) return false
      const ownerPid = await readLockPid(lockPath)
      if (!ownerPid || !processExists(ownerPid)) {
        await rm(lockPath, { force: true })
        continue
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, LOCK_POLL_MS))
    }
  }
  throw new Error(`Timed out waiting for development frontend cache lock: ${lockPath}`)
}

async function buildFrontend(destination) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(
      'pnpm',
      ['exec', 'vite', 'build', '--outDir', destination, '--emptyOutDir', '--logLevel', 'warn'],
      {
        cwd: weworkDir,
        env: {
          ...process.env,
          VITE_WEWORK_DESKTOP_E2E_CONTROL_URL: '',
          VITE_WEWORK_DESKTOP_E2E_CONTROL_TOKEN: '',
        },
        stdio: ['ignore', process.stderr, process.stderr],
      }
    )
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`vite build exited with code ${code ?? 'unknown'}`))
    })
  })
}

async function pruneCache(root, keepFingerprint) {
  const entries = await readdir(root, { withFileTypes: true })
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keepFingerprint) continue
    const path = join(root, entry.name)
    candidates.push({ path, modifiedMs: (await stat(path)).mtimeMs })
  }
  candidates.sort((left, right) => right.modifiedMs - left.modifiedMs)
  await Promise.all(
    candidates
      .slice(MAX_CACHE_ENTRIES - 1)
      .map(entry => rm(entry.path, { recursive: true, force: true }))
  )
}

export async function prepareDevFrontend() {
  const fingerprint = await frontendFingerprint()
  const root = cacheRoot()
  const destination = join(root, fingerprint)
  const readyPath = join(destination, 'index.html')
  if (await pathExists(readyPath)) {
    const now = new Date()
    await utimes(destination, now, now)
    return destination
  }

  await mkdir(root, { recursive: true })
  const lockPath = `${destination}.lock`
  const ownsLock = await acquireLock(lockPath, readyPath)
  if (!ownsLock) return destination
  const temporary = `${destination}.${process.pid}.tmp`
  try {
    await rm(temporary, { recursive: true, force: true })
    await buildFrontend(temporary)
    await rename(temporary, destination)
    await pruneCache(root, fingerprint)
    return destination
  } finally {
    await rm(temporary, { recursive: true, force: true })
    await rm(lockPath, { force: true })
  }
}

async function main() {
  console.log(await prepareDevFrontend())
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error)
    process.exit(1)
  })
}
