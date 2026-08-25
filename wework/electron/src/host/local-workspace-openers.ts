import { execFile, spawn } from 'node:child_process'
import { access, mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, extname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export interface LocalWorkspaceOpenerAvailability {
  id: string
  category: string
  available: boolean
  label?: string
}

interface MacWorkspaceOpener {
  id: string
  label: string
  category: 'general' | 'terminal' | 'macOnly'
  bundleIds: string[]
  applicationNames: string[]
}

interface WindowsWorkspaceOpener {
  id: string
  label: string
  category: 'general' | 'terminal' | 'winOnly'
  environmentVariables: string[]
  commands: string[]
  commonDirectories: string[]
  executableNames: string[]
}

const MAC_OPENERS: MacWorkspaceOpener[] = [
  {
    id: 'vscode',
    label: 'VS Code',
    category: 'general',
    bundleIds: ['com.microsoft.VSCode'],
    applicationNames: ['Visual Studio Code'],
  },
  {
    id: 'vscode-insiders',
    label: 'VS Code Insiders',
    category: 'general',
    bundleIds: ['com.microsoft.VSCodeInsiders'],
    applicationNames: ['Visual Studio Code - Insiders'],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    category: 'general',
    bundleIds: ['com.todesktop.230313mzl4w4u92'],
    applicationNames: ['Cursor'],
  },
  {
    id: 'sublime-text',
    label: 'Sublime Text',
    category: 'general',
    bundleIds: ['com.sublimetext.4', 'com.sublimetext.3'],
    applicationNames: ['Sublime Text'],
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    category: 'general',
    bundleIds: ['com.exafunction.windsurf'],
    applicationNames: ['Windsurf'],
  },
  {
    id: 'intellij-idea',
    label: 'IntelliJ IDEA',
    category: 'general',
    bundleIds: ['com.jetbrains.intellij', 'com.jetbrains.intellij.ce'],
    applicationNames: ['IntelliJ IDEA', 'IntelliJ IDEA CE'],
  },
  {
    id: 'android-studio',
    label: 'Android Studio',
    category: 'general',
    bundleIds: ['com.google.android.studio'],
    applicationNames: ['Android Studio'],
  },
  {
    id: 'terminal',
    label: 'Terminal',
    category: 'terminal',
    bundleIds: ['com.apple.Terminal'],
    applicationNames: ['Terminal'],
  },
  {
    id: 'xcode',
    label: 'Xcode',
    category: 'macOnly',
    bundleIds: ['com.apple.dt.Xcode'],
    applicationNames: ['Xcode'],
  },
  {
    id: 'iterm2',
    label: 'iTerm2',
    category: 'macOnly',
    bundleIds: ['com.googlecode.iterm2'],
    applicationNames: ['iTerm'],
  },
  {
    id: 'ghostty',
    label: 'Ghostty',
    category: 'macOnly',
    bundleIds: ['com.mitchellh.ghostty'],
    applicationNames: ['Ghostty'],
  },
  {
    id: 'warp',
    label: 'Warp',
    category: 'macOnly',
    bundleIds: ['dev.warp.Warp-Stable'],
    applicationNames: ['Warp'],
  },
]

const WINDOWS_OPENERS: WindowsWorkspaceOpener[] = [
  {
    id: 'vscode',
    label: 'VS Code',
    category: 'general',
    environmentVariables: ['WEGENT_VSCODE_PATH'],
    commands: ['code'],
    commonDirectories: ['%LOCALAPPDATA%/Programs/Microsoft VS Code'],
    executableNames: ['Code.exe'],
  },
  {
    id: 'vscode-insiders',
    label: 'VS Code Insiders',
    category: 'general',
    environmentVariables: ['WEGENT_VSCODE_INSIDERS_PATH'],
    commands: ['code-insiders'],
    commonDirectories: ['%LOCALAPPDATA%/Programs/Microsoft VS Code Insiders'],
    executableNames: ['Code - Insiders.exe'],
  },
  {
    id: 'cursor',
    label: 'Cursor',
    category: 'general',
    environmentVariables: ['WEGENT_CURSOR_PATH'],
    commands: ['cursor'],
    commonDirectories: ['%LOCALAPPDATA%/Programs/cursor'],
    executableNames: ['Cursor.exe'],
  },
  {
    id: 'sublime-text',
    label: 'Sublime Text',
    category: 'general',
    environmentVariables: ['WEGENT_SUBLIME_TEXT_PATH'],
    commands: ['subl'],
    commonDirectories: ['%ProgramFiles%/Sublime Text', '%ProgramFiles(x86)%/Sublime Text'],
    executableNames: ['sublime_text.exe'],
  },
  {
    id: 'windsurf',
    label: 'Windsurf',
    category: 'general',
    environmentVariables: ['WEGENT_WINDSURF_PATH'],
    commands: ['windsurf'],
    commonDirectories: ['%LOCALAPPDATA%/Programs/Windsurf'],
    executableNames: ['Windsurf.exe'],
  },
  {
    id: 'intellij-idea',
    label: 'IntelliJ IDEA',
    category: 'general',
    environmentVariables: ['WEGENT_INTELLIJ_IDEA_PATH'],
    commands: ['idea64', 'idea'],
    commonDirectories: [],
    executableNames: ['idea64.exe', 'idea.exe'],
  },
  {
    id: 'android-studio',
    label: 'Android Studio',
    category: 'general',
    environmentVariables: ['WEGENT_ANDROID_STUDIO_PATH'],
    commands: [],
    commonDirectories: ['%ProgramFiles%/Android/Android Studio/bin'],
    executableNames: ['studio64.exe', 'studio.exe'],
  },
  {
    id: 'terminal',
    label: 'Terminal',
    category: 'terminal',
    environmentVariables: ['WEGENT_TERMINAL_PATH'],
    commands: ['wt'],
    commonDirectories: ['%LOCALAPPDATA%/Microsoft/WindowsApps'],
    executableNames: ['wt.exe'],
  },
  {
    id: 'cmd',
    label: 'CMD',
    category: 'winOnly',
    environmentVariables: ['WEGENT_CMD_PATH'],
    commands: ['cmd'],
    commonDirectories: ['%WINDIR%/System32'],
    executableNames: ['cmd.exe'],
  },
  {
    id: 'powershell',
    label: 'PowerShell',
    category: 'winOnly',
    environmentVariables: ['WEGENT_POWERSHELL_PATH'],
    commands: ['pwsh', 'powershell'],
    commonDirectories: ['%WINDIR%/System32/WindowsPowerShell/v1.0'],
    executableNames: ['powershell.exe', 'pwsh.exe'],
  },
  {
    id: 'custom',
    label: 'Custom',
    category: 'winOnly',
    environmentVariables: [],
    commands: [],
    commonDirectories: [],
    executableNames: [],
  },
]

const WINDOWS_OPENER_STORE = 'local-workspace-openers.json'

let windowsShortcutTargets: Promise<Map<string, string>> | null = null

export async function listLocalWorkspaceOpeners(
  dataDirectory?: string
): Promise<LocalWorkspaceOpenerAvailability[]> {
  if (process.platform === 'darwin') {
    const availability = await Promise.all(
      MAC_OPENERS.map(async opener => ({
        id: opener.id,
        category: opener.category,
        available: Boolean(await resolveMacApplication(opener)),
        label: opener.label,
      }))
    )
    return withFileManager(availability)
  }

  if (process.platform === 'win32') {
    const availability = await Promise.all(
      WINDOWS_OPENERS.map(async opener => {
        const executable = await resolveWindowsExecutable(opener, dataDirectory)
        return {
          id: opener.id,
          category: opener.category,
          available: ['cmd', 'powershell'].includes(opener.id) || Boolean(executable),
          label: opener.id === 'custom' && executable ? executableLabel(executable) : opener.label,
        }
      })
    )
    return withFileManager(availability)
  }

  return [fileManagerAvailability()]
}

export async function openLocalWorkspace(
  openerId: string,
  workspacePath: string,
  dataDirectory?: string
): Promise<void> {
  if (process.platform === 'darwin') {
    const opener = MAC_OPENERS.find(candidate => candidate.id === openerId)
    const applicationPath = opener ? await resolveMacApplication(opener) : null
    if (!applicationPath) {
      throw new Error(`Workspace opener ${openerId} is not installed`)
    }
    await launchDetached('/usr/bin/open', ['-a', applicationPath, workspacePath])
    return
  }

  if (process.platform === 'win32') {
    const opener = WINDOWS_OPENERS.find(candidate => candidate.id === openerId)
    const detectedCommand = opener ? await resolveWindowsExecutable(opener, dataDirectory) : null
    const command =
      detectedCommand ??
      (openerId === 'cmd' ? 'cmd.exe' : openerId === 'powershell' ? 'powershell.exe' : null)
    if (!command) {
      throw new Error(`Workspace opener ${openerId} is not installed`)
    }
    await launchWindowsOpener(openerId, command, workspacePath)
    return
  }

  throw new Error(`Workspace opener ${openerId} is not supported on ${process.platform}`)
}

export async function saveCustomWorkspaceOpener(
  dataDirectory: string,
  executablePath: string
): Promise<void> {
  const entries = await readWindowsOpenerStore(dataDirectory)
  entries.custom = executablePath
  const storePath = join(dataDirectory, WINDOWS_OPENER_STORE)
  const temporaryPath = `${storePath}.tmp`
  await mkdir(dataDirectory, { recursive: true })
  await writeFile(temporaryPath, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 })
  await rename(temporaryPath, storePath)
}

function fileManagerAvailability(): LocalWorkspaceOpenerAvailability {
  return {
    id: 'file-manager',
    category: 'fileManager',
    available: true,
  }
}

function withFileManager(
  availability: LocalWorkspaceOpenerAvailability[]
): LocalWorkspaceOpenerAvailability[] {
  const insertionIndex = availability.findIndex(opener => opener.id === 'terminal')
  if (insertionIndex < 0) return [...availability, fileManagerAvailability()]
  return [
    ...availability.slice(0, insertionIndex),
    fileManagerAvailability(),
    ...availability.slice(insertionIndex),
  ]
}

async function resolveMacApplication(opener: MacWorkspaceOpener): Promise<string | null> {
  for (const bundleId of opener.bundleIds) {
    const applicationPath = await findMacApplicationByBundleId(bundleId)
    if (applicationPath) return applicationPath
  }

  for (const applicationName of opener.applicationNames) {
    for (const applicationsRoot of [
      '/Applications',
      join(homedir(), 'Applications'),
      '/System/Applications',
      '/System/Applications/Utilities',
    ]) {
      const applicationPath = join(applicationsRoot, `${applicationName}.app`)
      if (await pathExists(applicationPath)) return applicationPath
    }
  }
  return null
}

async function findMacApplicationByBundleId(bundleId: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('/usr/bin/mdfind', [
      `kMDItemCFBundleIdentifier == '${bundleId}'`,
    ])
    return (
      stdout
        .split(/\r?\n/)
        .map(path => path.trim())
        .find(path => path.endsWith('.app')) ?? null
    )
  } catch {
    return null
  }
}

async function resolveWindowsExecutable(
  opener: WindowsWorkspaceOpener,
  dataDirectory?: string
): Promise<string | null> {
  const saved = dataDirectory
    ? (await readWindowsOpenerStore(dataDirectory))[opener.id]?.trim()
    : undefined
  if (saved && (await pathExists(saved))) return saved

  for (const variable of opener.environmentVariables) {
    const configured = process.env[variable]?.trim()
    if (!configured || !(await pathExists(configured))) continue
    if (!(await isDirectory(configured))) return configured
    const executable = await findExecutableInDirectory(configured, opener.executableNames)
    if (executable) return executable
  }

  for (const directory of opener.commonDirectories) {
    const executable = await findExecutableInDirectory(
      expandWindowsDirectory(directory),
      opener.executableNames
    )
    if (executable) return executable
  }

  const shortcuts = await getWindowsShortcutTargets()
  for (const executableName of opener.executableNames) {
    const target = shortcuts.get(executableName.toLowerCase())
    if (target) return target
  }

  for (const command of opener.commands) {
    try {
      const { stdout } = await execFileAsync('where.exe', [command])
      const resolved = stdout
        .split(/\r?\n/)
        .map(path => path.trim())
        .find(Boolean)
      if (resolved) return resolved
    } catch {
      continue
    }
  }
  return null
}

async function launchWindowsOpener(
  openerId: string,
  command: string,
  workspacePath: string
): Promise<void> {
  if (openerId === 'cmd') {
    await launchDetached('cmd.exe', ['/C', 'start', '', command, '/K', `cd /d "${workspacePath}"`])
    return
  }
  if (openerId === 'powershell') {
    const escapedPath = workspacePath.replaceAll("'", "''")
    await launchDetached('cmd.exe', [
      '/C',
      'start',
      '',
      command,
      '-NoExit',
      '-Command',
      `Set-Location -LiteralPath '${escapedPath}'`,
    ])
    return
  }
  if (openerId === 'terminal') {
    await launchDetached(command, ['-d', workspacePath])
    return
  }
  if (['.cmd', '.bat'].includes(extname(command).toLowerCase())) {
    await launchDetached('cmd.exe', ['/C', command, workspacePath])
    return
  }
  await launchDetached(command, [workspacePath])
}

async function launchDetached(command: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, {
      detached: true,
      stdio: 'ignore',
    })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}

async function pathExists(path: string): Promise<boolean> {
  return access(path)
    .then(() => true)
    .catch(() => false)
}

async function isDirectory(path: string): Promise<boolean> {
  return stat(path)
    .then(metadata => metadata.isDirectory())
    .catch(() => false)
}

async function findExecutableInDirectory(
  directory: string,
  executableNames: string[]
): Promise<string | null> {
  for (const executableName of executableNames) {
    const candidate = join(directory, executableName)
    if (await pathExists(candidate)) return candidate
  }
  return null
}

function expandWindowsDirectory(template: string): string {
  const variables: Record<string, string | undefined> = {
    '%LOCALAPPDATA%': process.env.LOCALAPPDATA,
    '%ProgramFiles(x86)%': process.env['ProgramFiles(x86)'],
    '%ProgramFiles%': process.env.ProgramFiles,
    '%WINDIR%': process.env.WINDIR,
    '%USERPROFILE%': process.env.USERPROFILE,
  }
  return Object.entries(variables).reduce(
    (path, [token, value]) => (value ? path.replace(token, value) : path),
    template
  )
}

async function getWindowsShortcutTargets(): Promise<Map<string, string>> {
  windowsShortcutTargets ??= scanWindowsShortcutTargets()
  return windowsShortcutTargets
}

async function scanWindowsShortcutTargets(): Promise<Map<string, string>> {
  const script = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$shell = New-Object -ComObject WScript.Shell
$seen = @{}
$folders = @(
  [Environment]::GetFolderPath('Desktop'),
  [Environment]::GetFolderPath('CommonDesktopDirectory'),
  [Environment]::GetFolderPath('Programs'),
  [Environment]::GetFolderPath('CommonPrograms')
)
foreach ($dir in $folders) {
  if (-not $dir -or -not (Test-Path -LiteralPath $dir)) { continue }
  Get-ChildItem -LiteralPath $dir -Filter *.lnk -File -Recurse | ForEach-Object {
    try {
      $shortcut = $shell.CreateShortcut($_.FullName)
      $target = $shortcut.TargetPath
      if ($target -and (Test-Path -LiteralPath $target) -and -not $seen.ContainsKey($target.ToLower())) {
        $seen[$target.ToLower()] = $true
        Write-Output ([System.IO.Path]::GetFileName($target) + "\`t" + $target)
      }
    } catch {}
  }
}
`
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      script,
    ])
    return new Map(
      stdout.split(/\r?\n/).flatMap(line => {
        const separator = line.indexOf('\t')
        if (separator < 1) return []
        const name = line.slice(0, separator).trim().toLowerCase()
        const path = line.slice(separator + 1).trim()
        return name && path ? [[name, path] as const] : []
      })
    )
  } catch {
    return new Map()
  }
}

async function readWindowsOpenerStore(dataDirectory: string): Promise<Record<string, string>> {
  try {
    const parsed: unknown = JSON.parse(
      await readFile(join(dataDirectory, WINDOWS_OPENER_STORE), 'utf8')
    )
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string'
      )
    )
  } catch {
    return {}
  }
}

function executableLabel(executablePath: string): string {
  return basename(executablePath, extname(executablePath))
}
