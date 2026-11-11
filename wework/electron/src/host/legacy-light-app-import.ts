import { lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { WorkbenchAppManifest } from '../runtime/workbench-dsh-runtime.js'
import {
  WORKBENCH_NATIVE_CAPABILITIES,
  type WorkbenchNativeCapability,
} from './workbench-app-capabilities.js'
import {
  validateWorkbenchReminders,
  validateWorkbenchState,
  type WorkbenchAppData,
} from './workbench-app-data.js'
import { bundleLightweightHtml } from './lightweight-workbench-assets.js'
import { scaffoldLightweightWorkbench } from './smart-app-scaffold.js'

interface LegacyManifest {
  id: string
  name: string
  description: string
  entry: string
  capabilities: WorkbenchNativeCapability[]
  window: { width: number; height: number; alwaysOnTop: boolean }
}

export interface LegacyLightAppRecord {
  manifest: LegacyManifest
  packagePath: string
  installedAt: string
  shortcut: string | null
}

function manifest(value: unknown): LegacyManifest {
  const input = value as LegacyManifest
  if (
    !input ||
    typeof input !== 'object' ||
    !/^[a-z0-9][a-z0-9-]{0,63}$/.test(input.id) ||
    typeof input.name !== 'string' ||
    !input.name.trim() ||
    input.name.length > 80 ||
    (input.description !== undefined &&
      (typeof input.description !== 'string' || input.description.length > 500))
  )
    throw new Error('Invalid legacy light-app manifest')
  const entry = input.entry ?? 'index.html'
  if (
    !/^[a-zA-Z0-9/_-]+\.html$/.test(entry) ||
    entry.startsWith('/') ||
    entry.split('/').some(part => !part || part === '..')
  )
    throw new Error('Invalid legacy light-app entry')
  const capabilities = input.capabilities ?? []
  if (
    !Array.isArray(capabilities) ||
    new Set(capabilities).size !== capabilities.length ||
    capabilities.some(item => !WORKBENCH_NATIVE_CAPABILITIES.includes(item))
  )
    throw new Error('Invalid legacy light-app capabilities')
  const window = {
    width: input.window?.width ?? 380,
    height: input.window?.height ?? 520,
    alwaysOnTop: input.window?.alwaysOnTop ?? false,
  }
  if (
    !Number.isInteger(window.width) ||
    window.width < 240 ||
    window.width > 1920 ||
    !Number.isInteger(window.height) ||
    window.height < 180 ||
    window.height > 1440 ||
    typeof window.alwaysOnTop !== 'boolean'
  )
    throw new Error('Invalid legacy light-app window')
  return { ...input, entry, description: input.description ?? '', capabilities, window }
}

/** A one-way source import; this does not install, grant permissions or run the old format. */
export async function importLegacyLightApp(
  projectPath: string,
  destination: string,
  dshVersion: string
): Promise<WorkbenchAppManifest> {
  if (!isAbsolute(projectPath) || !isAbsolute(destination))
    throw new Error('Import paths must be absolute')
  const source = await realpath(projectPath)
  const child = relative(source, resolve(destination))
  if (!child || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child)))
    throw new Error('Legacy import destination must be outside its source')
  await mkdir(destination, { recursive: true, mode: 0o700 })
  const canonicalChild = relative(source, await realpath(destination))
  if (
    !canonicalChild ||
    (!canonicalChild.startsWith(`..${sep}`) &&
      canonicalChild !== '..' &&
      !isAbsolute(canonicalChild))
  )
    throw new Error('Legacy import destination must be outside its source')
  if ((await readdir(destination)).length)
    throw new Error('Legacy import destination must be empty')
  const legacy = manifest(JSON.parse(await readFile(join(projectPath, 'light-app.json'), 'utf8')))
  const assets = join(destination, '.legacy-import')
  await mkdir(assets, { mode: 0o700 })
  try {
    let bytes = 0
    async function snapshot(source: string, target: string): Promise<void> {
      for (const entry of await readdir(source)) {
        if (entry === '.git' || entry === 'node_modules' || /^\.env(?:\.|$)/.test(entry))
          throw new Error('Legacy import rejects operational and sensitive files')
        const path = join(source, entry)
        const info = await lstat(path)
        if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
          throw new Error('Legacy import rejects symbolic links and special files')
        if (info.isDirectory()) {
          await mkdir(join(target, entry))
          await snapshot(path, join(target, entry))
          continue
        }
        if (/^(?:\.env(?:\.|$)|\.git$)/.test(entry))
          throw new Error('Legacy import rejects sensitive files')
        const content = await readFile(path)
        bytes += content.length
        if (bytes > 20 * 1024 * 1024) throw new Error('Legacy app exceeds 20 MiB')
        const sourceFile = ['.html', '.js', '.mjs'].includes(extname(entry).toLowerCase())
        await writeFile(
          join(target, entry),
          sourceFile
            ? content.toString('utf8').replace(/\bweworkLightApp\b/g, 'weworkWorkbench')
            : content,
          { mode: 0o600 }
        )
      }
    }
    await snapshot(source, assets)
    const html = await bundleLightweightHtml(assets, legacy.entry)
    await scaffoldLightweightWorkbench({
      path: destination,
      name: legacy.id,
      displayName: legacy.name,
      description: legacy.description,
      dshVersion,
      html,
      nativeCapabilities: legacy.capabilities,
      window: legacy.window,
    })
    return JSON.parse(
      await readFile(join(destination, 'plugin-manifest.json'), 'utf8')
    ) as WorkbenchAppManifest
  } finally {
    await rm(assets, { recursive: true, force: true })
  }
}

export async function readLegacyLightApps(dataDirectory: string): Promise<LegacyLightAppRecord[]> {
  try {
    const records: unknown = JSON.parse(
      await readFile(join(dataDirectory, 'light-apps', 'registry.json'), 'utf8')
    )
    if (!Array.isArray(records))
      throw new Error('Invalid legacy light-app registry; source was preserved')
    return records.map(record => {
      if (
        !record ||
        typeof record.packagePath !== 'string' ||
        !isAbsolute(record.packagePath) ||
        typeof record.installedAt !== 'string' ||
        (record.shortcut !== null && typeof record.shortcut !== 'string')
      )
        throw new Error('Invalid legacy light-app record; source was preserved')
      return { ...record, manifest: manifest(record.manifest) }
    })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function readLegacyLightAppData(
  dataDirectory: string,
  id: string
): Promise<WorkbenchAppData> {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error('Invalid legacy light-app id')
  try {
    const data = JSON.parse(
      await readFile(join(dataDirectory, 'light-apps', 'data', `${id}.json`), 'utf8')
    )
    return {
      state: validateWorkbenchState(data.state),
      reminders: validateWorkbenchReminders(data.reminders),
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: null, reminders: [] }
    throw error
  }
}
