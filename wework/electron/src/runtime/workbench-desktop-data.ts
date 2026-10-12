import { mkdirSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, sep } from 'node:path'
import { parse } from 'yaml'

import {
  migrateWorkbenchDataEntry,
  recoverWorkbenchDataBridge,
} from './workbench-data-migration.js'

export function desktopDataMigration(source: string, desktop: string, name: string) {
  return {
    source,
    target: join(desktop, name),
    journal: join(desktop, 'migrations', `desktop-${name}-v1.json`),
  }
}

export function prepareDesktopDataSource(source: string, desktop: string): void {
  recoverWorkbenchDataBridge(desktopDataMigration(source, desktop, 'user-data'))
  mkdirSync(source, { recursive: true, mode: 0o700 })
}

export function migrateDesktopControlRegistry(home: string, shared: string): void {
  const options = {
    source: join(home, '.wework', 'runtime', 'desktop-instances'),
    target: join(shared, 'desktop-instances'),
    journal: join(shared, 'migrations', 'desktop-instances-v1.json'),
  }
  recoverWorkbenchDataBridge(options)
  mkdirSync(options.source, { recursive: true, mode: 0o700 })
  migrateWorkbenchDataEntry(options)
}

// Must run synchronously under Electron's single-instance lock, before ready,
// constructing stores, initializing sessions, or starting update downloads.
export function migrateWorkbenchDesktopData(options: {
  source: string
  desktop: string
  logs: string
  updaterCache: string
}): { userData: string; logs: string } {
  const { source, desktop } = options
  const migration = desktopDataMigration(source, desktop, 'user-data')
  migrateWorkbenchDataEntry(migration)
  const logSuffix = relative(source, options.logs)
  let logs: string
  if (!isAbsolute(logSuffix) && logSuffix !== '..' && !logSuffix.startsWith(`..${sep}`)) {
    logs = join(migration.target, logSuffix)
  } else {
    const logMigration = desktopDataMigration(options.logs, desktop, 'electron-logs')
    recoverWorkbenchDataBridge(logMigration)
    mkdirSync(options.logs, { recursive: true, mode: 0o700 })
    migrateWorkbenchDataEntry(logMigration)
    logs = logMigration.target
  }
  const cacheMigration = desktopDataMigration(options.updaterCache, desktop, 'updater-cache')
  recoverWorkbenchDataBridge(cacheMigration)
  mkdirSync(options.updaterCache, { recursive: true, mode: 0o700 })
  migrateWorkbenchDataEntry(cacheMigration)
  mkdirSync(logs, { recursive: true, mode: 0o700 })
  return { userData: migration.target, logs }
}

export function packagedUpdaterCache(
  home: string,
  resources: string,
  environment: NodeJS.ProcessEnv,
  platform = process.platform
): string {
  const base =
    platform === 'darwin'
      ? join(home, 'Library', 'Caches')
      : platform === 'win32'
        ? environment.LOCALAPPDATA || join(home, 'AppData', 'Local')
        : environment.XDG_CACHE_HOME || join(home, '.cache')
  // Use the same configuration as electron-updater; branded package names differ.
  const name: unknown = parse(
    readFileSync(join(resources, 'app-update.yml'), 'utf8')
  )?.updaterCacheDirName
  if (
    typeof name !== 'string' ||
    !name.trim() ||
    name === '.' ||
    name === '..' ||
    /[<>:"/\\|?*]/.test(name) ||
    Array.from(name).some(character => character.charCodeAt(0) < 32)
  )
    throw new Error('Invalid updater cache directory in app-update.yml')
  return join(base, name)
}
