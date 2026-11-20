import { app } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { resolveWorkbenchUserData } from './workbench-environment.js'
import type { BrandRuntimeMetadata } from './brand-runtime-environment.js'
import { recordReleaseDiagnostic } from './release-diagnostics.js'
import { INSTALLED_PREPARATION_PROGRESS_PREFIX } from './installed-preparation-contract.mjs'
import { prepareInstalledEnvironment } from './installed-preparation.js'
import { initializeWorkbenchDesktopData } from './workbench-desktop-startup.js'

interface InstalledPreparationMetadata extends BrandRuntimeMetadata {
  version: string
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
    const dataDirectory = resolveDataDirectory(metadata)
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

function resolveDataDirectory(metadata: InstalledPreparationMetadata): string {
  const userData = resolveWorkbenchUserData({
    environment: process.env,
    metadata,
    homeDirectory: app.getPath('home'),
  })
  if (
    !process.env.WEWORK_USER_DATA_DIR?.trim() &&
    !initializeWorkbenchDesktopData(app, userData, { installedPreparation: true })
  )
    throw new Error('Wework must be closed while preparing the installation')
  return userData
}
