import { createHash } from 'node:crypto'
import { lstat, mkdir, mkdtemp, readdir, rename, rm, rmdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { WorkbenchShortcutLaunch } from './workbench-shortcuts.js'
import { ownsWorkbenchShortcutFile, readWorkbenchShortcutFile } from './workbench-shortcut-file.js'

const EXECUTABLE = 'launch-workbench'
const EXECUTABLE_PATH = `Contents/MacOS/${EXECUTABLE}`

export async function createMacosWorkbenchShortcut(
  directory: string,
  id: string,
  launch: WorkbenchShortcutLaunch
): Promise<string> {
  const files = shortcutFiles(id, launch)
  const path = join(directory, `${id}.app`)
  await mkdir(directory, { recursive: true })
  const staging = await mkdtemp(join(directory, `.${id}-shortcut-`))
  let reservation: Awaited<ReturnType<typeof lstat>> | undefined
  try {
    await mkdir(join(staging, 'Contents', 'MacOS'), { recursive: true, mode: 0o700 })
    for (const [name, content] of Object.entries(files))
      await writeFile(join(staging, name), content, {
        flag: 'wx',
        mode: name.endsWith(EXECUTABLE) ? 0o700 : 0o600,
      })
    try {
      await mkdir(path, { mode: 0o700 })
      reservation = await lstat(path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!(await ownsMacosWorkbenchShortcut(directory, id, launch)))
        throw new Error('Desktop shortcut path is already occupied', { cause: error })
      if (!(await ownsWorkbenchShortcutFile(join(path, EXECUTABLE_PATH), files[EXECUTABLE_PATH]!)))
        await rename(join(staging, EXECUTABLE_PATH), join(path, EXECUTABLE_PATH))
      return path
    }
    await rename(staging, path)
    return path
  } finally {
    await rm(staging, { recursive: true, force: true })
    if (reservation) {
      const current = await lstat(path).catch(() => null)
      if (current?.dev === reservation.dev && current.ino === reservation.ino) await rmdir(path)
    }
  }
}

export async function ownsMacosWorkbenchShortcut(
  directory: string,
  id: string,
  launch: WorkbenchShortcutLaunch
): Promise<boolean> {
  const path = join(directory, `${id}.app`)
  try {
    for (const [relative, names] of [
      ['', ['Contents']],
      ['Contents', ['Info.plist', 'MacOS']],
      ['Contents/MacOS', [EXECUTABLE]],
    ] as const) {
      const child = join(path, relative)
      if (!(await lstat(child)).isDirectory()) return false
      const entries = await readdir(child)
      if (entries.sort().join('\0') !== [...names].sort().join('\0')) return false
    }
    const source = await readWorkbenchShortcutFile(join(path, EXECUTABLE_PATH))
    if (!source) return false
    const stored = parseStoredLaunch(source, id)
    if (
      !stored ||
      stored.environment.WEWORK_USER_DATA_DIR !== launch.environment.WEWORK_USER_DATA_DIR
    )
      return false
    for (const [relative, content] of Object.entries(shortcutFiles(id, stored)))
      if (!(await ownsWorkbenchShortcutFile(join(path, relative), content))) return false
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    return false
  }
}

function shortcutFiles(id: string, launch: WorkbenchShortcutLaunch): Record<string, string> {
  if (!isAbsolute(launch.command)) throw new Error('Workbench shortcut command must be absolute')
  if (
    !launch.environment.WEWORK_USER_DATA_DIR ||
    !isAbsolute(launch.environment.WEWORK_USER_DATA_DIR)
  )
    throw new Error('Workbench shortcut profile must be absolute')
  const environment = Object.entries(launch.environment).sort(([left], [right]) =>
    left.localeCompare(right)
  )
  for (const [name] of environment)
    if (!/^[A-Z_][A-Z0-9_]*$/.test(name)) throw new Error('Invalid shortcut environment name')
  const command = [launch.command, ...launch.args, `wework://workbenches/${id}`]
    .map(shellQuote)
    .join(' ')
  const record = Buffer.from(JSON.stringify({ schemaVersion: 1, id, launch })).toString('base64')
  const script = `#!/bin/sh
# Wework workbench shortcut: ${record}
set -eu
unset ELECTRON_RUN_AS_NODE WEWORK_RELEASE_ROOT WEWORK_RELEASE_SUPERVISED WEWORK_ACTIVE_RELEASE_ID WEWORK_RELEASE_RECOVERY WEWORK_COMPONENT_DATA_DIRECTORY
${environment.map(([name, value]) => `export ${name}=${shellQuote(value)}`).join('\n')}
exec ${command}
`
  const identity = createHash('sha256')
    .update(`${id}\0${launch.environment.WEWORK_USER_DATA_DIR}`)
    .digest('hex')
    .slice(0, 32)
  const files = {
    'Contents/Info.plist': `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>io.wecode.wework.shortcut.${identity}</string>
<key>CFBundleName</key><string>${id}</string>
<key>CFBundleDisplayName</key><string>${id}</string>
<key>CFBundleExecutable</key><string>${EXECUTABLE}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
<key>LSUIElement</key><true/>
</dict></plist>
`,
    [EXECUTABLE_PATH]: script,
  }
  if (Object.values(files).some(content => Buffer.byteLength(content) > 64 * 1024))
    throw new Error('Workbench shortcut launch configuration is too large')
  return files
}

function parseStoredLaunch(source: string, id: string): WorkbenchShortcutLaunch | null {
  try {
    const match = /^# Wework workbench shortcut: ([A-Za-z0-9+/=]+)$/m.exec(source)
    if (!match) return null
    const record = JSON.parse(Buffer.from(match[1]!, 'base64').toString('utf8'))
    const launch = record.launch
    if (
      record.schemaVersion !== 1 ||
      record.id !== id ||
      typeof launch?.command !== 'string' ||
      !Array.isArray(launch.args) ||
      !launch.args.every((value: unknown) => typeof value === 'string') ||
      !launch.environment ||
      Array.isArray(launch.environment) ||
      typeof launch.environment !== 'object' ||
      !Object.values(launch.environment).every(value => typeof value === 'string')
    )
      return null
    return launch
  } catch {
    return null
  }
}

function shellQuote(value: string): string {
  if (value.includes('\0')) throw new Error('Invalid shortcut command value')
  return `'${value.replaceAll("'", "'\\''")}'`
}
