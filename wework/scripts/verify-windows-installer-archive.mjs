#!/usr/bin/env node

// The NSIS extractor shipped with electron-builder cannot decode the ARM64 BCJ
// filter that 7-Zip applies to ARM64 binaries by default. When that happens the
// installer silently skips every exe and dll, so a guard is the only way to
// catch the regression before users receive a broken installer.

import { execFile } from 'node:child_process'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const ARM64_FILTER = '0A'
const INSTALLER_PATTERN = /_windows_arm64-setup\.exe$/
const EMBEDDED_ARCHIVE = '$PLUGINSDIR/app-arm64.7z'

/**
 * Return the archive entries that use the ARM64 BCJ filter (`Method = 0A ...`).
 */
export function arm64FilteredEntries(listing) {
  const entries = []
  let path = null
  let inEntries = false
  for (const line of listing.split(/\r?\n/)) {
    if (/^-{5,}$/.test(line)) {
      inEntries = true
      continue
    }
    if (!inEntries) continue
    if (line.startsWith('Path = ')) {
      path = line.slice('Path = '.length)
      continue
    }
    if (line.startsWith('Method = ')) {
      const method = line.slice('Method = '.length).trim()
      if (path && method.split(' ')[0] === ARM64_FILTER) entries.push(path)
      path = null
    }
  }
  return entries
}

export async function findSevenZip(environment = process.env) {
  const configured = environment.SEVEN_ZIP?.trim()
  if (configured) return configured
  const candidates =
    process.platform === 'win32'
      ? ['7z', join(environment.ProgramFiles || 'C:\\Program Files', '7-Zip', '7z.exe')]
      : ['7z', '7zz']
  for (const candidate of candidates) {
    try {
      await execFileAsync(candidate, ['i'], { maxBuffer: 1024 * 1024 })
      return candidate
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error('7-Zip is required to verify the Windows arm64 installer archive')
}

export async function verifyWindowsArm64Installer(installer, sevenZip) {
  const workDirectory = await mkdtemp(join(tmpdir(), 'wework-arm64-archive-'))
  try {
    await execFileAsync(sevenZip, ['e', '-y', `-o${workDirectory}`, installer, EMBEDDED_ARCHIVE], {
      maxBuffer: 16 * 1024 * 1024,
    })
    const archive = join(workDirectory, 'app-arm64.7z')
    const { stdout } = await execFileAsync(sevenZip, ['l', '-slt', archive], {
      maxBuffer: 64 * 1024 * 1024,
    })
    const filtered = arm64FilteredEntries(stdout)
    if (filtered.length > 0) {
      const sample = filtered.slice(0, 5).join(', ')
      throw new Error(
        `${basename(installer)} packs ${filtered.length} entries with the ARM64 BCJ filter, which the NSIS extractor cannot decode (${sample}). Set ELECTRON_BUILDER_7Z_FILTER=BCJ for Windows arm64 builds.`
      )
    }
    return filtered.length
  } finally {
    await rm(workDirectory, { recursive: true, force: true })
  }
}

async function main() {
  const [target] = process.argv.slice(2)
  if (!target) {
    throw new Error(
      'Usage: verify-windows-installer-archive.mjs <release-assets-directory|installer.exe>'
    )
  }
  const resolved = resolve(target)
  const installers = target.endsWith('.exe')
    ? [resolved]
    : (await readdir(resolved))
        .filter(name => INSTALLER_PATTERN.test(name))
        .sort()
        .map(name => join(resolved, name))
  if (installers.length === 0) {
    throw new Error(`No Windows arm64 installer found in ${resolved}`)
  }
  const sevenZip = await findSevenZip()
  for (const installer of installers) {
    await verifyWindowsArm64Installer(installer, sevenZip)
    console.log(`Verified ${basename(installer)}: no ARM64 BCJ entries`)
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  })
}
