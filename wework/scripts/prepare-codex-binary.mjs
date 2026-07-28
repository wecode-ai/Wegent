#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { chmod, cp, mkdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { pipeline } from 'node:stream/promises'
import { spawn } from 'node:child_process'

const scriptDir = dirname(fileURLToPath(import.meta.url))
const weworkDir = resolve(scriptDir, '..')
const lockPath = join(weworkDir, 'codex-binaries.lock.json')
const outputRoot = join(weworkDir, 'src-tauri', 'binaries', 'codex')
const cacheRoot = join(weworkDir, 'node_modules', '.cache', 'wework-codex')

const hostTargetByPlatform = {
  'darwin:arm64': 'aarch64-apple-darwin',
  'darwin:x64': 'x86_64-apple-darwin',
  'linux:x64': 'x86_64-unknown-linux-gnu',
  'linux:arm64': 'aarch64-unknown-linux-gnu',
  'win32:x64': 'x86_64-pc-windows-msvc',
}

function parseArgs(argv) {
  const result = { target: null, all: false }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--all') {
      result.all = true
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

async function integrityFile(path) {
  const hash = createHash('sha512')
  const input = await import('node:fs').then(fs => fs.createReadStream(path))
  for await (const chunk of input) {
    hash.update(chunk)
  }
  return `sha512-${hash.digest('base64')}`
}

async function download(url, destination) {
  const response = await fetch(url)
  if (!response.ok || !response.body) {
    throw new Error(`Failed to download ${url}: ${response.status} ${response.statusText}`)
  }
  await mkdir(dirname(destination), { recursive: true })
  await pipeline(response.body, createWriteStream(destination))
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.on('error', reject)
    child.on('exit', code => {
      if (code === 0) {
        resolvePromise()
      } else {
        reject(new Error(`${command} ${args.join(' ')} exited with ${code}`))
      }
    })
  })
}

async function extractTarball(tarball, destination) {
  await rm(destination, { recursive: true, force: true })
  await mkdir(destination, { recursive: true })
  await run('tar', ['-xzf', tarball, '-C', destination, '--strip-components', '1'])
}

async function prepareTarget(target, entry) {
  const tarballName = `${entry.package.replace('/', '-').replace('@', '')}-${entry.version}.tgz`
  const tarballPath = join(cacheRoot, tarballName)
  const targetRoot = join(outputRoot, target)
  const binaryPath = join(targetRoot, entry.binaryPath)
  const codeModeHostPath = join(
    dirname(binaryPath),
    target === 'x86_64-pc-windows-msvc' ? 'codex-code-mode-host.exe' : 'codex-code-mode-host'
  )

  if (!(await pathExists(tarballPath))) {
    console.log(`Downloading Codex ${entry.version} for ${target}`)
    await download(entry.tarball, tarballPath)
  }

  const actualIntegrity = await integrityFile(tarballPath)
  if (actualIntegrity !== entry.integrity) {
    await rm(tarballPath, { force: true })
    throw new Error(
      `Codex tarball integrity mismatch for ${target}: expected ${entry.integrity}, got ${actualIntegrity}`
    )
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
  await writeFile(
    join(targetRoot, 'WEGENT_CODEX_BINARY.json'),
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

main().catch(error => {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
})
