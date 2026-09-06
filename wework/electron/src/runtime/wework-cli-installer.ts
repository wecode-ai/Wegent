import { chmod, copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const MANAGED_MARKER = '# Wework CLI launcher'

export interface WeworkCliInstallOptions {
  appCommand: string[]
  nodeCommand: string[]
}

export interface UserWeworkCliInstallOptions {
  environment: NodeJS.ProcessEnv
  packagedApplication: boolean
  pluginDevelopmentInstance: boolean
}

export function shouldInstallUserWeworkCli(
  platform: NodeJS.Platform,
  options: UserWeworkCliInstallOptions
): boolean {
  return (
    platform === 'darwin' &&
    options.packagedApplication &&
    !options.pluginDevelopmentInstance &&
    !options.environment.WEWORK_E2E_CONTROL_URL?.trim()
  )
}

export async function installWeworkCli(
  runtimeBin: string,
  sourcePath: string,
  platform: NodeJS.Platform,
  options: WeworkCliInstallOptions
): Promise<void> {
  await mkdir(runtimeBin, { recursive: true, mode: 0o700 })
  const cliPath = join(runtimeBin, 'wework-cli.mjs')
  await copyFile(sourcePath, cliPath)
  await chmod(cliPath, 0o700)
  if (platform === 'win32') {
    const launcher = join(runtimeBin, 'wework.cmd')
    await rm(launcher, { force: true })
    await writeFile(launcher, windowsLauncher(cliPath, options), { mode: 0o600 })
    return
  }
  const launcher = join(runtimeBin, 'wework')
  await rm(launcher, { force: true })
  await writeFile(launcher, posixLauncher(cliPath, options), { mode: 0o700 })
  await chmod(launcher, 0o700)
}

export async function canReplaceWeworkCli(path: string): Promise<boolean> {
  try {
    return (await readFile(path, 'utf8')).includes(MANAGED_MARKER)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
    return false
  }
}

function posixLauncher(cliPath: string, options: WeworkCliInstallOptions): string {
  const nodeCommand = options.nodeCommand.map(shellQuote).join(' ')
  const appCommand = options.appCommand.map(shellQuote).join(' ')
  return `#!/bin/sh
${MANAGED_MARKER}
set -eu

if [ "\${1:-}" = "-h" ] || [ "\${1:-}" = "--help" ]; then
  cat <<'EOF'
Usage:
  wework [path]
  wework desktop <command> [options]
EOF
  exit 0
fi

if [ "\${1:-}" = "desktop" ]; then
  exec ${nodeCommand} ${shellQuote(cliPath)} "$@"
fi

if [ "$#" -gt 1 ]; then
  echo "wework: expected a path or the desktop subcommand" >&2
  exit 2
fi

TARGET_PATH="\${1:-.}"
if [ ! -d "$TARGET_PATH" ]; then
  echo "wework: path is not a directory: $TARGET_PATH" >&2
  exit 1
fi
ABSOLUTE_PATH="$(cd "$TARGET_PATH" && pwd -P)"
unset ELECTRON_RUN_AS_NODE
exec ${appCommand} --open-workspace "$ABSOLUTE_PATH"
`
}

function windowsLauncher(cliPath: string, options: WeworkCliInstallOptions): string {
  const nodeCommand = options.nodeCommand.map(windowsQuote).join(' ')
  const appCommand = options.appCommand.map(windowsQuote).join(' ')
  return `@echo off\r
${MANAGED_MARKER}\r
if "%~1"=="-h" goto usage\r
if "%~1"=="--help" goto usage\r
if "%~1"=="desktop" ${nodeCommand} ${windowsQuote(cliPath)} %*\r
if "%~1"=="desktop" exit /b %errorlevel%\r
if not "%~2"=="" (\r
  echo wework: expected a path or the desktop subcommand 1>&2\r
  exit /b 2\r
)\r
set "TARGET_PATH=%~f1"\r
if "%~1"=="" set "TARGET_PATH=%CD%"\r
if not exist "%TARGET_PATH%\\NUL" (\r
  echo wework: path is not a directory: %TARGET_PATH% 1>&2\r
  exit /b 1\r
)\r
set "ELECTRON_RUN_AS_NODE="\r
${appCommand} --open-workspace "%TARGET_PATH%"\r
exit /b %errorlevel%\r
:usage\r
echo Usage:\r
echo   wework [path]\r
echo   wework desktop ^<command^> [options]\r
`
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

function windowsQuote(value: string): string {
  return `"${value.replaceAll('%', '%%').replaceAll('"', '""')}"`
}
