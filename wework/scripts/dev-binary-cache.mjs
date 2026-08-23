#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import {
  access,
  copyFile,
  link,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { updateHashWithFileState } from './lib/dev-cache-fingerprint.mjs'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const weworkDir = resolve(scriptDir, '..')
const projectDir = resolve(weworkDir, '..')
const CACHE_FORMAT_VERSION = 'wework-dev-binary-v1'
const MAX_CACHE_ENTRIES = 6
const LOCK_POLL_MS = 100
const LOCK_TIMEOUT_MS = 10 * 60_000

const components = {
  app: {
    sourcePath: join('wework', 'src-tauri'),
    sourceRoot: join(weworkDir, 'src-tauri'),
    manifestPath: join(weworkDir, 'src-tauri', 'Cargo.toml'),
    binaryName: 'app',
  },
  executor: {
    sourcePath: 'executor',
    sourceRoot: join(projectDir, 'executor'),
    manifestPath: join(projectDir, 'executor', 'Cargo.toml'),
    binaryName: 'wegent-executor',
  },
}

function cacheRoot() {
  return resolve(
    process.env.WEGENT_DEV_BINARY_CACHE_ROOT?.trim() ||
      join(
        process.env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache'),
        'wegent',
        'dev-binaries'
      )
  )
}

async function gitSourceFiles(sourcePath) {
  const output = await commandOutput(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', sourcePath],
    true
  )
  return output.split('\0').filter(Boolean).sort()
}

async function commandOutput(command, args, preserveNulls = false) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: command === 'git' ? projectDir : undefined,
      stdio: ['ignore', 'pipe', 'inherit'],
    })
    let output = ''
    child.stdout.on('data', chunk => {
      output += chunk
    })
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise(preserveNulls ? output : output.trim())
      else reject(new Error(`${command} exited with code ${code ?? 'unknown'}`))
    })
  })
}

export async function binaryFingerprint(componentName) {
  const component = components[componentName]
  if (!component) throw new Error(`Unsupported component: ${componentName}`)
  const hash = createHash('sha256')
  hash.update(CACHE_FORMAT_VERSION)
  hash.update('\0')
  hash.update(componentName)
  hash.update('\0')
  hash.update(await commandOutput('rustc', ['-vV']))
  for (const projectRelative of await gitSourceFiles(component.sourcePath)) {
    const relative = projectRelative.slice(component.sourcePath.length + 1)
    hash.update('\0')
    hash.update(relative)
    hash.update('\0')
    await updateHashWithFileState(hash, join(projectDir, projectRelative))
  }
  return hash.digest('hex')
}

function binaryFilename(name) {
  return process.platform === 'win32' ? `${name}.exe` : name
}

async function pathExists(path) {
  try {
    await access(path, constants.F_OK)
    return true
  } catch {
    return false
  }
}

async function runCargoBuild(component) {
  await new Promise((resolvePromise, reject) => {
    const child = spawn(
      'cargo',
      ['build', '--manifest-path', component.manifestPath, '--bin', component.binaryName],
      {
        cwd: dirname(component.manifestPath),
        env: process.env,
        stdio: ['ignore', process.stderr, process.stderr],
      }
    )
    child.once('error', reject)
    child.once('exit', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`cargo build exited with code ${code ?? 'unknown'}`))
    })
  })
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

async function acquireLock(lockPath, cachedBinary) {
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const lock = await open(lockPath, 'wx')
      await lock.writeFile(`${process.pid}\n`)
      await lock.close()
      return true
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (await pathExists(cachedBinary)) return false
      const ownerPid = await readLockPid(lockPath)
      if (!ownerPid || !processExists(ownerPid)) {
        await rm(lockPath, { force: true })
        continue
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, LOCK_POLL_MS))
    }
  }
  throw new Error(`Timed out waiting for development binary cache lock: ${lockPath}`)
}

async function installCachedBinary(source, destination) {
  const temporary = `${destination}.${process.pid}.tmp`
  await rm(temporary, { force: true })
  try {
    await link(source, temporary)
  } catch {
    await copyFile(source, temporary)
  }
  await rename(temporary, destination)
}

async function pruneComponentCache(componentRoot, keepFingerprint) {
  const entries = await readdir(componentRoot, { withFileTypes: true })
  const candidates = []
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === keepFingerprint) continue
    const path = join(componentRoot, entry.name)
    candidates.push({ path, modifiedMs: (await stat(path)).mtimeMs })
  }
  candidates.sort((left, right) => right.modifiedMs - left.modifiedMs)
  await Promise.all(
    candidates.slice(MAX_CACHE_ENTRIES - 1).map(entry =>
      rm(entry.path, {
        recursive: true,
        force: true,
      })
    )
  )
}

export async function prepareDevBinary(componentName) {
  const component = components[componentName]
  if (!component) throw new Error(`Unsupported component: ${componentName}`)
  const fingerprint = await binaryFingerprint(componentName)
  const componentRoot = join(cacheRoot(), componentName)
  const entry = join(componentRoot, fingerprint)
  const cachedBinary = join(entry, binaryFilename(component.binaryName))
  if (await pathExists(cachedBinary)) {
    const now = new Date()
    await utimes(entry, now, now)
    return cachedBinary
  }

  await mkdir(componentRoot, { recursive: true })
  const lockPath = `${entry}.lock`
  const ownsLock = await acquireLock(lockPath, cachedBinary)
  if (!ownsLock) return cachedBinary
  try {
    if (await pathExists(cachedBinary)) return cachedBinary
    await runCargoBuild(component)
    const targetRoot = resolve(
      process.env.CARGO_TARGET_DIR?.trim() || join(dirname(component.manifestPath), 'target')
    )
    const builtBinary = join(targetRoot, 'debug', binaryFilename(component.binaryName))
    if (!(await pathExists(builtBinary))) {
      throw new Error(`Development binary was not created: ${builtBinary}`)
    }
    await mkdir(entry, { recursive: true })
    await installCachedBinary(builtBinary, cachedBinary)
    await writeFile(
      join(entry, 'metadata.json'),
      `${JSON.stringify(
        {
          version: 1,
          component: componentName,
          fingerprint,
          binary: basename(cachedBinary),
          createdAt: new Date().toISOString(),
        },
        null,
        2
      )}\n`
    )
    await pruneComponentCache(componentRoot, fingerprint)
    return cachedBinary
  } finally {
    await rm(lockPath, { force: true })
  }
}

async function main() {
  const component = process.argv[2]
  if (!component) throw new Error('Usage: node scripts/dev-binary-cache.mjs <app|executor>')
  console.log(await prepareDevBinary(component))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(`dev-binary-cache: ${error.message ?? error}`)
    process.exitCode = 1
  })
}
