import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { resolveWorkbenchPaths } from './workbench-environment.js'
import type { BrandRuntimeMetadata } from './brand-runtime-environment.js'
import { recordReleaseDiagnostic } from './release-diagnostics.js'
import { INSTALLED_PREPARATION_PROGRESS_PREFIX } from './installed-preparation-contract.mjs'
import { prepareInstalledEnvironment } from './installed-preparation.js'
import { executorMigrationLock } from './workbench-migration-lock.js'
import { initializeWorkbenchDesktopData } from './workbench-desktop-startup.js'

interface InstalledPreparationMetadata extends BrandRuntimeMetadata {
  version: string
  weworkAppId?: string
  weworkUpdateBaseUrl?: string
}

export async function prepareInstallation(metadata: InstalledPreparationMetadata): Promise<void> {
  let logFile: string | undefined
  const log = (event: string) => {
    if (!logFile) return
    try {
      mkdirSync(dirname(logFile), { recursive: true, mode: 0o700 })
      appendFileSync(logFile, `${new Date().toISOString()} ${event}\n`, {
        encoding: 'utf8',
        mode: 0o600,
      })
    } catch {
      // Diagnostics must never block installation preparation.
    }
  }
  try {
    const dataDirectory = await resolveDataDirectory(metadata)
    logFile = join(dataDirectory, 'logs', 'install-preparation.log')
    log('started')
    // Electron fires ready only after this ESM entry finishes evaluating.
    await prepareInstalledEnvironment({
      resourcesRoot: process.resourcesPath,
      dataDirectory,
      componentDataDirectory: process.env.WEWORK_COMPONENT_DATA_DIRECTORY?.trim() || dataDirectory,
      version: metadata.version,
      updateBaseUrl:
        process.env.WEWORK_UPDATE_BASE_URL?.trim() ||
        metadata.weworkUpdateBaseUrl?.trim() ||
        'https://github.com/wecode-ai/Wegent/releases/download/wework-updater',
      statusFile: join(dataDirectory, 'logs', 'install-preparation.json'),
      onProgress: event => {
        log(JSON.stringify(event))
        process.stdout.write(`${INSTALLED_PREPARATION_PROGRESS_PREFIX}${JSON.stringify(event)}\n`)
      },
    })
    log('completed')
    app.exit(0)
  } catch (error) {
    log(
      JSON.stringify({
        phase: 'failed',
        message: error instanceof Error ? error.message : 'Preparation failed',
      })
    )
    recordReleaseDiagnostic(
      'installed-preparation-failed',
      { message: error instanceof Error ? error.message : 'Preparation failed' },
      true
    )
    console.error(
      '[install-preparation]',
      error instanceof Error ? error.message : 'Preparation failed'
    )
    app.exit(1)
  }
}

async function resolveDataDirectory(metadata: InstalledPreparationMetadata): Promise<string> {
  const configured = process.env.WEWORK_USER_DATA_DIR?.trim()
  if (configured) return configured

  const applicationId =
    process.env.WEWORK_APP_IDENTIFIER?.trim() || metadata.weworkAppId?.trim() || 'io.wecode.wework'
  const desktop = resolveWorkbenchPaths({
    environment: process.env,
    metadata,
    homeDirectory: app.getPath('home'),
  }).desktop
  const executor =
    process.env.WEWORK_EXECUTOR_PATH?.trim() ||
    join(
      process.resourcesPath,
      'bin',
      process.platform === 'win32' ? 'wegent-executor.exe' : 'wegent-executor'
    )
  // Installation preparation must enter the same data layout before writing any
  // profile state. Creating user-data first makes the first normal launch reject
  // the existing migration target.
  const initialized = await initializeWorkbenchDesktopData({
    app,
    source: resolve(app.getPath('appData'), applicationId),
    desktop,
    additionalData: { installedPreparation: true },
    acquireLock: executorMigrationLock(executor, { wait: true }),
  })
  if (!initialized) throw new Error('Wework must be closed while preparing the installation')
  return initialized.userData
}
