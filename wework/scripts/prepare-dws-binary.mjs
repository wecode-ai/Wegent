// SPDX-FileCopyrightText: 2026 Weibo, Inc.
// SPDX-License-Identifier: Apache-2.0

import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { arch, platform } from 'node:process'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import JSZip from 'jszip'

const require = createRequire(import.meta.url)
const packageJson = require.resolve('dingtalk-workspace-cli/package.json')
const packageRoot = dirname(packageJson)
const target =
  process.env.WEWORK_DWS_TARGET?.trim() ||
  {
    'darwin-arm64': 'aarch64-apple-darwin',
    'darwin-x64': 'x86_64-apple-darwin',
    'linux-x64': 'x86_64-unknown-linux-gnu',
    'linux-arm64': 'aarch64-unknown-linux-gnu',
    'win32-x64': 'x86_64-pc-windows-msvc',
  }[`${platform}-${arch}`]

if (!target) throw new Error(`Unsupported DWS build platform: ${platform}-${arch}`)

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
  const destination = resolve(
    'src-tauri',
    'binaries',
    `dws-${target}${isWindowsTarget ? '.exe' : ''}`
  )
  await mkdir(dirname(destination), { recursive: true })
  await copyFile(source, destination)
  if (!isWindowsTarget) await chmod(destination, 0o755)
  console.log(`Prepared DWS sidecar: ${destination}`)
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true })
}
