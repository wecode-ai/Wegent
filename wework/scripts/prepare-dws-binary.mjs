// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import {
  access,
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { createRequire } from 'node:module'
import { arch, platform } from 'node:process'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import JSZip from 'jszip'

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
const archiveName = archives[target]
if (!archiveName) throw new Error(`Unsupported DWS target: ${target}`)
const isWindowsTarget = target.includes('windows')
const executable = isWindowsTarget ? 'dws.exe' : 'dws'
const destination = resolve(
  'src-tauri',
  'binaries',
  `dws-${target}${isWindowsTarget ? '.exe' : ''}`
)
const useSharedCache = process.env.WEWORK_DWS_SHARED_CACHE === '1'

async function pathExists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function sharedCachePath() {
  const packageManifest = JSON.parse(await readFile(packageJson, 'utf8'))
  const root =
    process.env.WEWORK_RUNTIME_CACHE_DIR?.trim() ||
    join(process.env.XDG_CACHE_HOME?.trim() || join(homedir(), '.cache'), 'wegent', 'wework-runtime')
  return join(root, 'dws', `${packageManifest.version}-${target}`, executable)
}

async function exposeSharedBinary(sharedBinary) {
  await mkdir(dirname(destination), { recursive: true })
  await rm(destination, { force: true })
  await symlink(sharedBinary, destination, 'file')
  console.log(`Prepared shared DWS sidecar: ${destination} -> ${sharedBinary}`)
}

if (useSharedCache) {
  const sharedBinary = await sharedCachePath()
  if (await pathExists(sharedBinary)) {
    await exposeSharedBinary(sharedBinary)
    process.exit(0)
  }
}

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

async function extractZip(archive, destination) {
  const zip = await JSZip.loadAsync(await readFile(archive))
  await Promise.all(
    Object.values(zip.files).map(async entry => {
      const output = join(destination, entry.name)
      if (entry.dir) {
        await mkdir(output, { recursive: true })
        return
      }
      await mkdir(dirname(output), { recursive: true })
      await writeFile(output, await entry.async('nodebuffer'))
    })
  )
}

try {
  const archive = join(packageRoot, 'assets', archiveName)
  if (archiveName.endsWith('.zip')) {
    await extractZip(archive, temporaryDirectory)
  } else {
    const result = spawnSync('tar', ['-xzf', archive, '-C', temporaryDirectory], {
      stdio: 'inherit',
    })
    if (result.status !== 0) throw new Error(`Failed to extract ${archiveName}`)
  }
  const source = await findBinary(temporaryDirectory)
  if (!source) throw new Error(`DWS binary is missing from ${archiveName}`)
  if (useSharedCache) {
    const sharedBinary = await sharedCachePath()
    const temporarySharedBinary = `${sharedBinary}.${process.pid}.tmp`
    await mkdir(dirname(sharedBinary), { recursive: true })
    await copyFile(source, temporarySharedBinary)
    if (!isWindowsTarget) await chmod(temporarySharedBinary, 0o755)
    await rename(temporarySharedBinary, sharedBinary)
    await exposeSharedBinary(sharedBinary)
  } else {
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(source, destination)
    await rm(destination.replace(/(?:\.exe)?$/, '.debug-stub'), { force: true })
    if (!isWindowsTarget) await chmod(destination, 0o755)
    console.log(`Prepared DWS sidecar: ${destination}`)
  }
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
