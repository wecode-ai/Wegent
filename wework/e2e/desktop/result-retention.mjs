import { spawn } from 'node:child_process'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

import { processGroupIsAlive, processIsAlive } from './process-lifecycle.mjs'

const ACTIVE_MARKER = '.active'
const POSIX_REMOVE_ATTEMPTS = 20
const POSIX_REMOVE_RETRY_DELAY_MS = 100
const CACHE_DIRECTORY_NAMES = new Set([
  'Cache',
  'Code Cache',
  'DawnGraphiteCache',
  'DawnWebGPUCache',
  'GPUCache',
  'GrShaderCache',
  'ShaderCache',
])
const TRANSIENT_TOP_LEVEL_ENTRIES = new Set([
  'executor-home',
  'harness-runtime',
  'node-runtime',
  'wegent-executor',
  'wegent-executor.exe',
])
const MACOS_APP_BUNDLE_PATTERN = /^WeWork-Electron-E2E-\d+\.app$/
const RESULT_DIRECTORY_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-(\d+)$/

function removeOptions() {
  return {
    force: true,
    maxRetries: 20,
    recursive: true,
    retryDelay: 100,
  }
}

async function directoryEntries(path) {
  try {
    return await readdir(path, { withFileTypes: true })
  } catch (error) {
    if (error?.code === 'ENOENT') return []
    throw error
  }
}

async function removePath(path) {
  if (process.platform === 'win32') {
    await rm(path, removeOptions())
    return
  }

  let lastError
  for (let attempt = 1; attempt <= POSIX_REMOVE_ATTEMPTS; attempt += 1) {
    try {
      await new Promise((resolvePromise, reject) => {
        const child = spawn('/bin/rm', ['-rf', path], {
          stdio: ['ignore', 'ignore', 'pipe'],
        })
        let stderr = ''
        child.stderr.setEncoding('utf8')
        child.stderr.on('data', chunk => {
          stderr += chunk
        })
        child.once('error', reject)
        child.once('close', code => {
          if (code === 0) {
            resolvePromise()
            return
          }
          reject(
            new Error(`/bin/rm exited with code ${code ?? 'unknown'} for ${path}: ${stderr.trim()}`)
          )
        })
      })
      return
    } catch (error) {
      lastError = error
      if (attempt < POSIX_REMOVE_ATTEMPTS) {
        await new Promise(resolvePromise => setTimeout(resolvePromise, POSIX_REMOVE_RETRY_DELAY_MS))
      }
    }
  }
  throw lastError
}

function positiveProcessId(value) {
  return Number.isInteger(value) && value > 0 ? value : undefined
}

function normalizeActivity(activity, fallbackOwnerProcessId = process.pid) {
  if (typeof activity === 'number') {
    return { ownerProcessId: positiveProcessId(activity) ?? fallbackOwnerProcessId }
  }
  const applicationProcessId = positiveProcessId(activity?.applicationProcessId)
  const ownerProcessId = positiveProcessId(activity?.ownerProcessId) ?? fallbackOwnerProcessId
  return { applicationProcessId, ownerProcessId }
}

function parseActivity(value) {
  try {
    const parsed = JSON.parse(value)
    if (!parsed || typeof parsed !== 'object') return null
    const activity = normalizeActivity(parsed, null)
    return activity.applicationProcessId || activity.ownerProcessId ? activity : null
  } catch {
    const ownerProcessId = Number.parseInt(value.trim(), 10)
    return Number.isInteger(ownerProcessId) && ownerProcessId > 0 ? { ownerProcessId } : null
  }
}

function applicationProcessIsAlive(processId) {
  if (process.platform === 'win32') return processIsAlive(processId)
  return processGroupIsAlive(processId)
}

function isRecognizedResultDirectory(resultDirectory) {
  return RESULT_DIRECTORY_PATTERN.test(basename(resultDirectory))
}

function ownerProcessIdFromResultDirectory(resultDirectory) {
  const match = basename(resultDirectory).match(RESULT_DIRECTORY_PATTERN)
  return match ? Number.parseInt(match[1], 10) : null
}

async function activeProcesses(resultDirectory) {
  try {
    const activity = parseActivity(await readFile(join(resultDirectory, ACTIVE_MARKER), 'utf8'))
    if (activity) return activity
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return {
    ownerProcessId: ownerProcessIdFromResultDirectory(resultDirectory),
  }
}

function activityIsAlive(
  activity,
  { isApplicationAlive = applicationProcessIsAlive, isOwnerAlive = processIsAlive } = {}
) {
  if (activity.ownerProcessId && isOwnerAlive(activity.ownerProcessId)) return true
  return Boolean(activity.applicationProcessId && isApplicationAlive(activity.applicationProcessId))
}

async function removeNamedDirectories(root, names) {
  let removed = 0
  for (const entry of await directoryEntries(root)) {
    if (!entry.isDirectory()) continue
    const path = join(root, entry.name)
    if (names.has(entry.name)) {
      await removePath(path)
      removed += 1
      continue
    }
    removed += await removeNamedDirectories(path, names)
  }
  return removed
}

async function removeHarnessAppProfiles(userDataDirectory) {
  const instancesRoot = join(userDataDirectory, 'harness-apps', 'instances')
  let removed = 0
  for (const entry of await directoryEntries(instancesRoot)) {
    if (!entry.isDirectory()) continue
    const profiles = join(instancesRoot, entry.name, 'profiles')
    const entries = await directoryEntries(profiles)
    if (entries.length === 0) continue
    await removePath(profiles)
    removed += 1
  }
  return removed
}

async function compactElectronUserData(userDataDirectory) {
  let removed = 0
  const exactDirectories = [
    join(userDataDirectory, 'managed-runtimes'),
    join(userDataDirectory, 'dsh-core', 'profiles'),
  ]
  for (const directory of exactDirectories) {
    const entries = await directoryEntries(directory)
    if (entries.length === 0) continue
    await removePath(directory)
    removed += 1
  }
  removed += await removeHarnessAppProfiles(userDataDirectory)
  removed += await removeNamedDirectories(userDataDirectory, CACHE_DIRECTORY_NAMES)
  return removed
}

export function resolveDesktopE2EResultRoot(weworkDirectory, environment = process.env) {
  const configured = environment.WEWORK_E2E_RESULT_ROOT?.trim()
  return configured
    ? resolve(configured)
    : join(resolve(weworkDirectory), 'test-results', 'desktop-e2e')
}

export async function markDesktopE2EResultActive(
  resultDirectory,
  activity = { ownerProcessId: process.pid }
) {
  await writeFile(
    join(resultDirectory, ACTIVE_MARKER),
    `${JSON.stringify(normalizeActivity(activity))}\n`,
    'utf8'
  )
}

export async function clearDesktopE2EResultActive(resultDirectory) {
  await rm(join(resultDirectory, ACTIVE_MARKER), { force: true })
}

export async function compactDesktopE2EResult(resultDirectory) {
  let removed = 0
  for (const entry of await directoryEntries(resultDirectory)) {
    if (
      !TRANSIENT_TOP_LEVEL_ENTRIES.has(entry.name) &&
      !MACOS_APP_BUNDLE_PATTERN.test(entry.name)
    ) {
      continue
    }
    await removePath(join(resultDirectory, entry.name))
    removed += 1
  }
  removed += await compactElectronUserData(join(resultDirectory, 'electron-user-data'))
  return removed
}

export async function compactInactiveDesktopE2EResults(
  resultRoot,
  {
    isApplicationAlive = applicationProcessIsAlive,
    isProcessAlive: isOwnerAlive = processIsAlive,
  } = {}
) {
  let compacted = 0
  let removed = 0
  for (const entry of await directoryEntries(resultRoot)) {
    if (!entry.isDirectory()) continue
    const resultDirectory = join(resultRoot, entry.name)
    if (!isRecognizedResultDirectory(resultDirectory)) continue
    const activity = await activeProcesses(resultDirectory)
    if (activityIsAlive(activity, { isApplicationAlive, isOwnerAlive })) continue
    const removedFromResult = await compactDesktopE2EResult(resultDirectory)
    await clearDesktopE2EResultActive(resultDirectory)
    if (removedFromResult > 0) compacted += 1
    removed += removedFromResult
  }
  return { compacted, removed }
}
