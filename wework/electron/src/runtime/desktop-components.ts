import {
  ComponentUpdateManager,
  type ComponentPaths,
  type ComponentUpdateManagerOptions,
} from './component-update-manager.js'

export interface DesktopComponentUpdateController {
  confirmStartup(): Promise<void>
  rollbackStartup(): Promise<boolean>
  stageAvailableUpdate(): Promise<boolean>
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
