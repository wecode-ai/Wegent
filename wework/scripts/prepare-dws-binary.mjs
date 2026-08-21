// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { chmod, copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { arch, platform } from 'node:process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'

const require = createRequire(import.meta.url)
const packageJson = require.resolve('dingtalk-workspace-cli/package.json')
const packageRoot = dirname(packageJson)
const rustHostTarget = () => {
  const result = spawnSync('rustc', ['-vV'], { encoding: 'utf8' })
  if (result.status !== 0) return null
  return result.stdout.match(/^host:\s*(\S+)$/m)?.[1] ?? null
}
const detectedTarget =
  platform === 'darwin'
    ? rustHostTarget()
    : {
        'linux-x64': 'x86_64-unknown-linux-gnu',
        'linux-arm64': 'aarch64-unknown-linux-gnu',
        'win32-x64': 'x86_64-pc-windows-msvc',
      }[`${platform}-${arch}`]
const target = process.env.WEWORK_DWS_TARGET?.trim() || detectedTarget

if (!target) {
  throw new Error(
    `Unsupported DWS build platform: ${platform}-${arch}. Set WEWORK_DWS_TARGET explicitly.`
  )
}

const archives = {
  'aarch64-apple-darwin': 'dws-darwin-arm64.tar.gz',
  'x86_64-apple-darwin': 'dws-darwin-amd64.tar.gz',
  'x86_64-unknown-linux-gnu': 'dws-linux-amd64.tar.gz',
  'aarch64-unknown-linux-gnu': 'dws-linux-arm64.tar.gz',
  'x86_64-pc-windows-msvc': 'dws-windows-amd64.zip',
}
const sourceTargets =
  target === 'universal-apple-darwin' ? ['aarch64-apple-darwin', 'x86_64-apple-darwin'] : [target]
if (sourceTargets.some(sourceTarget => !archives[sourceTarget])) {
  throw new Error(`Unsupported DWS target: ${target}`)
}
const isWindowsTarget = target.includes('windows')
const executable = isWindowsTarget ? 'dws.exe' : 'dws'
const temporaryDirectory = await mkdtemp(join(tmpdir(), 'wework-dws-'))

async function findBinary(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      const nested = await findBinary(path)
      if (nested) return nested
    } else if (entry.name === executable) {
      return path
    }
  }
  return null
}

function extractArchive(archive, destination) {
  const isZip = archive.endsWith('.zip')
  if (process.platform === 'win32') {
    if (isZip) {
      const result = spawnSync('tar', ['-xf', archive, '-C', destination], { stdio: 'inherit' })
      if (result.status !== 0) throw new Error(`Failed to extract ${archive}`)
      return
    }
    const result = spawnSync('tar', ['-xzf', archive, '-C', destination], { stdio: 'inherit' })
    if (result.status !== 0) throw new Error(`Failed to extract ${archive}`)
    return
  }

  const command = isZip ? 'unzip' : 'tar'
  const args = isZip ? ['-q', archive, '-d', destination] : ['-xzf', archive, '-C', destination]
  const result = spawnSync(command, args, { stdio: 'inherit' })
  if (result.status !== 0) throw new Error(`Failed to extract ${archive}`)
}

try {
  const sources = []
  for (const sourceTarget of sourceTargets) {
    const archiveName = archives[sourceTarget]
    const archive = join(packageRoot, 'assets', archiveName)
    const extractDirectory = join(temporaryDirectory, sourceTarget)
    await mkdir(extractDirectory, { recursive: true })
    extractArchive(archive, extractDirectory)
    const source = await findBinary(extractDirectory)
    if (!source) throw new Error(`DWS binary is missing from ${archiveName}`)
    sources.push(source)
  }
  const destination = resolve(
    'src-tauri',
    'binaries',
    `dws-${target}${isWindowsTarget ? '.exe' : ''}`
  )
  await mkdir(dirname(destination), { recursive: true })
  if (sources.length === 1) {
    await copyFile(sources[0], destination)
  } else {
    const result = spawnSync('lipo', ['-create', ...sources, '-output', destination], {
      stdio: 'inherit',
    })
    if (result.status !== 0) throw new Error('Failed to create universal DWS binary')
  }
  await rm(destination.replace(/(?:\.exe)?$/, '.debug-stub'), { force: true })
  if (!isWindowsTarget) await chmod(destination, 0o755)
  console.log(`Prepared DWS sidecar: ${destination}`)
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
