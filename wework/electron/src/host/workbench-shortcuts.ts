import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { workbenchId } from './workbench-application-contract.js'
import {
  createMacosWorkbenchShortcut,
  ownsMacosWorkbenchShortcut,
} from './workbench-macos-shortcut.js'
import { ownsWorkbenchShortcutFile } from './workbench-shortcut-file.js'

export interface WorkbenchShortcutLaunch {
  command: string
  args: string[]
  environment: Record<string, string>
}

export function normalizeWorkbenchShortcut(input: string): string {
  if (input.length > 128) throw new Error('Workbench shortcut is too long')
  const aliases: Record<string, string> = {
    ctrl: 'Control',
    control: 'Control',
    alt: 'Alt',
    option: 'Alt',
    shift: 'Shift',
    cmd: 'Command',
    command: 'Command',
    meta: 'Super',
    super: 'Super',
    cmdorctrl: process.platform === 'darwin' ? 'Command' : 'Control',
    commandorcontrol: process.platform === 'darwin' ? 'Command' : 'Control',
  }
  const parts = input
    .trim()
    .split('+')
    .map(part => part.trim())
  const key = parts.pop()
  const modifiers = parts.map(part => aliases[part.toLowerCase()])
  if (
    !key ||
    !/^(?:[A-Za-z0-9]|F(?:[1-9]|1\d|2[0-4])|Space|Tab|Enter|Up|Down|Left|Right)$/i.test(key) ||
    !modifiers.length ||
    modifiers.some(value => !value) ||
    new Set(modifiers).size !== modifiers.length ||
    !modifiers.some(value => ['Control', 'Command', 'Alt', 'Super'].includes(value))
  )
    throw new Error(
      'Use a shortcut with Control, Command or Alt and a letter, number or function key'
    )
  const normalizedKey =
    key.length === 1 || /^f\d+$/i.test(key)
      ? key.toUpperCase()
      : key[0]!.toUpperCase() + key.slice(1).toLowerCase()
  return [...modifiers.sort(), normalizedKey].join('+')
}

export class WorkbenchDesktopShortcuts {
  constructor(
    private readonly directory: string,
    private readonly launch: WorkbenchShortcutLaunch,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}
  async create(id: string): Promise<string> {
    workbenchId(id)
    if (this.platform === 'darwin') {
      const path = await createMacosWorkbenchShortcut(this.directory, id, this.launch)
      await this.removeLegacyMacosLink(id)
      return path
    }
    const file = this.file(id)
    await mkdir(this.directory, { recursive: true })
    try {
      await writeFile(file.path, file.content, { flag: 'wx', mode: file.mode })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      if (!(await this.owns(id)))
        throw new Error('Desktop shortcut path is already occupied', { cause: error })
    }
    return file.path
  }
  async remove(id: string): Promise<void> {
    workbenchId(id)
    if (this.platform === 'darwin') {
      if (await ownsMacosWorkbenchShortcut(this.directory, id, this.launch))
        await rm(join(this.directory, `${id}.app`), { recursive: true })
      await this.removeLegacyMacosLink(id)
      return
    }
    if (await this.owns(id)) await rm(this.file(id).path)
  }
  private file(id: string) {
    const url = `wework://workbenches/${id}`
    const extension = this.platform === 'win32' ? 'url' : 'desktop'
    const content =
      extension === 'url'
        ? `[InternetShortcut]\r\nURL=${url}\r\n`
        : `[Desktop Entry]\nType=Application\nName=${id}\nExec=xdg-open ${url}\nTerminal=false\n`
    return {
      path: join(this.directory, `${id}.${extension}`),
      content,
      mode: extension === 'desktop' ? 0o700 : 0o600,
    }
  }
  private async owns(id: string): Promise<boolean> {
    const { path, content } = this.file(id)
    return ownsWorkbenchShortcutFile(path, content)
  }
  private async removeLegacyMacosLink(id: string): Promise<void> {
    const path = join(this.directory, `${id}.webloc`)
    const content = `<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>URL</key><string>wework://workbenches/${id}</string></dict></plist>\n`
    if (await ownsWorkbenchShortcutFile(path, content)) await rm(path)
  }
}
