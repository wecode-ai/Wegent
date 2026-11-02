import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PRODUCT_NAME = 'WeWork'
const INSTALL_TIMEOUT_MS = 5 * 60_000
const UNINSTALL_TIMEOUT_MS = 2 * 60_000
const REQUIRED_INSTALLED_PATHS = [
  'WeWork.exe',
  'resources/app.asar',
  'resources/bin/wegent-executor.exe',
  'resources/bin/wegent-backend-rs.exe',
  'resources/codex/WEGENT_CODEX_BINARY.json',
  'resources/bundled-plugins/wework-personal/.claude-plugin/marketplace.json',
]

const scriptRoot = dirname(fileURLToPath(import.meta.url))
const weworkRoot = resolve(scriptRoot, '..', '..')

if (process.platform !== 'win32') {
  throw new Error('The Windows installer E2E must run on Windows')
}

const installer = await resolveInstaller()
const temporaryRoot = join(tmpdir(), `wework-windows-installer-e2e-${process.pid}-${Date.now()}`)
const alternateDriveRoot = join(temporaryRoot, 'alternate-drive')
const driveLetter = await findAvailableDriveLetter()
const installDirectory = `${driveLetter}:\\${PRODUCT_NAME}`
const applicationPath = join(installDirectory, 'WeWork.exe')
const uninstallerPath = join(installDirectory, `Uninstall ${PRODUCT_NAME}.exe`)
let alternateDriveCreated = false
let uninstalled = false

console.log(`[windows-installer-e2e] installer: ${installer}`)
console.log(`[windows-installer-e2e] target: ${installDirectory}`)

try {
  await mkdir(alternateDriveRoot, { recursive: true })
  runChecked('subst.exe', [`${driveLetter}:`, alternateDriveRoot], 'create alternate drive')
  alternateDriveCreated = true

  runInstaller(installer, installDirectory, INSTALL_TIMEOUT_MS)
  for (const relativePath of REQUIRED_INSTALLED_PATHS) {
    await waitForPath(join(installDirectory, relativePath), `install ${relativePath}`)
  }
  await assertUninstallEntry(installDirectory)
  await waitForPath(uninstallerPath, 'install the uninstaller')
  console.log('[windows-installer-e2e] alternate-drive installation verified')

  runInstaller(uninstallerPath, undefined, UNINSTALL_TIMEOUT_MS)
  await waitForMissingPath(applicationPath, 'remove the installed application')
  await waitForUninstallEntryRemoval(installDirectory)
  uninstalled = true
  console.log('[windows-installer-e2e] alternate-drive uninstallation verified')
} finally {
  if (!uninstalled && existsSync(uninstallerPath)) {
    try {
      runInstaller(uninstallerPath, undefined, UNINSTALL_TIMEOUT_MS)
      await waitForMissingPath(applicationPath, 'remove the partially installed application')
    } catch (error) {
      console.error(
        `[windows-installer-e2e] cleanup uninstall failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }
  if (alternateDriveCreated) {
    const cleanup = spawnSync('subst.exe', [`${driveLetter}:`, '/D'], {
      encoding: 'utf8',
      windowsHide: true,
    })
    if (cleanup.error || cleanup.status !== 0) {
      console.error(
        `[windows-installer-e2e] failed to remove temporary drive ${driveLetter}: ${
          cleanup.error?.message ?? cleanup.stderr.trim()
        }`
      )
    }
  }
  try {
    await rm(temporaryRoot, { recursive: true, force: true })
  } catch (error) {
    console.error(
      `[windows-installer-e2e] failed to remove temporary directory: ${
        error instanceof Error ? error.message : String(error)
      }`
    )
  }
}

async function resolveInstaller() {
  const configured = process.env.WEWORK_E2E_WINDOWS_INSTALLER?.trim() || process.argv[2]?.trim()
  const candidate = resolve(configured || join(weworkRoot, 'electron', 'release-installer'))
  if (!existsSync(candidate)) {
    throw new Error(`Windows installer path does not exist: ${candidate}`)
  }
  const metadata = await stat(candidate)
  if (metadata.isFile()) return candidate

  const installers = (await readdir(candidate))
    .filter(name => /-setup\.exe$/i.test(name))
    .map(name => join(candidate, name))
  if (installers.length !== 1) {
    throw new Error(
      `Expected exactly one Windows installer in ${candidate}, found ${installers.length}`
    )
  }
  return installers[0]
}

async function findAvailableDriveLetter() {
  const used = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "(Get-PSDrive -PSProvider FileSystem).Name -join ','",
    ],
    { encoding: 'utf8', windowsHide: true }
  )
    .trim()
    .toUpperCase()
    .split(',')
  const available = [...'ZYXWVUTSRQPONMLKJIHGFED'].find(letter => !used.includes(letter))
  if (!available) throw new Error('No free drive letter is available for installer E2E')
  return available
}

function runInstaller(path, targetDirectory, timeout) {
  const args = targetDirectory ? ['/S', `/D=${targetDirectory}`] : ['/S']
  console.log(`[windows-installer-e2e] run ${basename(path)} ${args.join(' ')}`)
  const result = spawnSync(path, args, {
    encoding: 'utf8',
    timeout,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `${basename(path)} exited with ${result.status}: ${result.stderr || result.stdout}`
    )
  }
}

async function assertUninstallEntry(expectedDirectory) {
  const entry = await waitForUninstallEntry(expectedDirectory)
  assert.ok(entry.UninstallString, 'The installer must register an uninstall command')
  assert.ok(entry.QuietUninstallString, 'The installer must register a quiet uninstall command')
  assert.match(
    entry.UninstallString,
    /Uninstall WeWork\.exe/i,
    'The registered uninstall command must target the application uninstaller'
  )
}

async function waitForUninstallEntry(expectedDirectory) {
  return waitFor(
    async () => {
      const entry = await findUninstallEntry()
      return entry &&
        normalizeWindowsPath(entry.InstallLocation) === normalizeWindowsPath(expectedDirectory)
        ? entry
        : null
    },
    `register ${expectedDirectory} as the installation directory`,
    30_000
  )
}

async function waitForUninstallEntryRemoval(expectedDirectory) {
  await waitFor(
    async () => {
      const entries = await readUninstallEntries()
      return entries.every(
        entry =>
          normalizeWindowsPath(entry.InstallLocation) !== normalizeWindowsPath(expectedDirectory)
      )
        ? true
        : null
    },
    `remove the uninstall entry for ${expectedDirectory}`,
    30_000
  )
}

async function findUninstallEntry() {
  const entries = await readUninstallEntries()
  return entries.find(entry => /^WeWork(?:\s|$)/i.test(entry.DisplayName ?? '')) ?? null
}

async function readUninstallEntries() {
  const output = execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      [
        '$roots = @(',
        "  'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',",
        "  'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall'",
        ')',
        '$entries = $roots | ForEach-Object {',
        '  Get-ChildItem $_ -ErrorAction SilentlyContinue',
        '} |',
        '  ForEach-Object { Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue } |',
        "  Where-Object { $_.DisplayName -like 'WeWork*' }",
        '$entries | Select-Object DisplayName, InstallLocation, UninstallString, QuietUninstallString',
        '  | ConvertTo-Json -Compress',
      ].join(' '),
    ],
    { encoding: 'utf8', windowsHide: true }
  ).trim()
  if (!output) return []
  const parsed = JSON.parse(output)
  return Array.isArray(parsed) ? parsed : [parsed]
}

async function waitForPath(path, action) {
  await waitFor(async () => (existsSync(path) ? true : null), `${action}: ${path}`, 30_000)
}

async function waitForMissingPath(path, action) {
  await waitFor(async () => (existsSync(path) ? null : true), `${action}: ${path}`, 30_000)
}

async function waitFor(predicate, description, timeoutMs) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    const result = await predicate()
    if (result) return result
    await new Promise(resolvePromise => setTimeout(resolvePromise, 250))
  }
  throw new Error(`Timed out waiting to ${description}`)
}

function normalizeWindowsPath(value) {
  return (value ?? '').replaceAll('/', '\\').replace(/\\+$/, '').toLowerCase()
}

function runChecked(command, args, description) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(
      `Failed to ${description}: ${result.stderr?.trim() || result.stdout?.trim() || result.status}`
    )
  }
}
