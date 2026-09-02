import { spawn } from 'node:child_process'
import { readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'

const ACTIVE_MARKER = '.active'
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
  await new Promise((resolvePromise, reject) => {
    const child = spawn('/bin/rm', ['-rf', path], { stdio: 'ignore' })
    child.once('error', reject)
    child.once('close', code => {
      if (code === 0) resolvePromise()
      else reject(new Error(`/bin/rm exited with code ${code ?? 'unknown'} for ${path}`))
    })
  })
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

export async function markDesktopE2EResultActive(resultDirectory, processId = process.pid) {
  await writeFile(join(resultDirectory, ACTIVE_MARKER), `${processId}\n`, 'utf8')
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

function processIdFromResultDirectory(resultDirectory) {
  const match = basename(resultDirectory).match(/-(\d+)$/)
  return match ? Number.parseInt(match[1], 10) : null
}

async function activeProcessId(resultDirectory) {
  try {
    const value = (await readFile(join(resultDirectory, ACTIVE_MARKER), 'utf8')).trim()
    const processId = Number.parseInt(value, 10)
    if (Number.isInteger(processId) && processId > 0) return processId
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return processIdFromResultDirectory(resultDirectory)
}

function processIsAlive(processId) {
  try {
    process.kill(processId, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    throw error
  }
}

export async function compactInactiveDesktopE2EResults(
  resultRoot,
  { isProcessAlive = processIsAlive } = {}
) {
  let compacted = 0
  let removed = 0
  for (const entry of await directoryEntries(resultRoot)) {
    if (!entry.isDirectory()) continue
    const resultDirectory = join(resultRoot, entry.name)
    const processId = await activeProcessId(resultDirectory)
    if (processId && isProcessAlive(processId)) continue
    const removedFromResult = await compactDesktopE2EResult(resultDirectory)
    await clearDesktopE2EResultActive(resultDirectory)
    if (removedFromResult > 0) compacted += 1
    removed += removedFromResult
  }
  return { compacted, removed }
}
