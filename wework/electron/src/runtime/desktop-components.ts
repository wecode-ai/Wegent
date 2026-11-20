import { join } from 'node:path'
import type { ComponentDownloadProgress } from '../host/app-update-progress.js'
import {
  ComponentUpdateManager,
  type ComponentPaths,
  type ComponentUpdateManagerOptions,
} from './component-update-manager.js'

export interface DesktopComponentUpdateController {
  confirmStartup(): Promise<void>
  rollbackStartup(): Promise<boolean>
  stageUpdateForApp(
    appVersion: string,
    channel: string,
    onProgress?: (progress: ComponentDownloadProgress) => void
  ): Promise<boolean>
}

interface PrepareDesktopComponentsOptions {
  isPackaged: boolean
  managerOptions: ComponentUpdateManagerOptions
  createManager?: (
    options: ComponentUpdateManagerOptions
  ) => ComponentUpdateManager & DesktopComponentUpdateController
}

export interface PreparedDesktopComponents {
  manager: DesktopComponentUpdateController | null
  paths: ComponentPaths | null
}

export function bundledComponentDirectory(
  environment: NodeJS.ProcessEnv,
  userDataDirectory: string
): string {
  return (
    environment.WEWORK_BUNDLED_COMPONENT_DIRECTORY?.trim() ||
    join(
      environment.WEWORK_COMPONENT_DATA_DIRECTORY?.trim() || userDataDirectory,
      'managed-components'
    )
  )
}

export async function prepareDesktopComponents(
  options: PrepareDesktopComponentsOptions
): Promise<PreparedDesktopComponents> {
  if (!options.isPackaged) {
    return { manager: null, paths: null }
  }

  const manager =
    options.createManager?.(options.managerOptions) ??
    new ComponentUpdateManager(options.managerOptions)
  return {
    manager,
    paths: await manager.prepareStartup(),
  }
}
