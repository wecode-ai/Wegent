import assert from 'node:assert/strict'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { appendFile, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, dirname, join, parse, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { waitForColdPackageStartup } from './modules/cold-package-startup.mjs'
import { DesktopE2EServer } from './modules/desktop-server.mjs'
import { resolveElectronLaunchArguments } from './modules/electron-launch-arguments.mjs'
import { upgradeUserEnvironment } from './modules/upgrade-user-environment.mjs'
import { stopProcessGroup } from './process-lifecycle.mjs'
import { appendProcessOutput } from './process-output.mjs'

const PRODUCT_NAME = 'WeWork'
const INSTALL_TIMEOUT_MS = 6 * 60_000
const UNINSTALL_TIMEOUT_MS = 2 * 60_000
const STARTUP_PHASE_TIMEOUT_MS = 180_000
const REQUIRED_INSTALLED_PATHS = [
  'WeWork.exe',
  'resources/app.asar',
  'resources/bin/wegent-executor.exe',
  'resources/bin/wegent-backend-rs.exe',
  'resources/codex/WEGENT_CODEX_BINARY.json',
  'resources/components.json',
  'resources/bundled-plugins.tar.gz',
  'resources/wework-core-plugins.tar.gz',
  'resources/wework-app-static.tar.gz',
]

const scriptRoot = dirname(fileURLToPath(import.meta.url))
const weworkRoot = resolve(scriptRoot, '..', '..')

if (process.platform !== 'win32') {
  throw new Error('The Windows installer E2E must run on Windows')
}

const installer = await resolveInstaller()
const temporaryRoot = join(tmpdir(), `wework-windows-installer-e2e-${process.pid}-${Date.now()}`)
const resultDirectory = join(weworkRoot, 'test-results', 'desktop-e2e', 'windows-installer')
const installDirectory = join(resultDirectory, 'installation', 'WeWork custom install')
const cancelledDirectory = join(resultDirectory, 'installation', 'WeWork cancelled install')
const applicationPath = join(installDirectory, 'WeWork.exe')
const uninstallerPath = join(installDirectory, `Uninstall ${PRODUCT_NAME}.exe`)
let uninstalled = false
const evidence = {
  sourceSha: execFileSync(
    'git',
    ['-c', `safe.directory=${resolve(weworkRoot, '..')}`, 'rev-parse', 'HEAD'],
    {
      cwd: weworkRoot,
      encoding: 'utf8',
      windowsHide: true,
    }
  ).trim(),
  installer: { filename: basename(installer), sha256: await sha256(installer) },
  startedAt: new Date().toISOString(),
}

console.log(`[windows-installer-e2e] installer: ${installer}`)
console.log(`[windows-installer-e2e] target: ${installDirectory}`)

try {
  await mkdir(resultDirectory, { recursive: true })
  evidence.user = readStandardUser()
  evidence.target = assertOtherDrive(installDirectory)
  assert.equal(existsSync(installDirectory), false, 'The install target must start empty')
  assert.equal(existsSync(cancelledDirectory), false, 'The cancellation target must start empty')
  assert.equal((await readUninstallEntries()).length, 0, 'The test user must have no prior install')
  assert.deepEqual(readShortcuts(), [], 'The test user must have no prior WeWork shortcuts')
  await mkdir(dirname(installDirectory), { recursive: true })

  evidence.cancel = await runInstallerUi('Cancel', cancelledDirectory)
  await assertNoInstallation(cancelledDirectory)
  evidence.cancel.cleaned = true
  console.log('[windows-installer-e2e] directory-page cancellation cleanup verified')

  evidence.install = await runInstallerUi('Install', installDirectory)
  for (const relativePath of REQUIRED_INSTALLED_PATHS) {
    await waitForPath(join(installDirectory, relativePath), `install ${relativePath}`)
  }
  evidence.install.uninstallEntry = await assertUninstallEntry(installDirectory)
  await waitForPath(uninstallerPath, 'install the uninstaller')
  evidence.install.shortcuts = readShortcuts()
  assert.equal(
    evidence.install.shortcuts.length,
    2,
    'Install must create desktop and Start menu shortcuts'
  )
  for (const shortcut of evidence.install.shortcuts) {
    assert.equal(normalizeWindowsPath(shortcut.target), normalizeWindowsPath(applicationPath))
  }
  evidence.startup = await launchInstalledApplication()
  console.log('[windows-installer-e2e] application installed on another drive and launched')

  runUninstaller()
  await assertNoInstallation(installDirectory)
  evidence.uninstall = { cleaned: true }
  uninstalled = true
  evidence.passed = true
  console.log('[windows-installer-e2e] alternate-drive uninstallation verified')
} catch (error) {
  evidence.passed = false
  evidence.error = error instanceof Error ? error.message : String(error)
  throw error
} finally {
  if (!uninstalled && existsSync(uninstallerPath)) {
    try {
      runUninstaller()
      await waitForMissingPath(applicationPath, 'remove the partially installed application')
    } catch (error) {
      console.error(
        `[windows-installer-e2e] cleanup uninstall failed: ${
          error instanceof Error ? error.message : String(error)
        }`
      )
    }
  }
  evidence.finishedAt = new Date().toISOString()
  await mkdir(resultDirectory, { recursive: true })
  await writeFile(join(resultDirectory, 'evidence.json'), `${JSON.stringify(evidence, null, 2)}\n`)
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

function runUninstaller() {
  console.log('[windows-installer-e2e] run the installed uninstaller')
  const result = spawnSync(uninstallerPath, ['/S'], {
    encoding: 'utf8',
    timeout: UNINSTALL_TIMEOUT_MS,
    windowsHide: true,
  })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`Uninstaller exited with ${result.status}: ${result.stderr || result.stdout}`)
  }
}

async function assertUninstallEntry(expectedDirectory) {
  const entry = await waitForUninstallEntry(expectedDirectory)
  assert.equal(
    (await readUninstallEntries()).length,
    1,
    'Install must register exactly one product'
  )
  assert.match(entry.InstallRegistryPath, /^HKCU:\\/i, 'Install must use the current user hive')
  assert.ok(entry.UninstallString, 'The installer must register an uninstall command')
  assert.ok(entry.QuietUninstallString, 'The installer must register a quiet uninstall command')
  const expectedUninstaller = join(expectedDirectory, `Uninstall ${PRODUCT_NAME}.exe`)
  for (const command of [entry.UninstallString, entry.QuietUninstallString]) {
    const executable = command.match(/^"([^"]+)"(?:\s|$)/)?.[1]
    assert.equal(
      normalizeWindowsPath(executable),
      normalizeWindowsPath(expectedUninstaller),
      'Both uninstall commands must target the installed uninstaller'
    )
    assert.match(command, /\/currentuser\b/i, 'The installation must belong to the standard user')
  }
  assert.match(entry.QuietUninstallString, /\/S\b/)
  return entry
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
      return entries.length === 0 ? true : null
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
        '$entries = foreach ($root in $roots) {',
        "  $software = $root.Split('\\')[0] + '\\Software'",
        '  foreach ($key in (Get-ChildItem $root -ErrorAction SilentlyContinue)) {',
        '    $entry = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue',
        "    if ($entry.DisplayName -notlike 'WeWork*') { continue }",
        // electron-builder stores InstallLocation separately from its uninstall commands.
        '    $installKey = Join-Path $software $key.PSChildName',
        '    $install = Get-ItemProperty $installKey -ErrorAction SilentlyContinue',
        '    [PSCustomObject]@{',
        '      DisplayName = $entry.DisplayName',
        '      InstallLocation = $install.InstallLocation',
        '      InstallRegistryPath = $installKey',
        '      UninstallRegistryPath = $key.PSPath',
        '      UninstallString = $entry.UninstallString',
        '      QuietUninstallString = $entry.QuietUninstallString',
        '    }',
        '  }',
        '}',
        '$entries | ConvertTo-Json -Compress',
      ].join('\n'),
    ],
    { encoding: 'utf8', windowsHide: true }
  ).trim()
  const parsed = output ? JSON.parse(output) : []
  const entries = Array.isArray(parsed) ? parsed : [parsed]
  evidence.lastUninstallEntries = entries
  return entries
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

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

function readStandardUser() {
  const user = runPowerShell([
    '$identity = [Security.Principal.WindowsIdentity]::GetCurrent()',
    '$principal = [Security.Principal.WindowsPrincipal]::new($identity)',
    '@{ name = $identity.Name; sid = $identity.User.Value;',
    '  administrator = $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
    '} | ConvertTo-Json -Compress',
  ])
  assert.equal(user.administrator, false, 'Installer E2E must run as a standard user')
  return user
}

function assertOtherDrive(directory) {
  const systemDrive = process.env.SystemDrive
  assert.match(systemDrive ?? '', /^[a-z]:$/i, 'Windows must expose its system drive')
  const targetDrive = parse(directory).root.slice(0, 2)
  assert.match(targetDrive, /^[a-z]:$/i)
  assert.notEqual(
    targetDrive.toLowerCase(),
    systemDrive.toLowerCase(),
    'Installer E2E requires a real workspace volume other than the Windows system drive'
  )
  const volume = runPowerShell([
    `Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${targetDrive}'" |`,
    '  Select-Object DeviceID, DriveType | ConvertTo-Json -Compress',
  ])
  assert.equal(volume?.DriveType, 3, 'The target must be a real local disk, not a mapped drive')
  return { systemDrive, targetDrive, directory, driveType: volume.DriveType }
}

async function runInstallerUi(action, directory) {
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      join(scriptRoot, 'modules', 'windows-installer-ui.ps1'),
      '-InstallerPath',
      installer,
      '-InstallDirectory',
      directory,
      '-Action',
      action,
    ],
    { encoding: 'utf8', timeout: INSTALL_TIMEOUT_MS, windowsHide: false }
  )
  await appendFile(
    join(resultDirectory, 'ui-helper.log'),
    `[${action}]\n${result.stdout ?? ''}${result.stderr ?? ''}\n`
  )
  if (result.stderr) process.stderr.write(result.stderr)
  if (result.error) throw result.error
  assert.equal(result.status, 0, `${action} UI failed: ${result.stderr || result.stdout}`)
  const proof = JSON.parse(result.stdout.trim())
  assert.equal(proof.action, action)
  assert.equal(proof.directoryPageVisited, true, 'The interactive directory page must be visited')
  assert.equal(normalizeWindowsPath(proof.selectedDirectory), normalizeWindowsPath(directory))
  assert.equal(proof.completed, true)
  return proof
}

function runPowerShell(lines) {
  const output = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', lines.join('\n')],
    { encoding: 'utf8', windowsHide: true }
  ).trim()
  return output ? JSON.parse(output) : null
}

function readShortcuts() {
  const shortcuts = runPowerShell([
    '$shell = New-Object -ComObject WScript.Shell',
    "$folders = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('Programs'))",
    '$shortcuts = @($folders | ForEach-Object {',
    "  $path = Join-Path $_ 'WeWork.lnk'",
    '  if (Test-Path -LiteralPath $path) {',
    '    @{ path = $path; target = $shell.CreateShortcut($path).TargetPath }',
    '  }',
    '})',
    'ConvertTo-Json -InputObject $shortcuts -Compress',
  ])
  assert.ok(Array.isArray(shortcuts), 'Shortcut inspection must return a list')
  return shortcuts
}

async function assertNoInstallation(directory) {
  await waitForMissingPath(directory, 'remove the installation directory')
  await waitForUninstallEntryRemoval(directory)
  assert.deepEqual(await readUninstallEntries(), [], 'No WeWork uninstall registration may remain')
  assert.deepEqual(readShortcuts(), [], 'No desktop or Start menu shortcut may remain')
  const installKey = evidence.install?.uninstallEntry?.InstallRegistryPath
  if (installKey) {
    await waitFor(
      async () => {
        const exists = runPowerShell([
          `$path = '${installKey.replaceAll("'", "''")}'`,
          'ConvertTo-Json -InputObject (Test-Path -LiteralPath $path) -Compress',
        ])
        return exists ? null : true
      },
      'remove the application installation registry key',
      30_000
    )
  }
}

function installedAppEnvironment(home, control) {
  const environment = upgradeUserEnvironment(process.env, home)
  for (const key of Object.keys(environment)) {
    if (key.startsWith('WEWORK_E2E_') || key === 'VITE_WEWORK_E2E') delete environment[key]
  }
  return {
    ...environment,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    WEWORK_USER_DATA_DIR: join(home, 'electron'),
    WEWORK_APP_CONFIG_DIR: join(home, 'app-config'),
    WEGENT_CODEX_HOME: join(home, 'codex'),
    WEGENT_EXECUTOR_HOME: join(home, 'executor'),
    WORKSPACE_ROOT: join(home, 'workspace'),
    WEGENT_EXECUTOR_LOG_DIR: resultDirectory,
    WEGENT_EXECUTOR_LOG_FILE: 'executor.log',
    DEVICE_SESSION_GATEWAY_HOST: '127.0.0.1',
    DEVICE_SESSION_GATEWAY_PORT: '0',
    WEWORK_EXECUTOR_ISOLATION_OVERRIDE: 'false',
    VITE_WEWORK_E2E: 'true',
    WEWORK_E2E_CONTROL_URL: control.controlUrl,
    WEWORK_E2E_BACKGROUND_WINDOW: '1',
    WEWORK_E2E_DISABLE_COMPONENT_UPDATES: '1',
    WEWORK_E2E_CODEX_HOME_INITIALIZATION: 'false',
    WEWORK_E2E_SEED_LOCAL_MODELS: 'false',
  }
}

async function launchInstalledApplication() {
  const home = join(temporaryRoot, 'app-home')
  const control = new DesktopE2EServer(join(home, 'workspace'))
  const appLog = join(resultDirectory, 'app.log')
  await mkdir(home, { recursive: true })
  await control.start()
  let child
  try {
    child = spawn(applicationPath, resolveElectronLaunchArguments(), {
      cwd: installDirectory,
      env: installedAppEnvironment(home, control),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    appendProcessOutput(child.stdout, appLog)
    appendProcessOutput(child.stderr, appLog)
    const exited = new Promise((_, reject) => {
      child.once('error', reject)
      child.once('exit', (code, signal) =>
        reject(
          new Error(
            `Installed application exited before verification: code=${code}, signal=${signal}`
          )
        )
      )
    })
    const ready = await waitForColdPackageStartup(
      Promise.race([control.awaitReady(), exited]),
      appLog,
      { phaseTimeoutMs: STARTUP_PHASE_TIMEOUT_MS }
    )
    assert.match(ready.location, /^https?:\/\/127\.0\.0\.1:\d+\//)
    await Promise.race([
      control.command('waitFor', '[data-testid="app-shell"]', { visible: true }),
      exited,
    ])
    const version = JSON.parse(
      await Promise.race([control.command('getInstalledAppVersion', ''), exited])
    ).version
    assert.match(version, /^\d+\.\d+\.\d+/)
    assert.equal(child.exitCode, null, 'The installed application must remain running')
    return {
      executable: applicationPath,
      pid: child.pid,
      location: ready.location,
      version,
      appShellVisible: true,
    }
  } finally {
    try {
      await stopProcessGroup(child)
    } finally {
      await control.close()
    }
  }
}
