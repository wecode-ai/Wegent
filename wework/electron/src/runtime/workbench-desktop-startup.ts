import type { App } from 'electron'
import { join } from 'node:path'

import { migrateWorkbenchDesktopData, prepareDesktopDataSource } from './workbench-desktop-data.js'
import type { WorkbenchMigrationLockAdapter } from './workbench-migration-lock.js'

interface DesktopDataStartupOptions {
  app: Pick<
    App,
    'getName' | 'getPath' | 'setPath' | 'requestSingleInstanceLock' | 'releaseSingleInstanceLock'
  >
  source: string
  desktop: string
  additionalData: Record<string, unknown>
  acquireLock: WorkbenchMigrationLockAdapter
  platform?: NodeJS.Platform
}

// Top-level await in the Electron entry point keeps this entire handoff before ready.
export async function initializeWorkbenchDesktopData(
  options: DesktopDataStartupOptions
): Promise<{ userData: string; logs: string } | null> {
  const platform = options.platform ?? process.platform
  if (platform !== 'win32') return initializeUnderMigrationLock(options, platform)

  // These native locks live beside the source and desktop directories, outside userData.
  // Serialize new launches while the Windows Electron lockfile is temporarily closed.
  const lock = await options.acquireLock([options.source, options.desktop])
  try {
    lock.assertHeld()
    const result = initializeUnderMigrationLock(options, platform)
    lock.assertHeld()
    return result
  } finally {
    await lock.release()
  }
}

function initializeUnderMigrationLock(
  options: DesktopDataStartupOptions,
  platform: NodeJS.Platform
): { userData: string; logs: string } | null {
  const { app, source, desktop, additionalData } = options
  prepareDesktopDataSource(source, desktop)
  app.setPath('userData', source)
  if (!app.requestSingleInstanceLock(additionalData)) return null

  // Windows opens userData/lockfile without FILE_SHARE_DELETE, preventing its parent rename.
  if (platform === 'win32') app.releaseSingleInstanceLock()
  try {
    // Electron's macOS getPath('logs') creates a missing directory, preventing alias recovery.
    const logs =
      platform === 'darwin'
        ? join(app.getPath('home'), 'Library', 'Logs', app.getName())
        : app.getPath('logs')
    const migrated = migrateWorkbenchDesktopData({
      source,
      desktop,
      logs,
    })
    // Retain the legacy lexical path as the singleton identity, including for older builds.
    // If an older build started during the handoff, notify it and stop before opening stores.
    if (platform === 'win32' && !app.requestSingleInstanceLock(additionalData)) return null
    return migrated
  } catch (error) {
    app.releaseSingleInstanceLock()
    throw error
  }
}
