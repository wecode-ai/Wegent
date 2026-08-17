#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, cp, mkdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { extract } from 'tar'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const weworkDir = resolve(scriptDir, '..')
const lockPath = join(weworkDir, 'codex-binaries.lock.json')
const outputRoot = join(weworkDir, 'src-tauri', 'binaries', 'codex')
const legacyCacheRoot = join(weworkDir, 'node_modules', '.cache', 'wework-codex')
const DOWNLOAD_ATTEMPTS = 3
const DOWNLOAD_RETRY_DELAY_MS = 1_000

const hostTargetByPlatform = {
  'darwin:arm64': 'aarch64-apple-darwin',
  'darwin:x64': 'x86_64-apple-darwin',
  'linux:x64': 'x86_64-unknown-linux-gnu',
  'linux:arm64': 'aarch64-unknown-linux-gnu',
  'win32:x64': 'x86_64-pc-windows-msvc',
}

function parseArgs(argv) {
  const result = { target: null, all: false, materialize: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--all') {
      result.all = true
      continue
    }
    if (arg === '--materialize') {
      result.materialize = true
      continue
    }
    if (arg === '--target') {
      result.target = argv[index + 1]
      index += 1
      continue
    }
    if (arg.startsWith('--target=')) {
      result.target = arg.slice('--target='.length)
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }
  return result
}

function normalizeTarget(value) {
  if (!value) return null
  const trimmed = value.trim()
  if (!trimmed) return null
  if (trimmed === 'universal-apple-darwin') return trimmed
  if (trimmed === 'macos-arm64' || trimmed === 'darwin-arm64') return 'aarch64-apple-darwin'
  if (trimmed === 'macos-amd64' || trimmed === 'macos-x64' || trimmed === 'darwin-x64') {
    return 'x86_64-apple-darwin'
  }
  if (trimmed === 'linux-amd64' || trimmed === 'linux-x64') return 'x86_64-unknown-linux-gnu'
  if (trimmed === 'linux-arm64') return 'aarch64-unknown-linux-gnu'
  if (trimmed === 'windows-amd64' || trimmed === 'windows-x64' || trimmed === 'win32-x64') {
    return 'x86_64-pc-windows-msvc'
  }
  return trimmed
}

function hostTarget() {
  const target = hostTargetByPlatform[`${process.platform}:${process.arch}`]
  if (!target) {
    throw new Error(`Unsupported host platform: ${process.platform}/${process.arch}`)
  }
  return target
}

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function cacheRoot() {
  if (process.env.WEGENT_CODEX_CACHE_DIR) {
    return resolve(process.env.WEGENT_CODEX_CACHE_DIR)
  }

  if (process.platform === 'darwin') {
    return join(process.env.HOME || tmpdir(), 'Library', 'Caches', 'wegent', 'codex')
  }
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || process.env.USERPROFILE || tmpdir(), 'wegent', 'codex')
  }
  return join(
    process.env.XDG_CACHE_HOME || join(process.env.HOME || tmpdir(), '.cache'),
    'wegent',
    'codex'
  )
}

export function codexTarballName(entry, target) {
  const integrityKey = createHash('sha256').update(entry.integrity).digest('hex').slice(0, 16)
  return `codex-${entry.version}-${target}-${integrityKey}.tgz`
}

async function integrityFile(path) {
  const hash = createHash('sha512')
  const input = await import('node:fs').then(fs => fs.createReadStream(path))
  for await (const chunk of input) {
    hash.update(chunk)
  }
  return `sha512-${hash.digest('base64')}`
}

async function download(url, destination, fetchImpl) {
  const response = await fetchImpl(url)
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
  }
  await mkdir(dirname(destination), { recursive: true })
  await pipeline(response.body, createWriteStream(destination))
}

function sleep(delayMs) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, delayMs))
}

export async function downloadWithRetry(
  url,
  destination,
  {
    attempts = DOWNLOAD_ATTEMPTS,
    retryDelayMs = DOWNLOAD_RETRY_DELAY_MS,
    fetchImpl = fetch,
    sleepImpl = sleep,
  } = {}
) {
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new Error('Download attempts must be a positive integer')
  }

  let lastError
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    await rm(destination, { force: true })
    try {
      await download(url, destination, fetchImpl)
      return
    } catch (error) {
      lastError = error
      await rm(destination, { force: true })
      if (attempt === attempts) break
      console.warn(
        `Codex download attempt ${attempt}/${attempts} failed; retrying in ${retryDelayMs * attempt}ms`
      )
      await sleepImpl(retryDelayMs * attempt)
    }
  }

  throw lastError
}

async function extractTarball(tarball, destination) {
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  await extract({ file: tarball, cwd: destination, strip: 1 })
}

function shouldMaterializeTarget() {
  return process.env.WEWORK_CODEX_MATERIALIZE === '1'
}

async function ensureExtractedTarget(tarballPath, targetRoot, binaryPath, codeModeHostPath) {
  if ((await pathExists(binaryPath)) && (await pathExists(codeModeHostPath))) {
    return
  }
  await extractTarball(tarballPath, targetRoot)
  if (!(await pathExists(binaryPath))) {
    throw new Error(`Codex binary not found after extraction: ${binaryPath}`)
  }
  if (!(await pathExists(codeModeHostPath))) {
    throw new Error(`Codex code-mode host not found after extraction: ${codeModeHostPath}`)
  }
  if (process.platform !== 'win32') {
    await chmod(binaryPath, 0o755)
    await chmod(codeModeHostPath, 0o755)
  }
}

async function exposeTarget(targetRoot, outputTargetRoot) {
  await rm(outputTargetRoot, { recursive: true, force: true })
  await mkdir(dirname(outputTargetRoot), { recursive: true })
  if (shouldMaterializeTarget()) {
    await cp(targetRoot, outputTargetRoot, { recursive: true })
    return
  }
  await symlink(targetRoot, outputTargetRoot, process.platform === 'win32' ? 'junction' : 'dir')
}

async function downloadToCache(url, destination) {
  const temporaryPath = join(
    dirname(destination),
    `${basename(destination)}.${process.pid}.${Date.now()}.part`
  )
  try {
    await downloadWithRetry(url, temporaryPath)
    await mkdir(dirname(destination), { recursive: true })
    await rename(temporaryPath, destination)
  } finally {
    await rm(temporaryPath, { force: true })
  }
}

async function findLegacyTarball(paths) {
  const existingPaths = await Promise.all(
    paths.map(async path => ((await pathExists(path)) ? path : null))
  )
  return existingPaths.find(Boolean)
}

async function ensureTarballIntegrity(tarballPath, entry, target) {
  const actualIntegrity = await integrityFile(tarballPath)
  if (actualIntegrity === entry.integrity) return

  await rm(tarballPath, { force: true })
  console.log(`Cached Codex archive is invalid for ${target}; downloading a fresh copy`)
  await downloadToCache(entry.tarball, tarballPath)
  const refreshedIntegrity = await integrityFile(tarballPath)
  if (refreshedIntegrity !== entry.integrity) {
    await rm(tarballPath, { force: true })
    throw new Error(
      `Codex tarball integrity mismatch for ${target}: expected ${entry.integrity}, got ${refreshedIntegrity}`
    )
  }
}

async function prepareTarget(target, entry) {
  const sharedCacheRoot = cacheRoot()
  const tarballName = codexTarballName(entry, target)
  const tarballPath = join(sharedCacheRoot, tarballName)
  const extractedRoot = join(sharedCacheRoot, 'extracted', tarballName.replace(/\.tgz$/, ''))
  const legacyTarballPaths = [
    join(legacyCacheRoot, tarballName),
    join(
      legacyCacheRoot,
      `${entry.package.replace('/', '-').replace('@', '')}-${entry.version}.tgz`
    ),
  ]
  const outputTargetRoot = join(outputRoot, target)
  const targetRoot = extractedRoot
  const binaryPath = join(targetRoot, entry.binaryPath)
  const codeModeHostPath = join(
    dirname(binaryPath),
    target === 'x86_64-pc-windows-msvc' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host'
  )

  if (!(await pathExists(tarballPath))) {
    const legacyTarballPath = await findLegacyTarball(legacyTarballPaths)
    if (legacyTarballPath) {
      await mkdir(sharedCacheRoot, { recursive: true })
      await cp(legacyTarballPath, tarballPath)
      console.log(`Reused legacy Codex cache for ${target}`)
    }
  }

  if (!(await pathExists(tarballPath))) {
    console.log(`Downloading Codex ${entry.version} for ${target}`)
    await downloadToCache(entry.tarball, tarballPath)
  }

  await ensureTarballIntegrity(tarballPath, entry, target)

  await ensureExtractedTarget(tarballPath, targetRoot, binaryPath, codeModeHostPath)
  await exposeTarget(targetRoot, outputTargetRoot)
  await writeFile(
    join(outputTargetRoot, 'WEGENT_CODEX_BINARY.json'),
    `${JSON.stringify(
      {
        target,
        codexVersion: entry.version,
        binaryPath: entry.binaryPath,
        tarball: entry.tarball,
        integrity: entry.integrity,
      },
      null,
      2
    )}\n`
  )
  console.log(`Prepared Codex ${entry.version} for ${target}`)
}

async function copyLegalFiles() {
  const codexRepo = process.env.CODEX_SOURCE_DIR
  const legalDir = join(outputRoot, 'legal')
  const repoRoot = resolve(weworkDir, '..')
  const bundledNotice = join(weworkDir, 'third_party', 'codex', 'NOTICE')
  await rm(join(outputRoot, '.resource-placeholder'), { force: true })
  await mkdir(legalDir, { recursive: true })
  if (codexRepo && (await pathExists(join(codexRepo, 'LICENSE')))) {
    await cp(join(codexRepo, 'LICENSE'), join(legalDir, 'LICENSE'))
    if (await pathExists(join(codexRepo, 'NOTICE'))) {
      await cp(join(codexRepo, 'NOTICE'), join(legalDir, 'NOTICE'))
    }
    return
  }

  await cp(join(repoRoot, 'LICENSE'), join(legalDir, 'LICENSE'))
  await cp(bundledNotice, join(legalDir, 'NOTICE'))
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.materialize) {
    process.env.WEWORK_CODEX_MATERIALIZE = '1'
  }
  const lock = JSON.parse(
    await import('node:fs/promises').then(fs => fs.readFile(lockPath, 'utf8'))
  )
  const envTarget = normalizeTarget(
    process.env.WEWORK_CODEX_TARGET ||
      process.env.TAURI_TARGET_TRIPLE ||
      process.env.CARGO_BUILD_TARGET
  )
  const requestedTarget = normalizeTarget(args.target) || envTarget || hostTarget()
  const targets = args.all
    ? Object.keys(lock.targets)
    : requestedTarget === 'universal-apple-darwin'
      ? ['aarch64-apple-darwin', 'x86_64-apple-darwin']
      : [requestedTarget]

  for (const target of targets) {
    const entry = lock.targets[target]
    if (!entry) {
      throw new Error(`Unsupported Codex target: ${target}`)
    }
    await prepareTarget(target, entry)
  }
  await copyLegalFiles()
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
