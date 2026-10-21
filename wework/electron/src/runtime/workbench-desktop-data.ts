import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, sep } from 'node:path'

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

// Must run synchronously before ready, stores, or sessions.
// Caller holds the Electron singleton or, during its Windows handoff, native migration locks.
export function migrateWorkbenchDesktopData(options: {
  source: string
  desktop: string
  logs: string
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
    mkdirSync(dirname(options.logs), { recursive: true, mode: 0o700 })
    recoverWorkbenchDataBridge(logMigration, {
      replaceEmptyDirectory: true,
      allowDirectoryDeviceChange: true,
    })
    mkdirSync(options.logs, { recursive: true, mode: 0o700 })
    migrateWorkbenchDataEntry(logMigration)
    logs = logMigration.target
  }
  mkdirSync(logs, { recursive: true, mode: 0o700 })
  return { userData: migration.target, logs }
}
