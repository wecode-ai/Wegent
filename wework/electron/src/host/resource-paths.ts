import { resolve } from 'node:path'

export interface ElectronResourceRootOptions {
  isPackaged: boolean
  packageRoot: string
  processResourcesPath: string
}

export function electronResourceRoot(options: ElectronResourceRootOptions): string {
  return options.isPackaged
    ? options.processResourcesPath
    : resolve(options.packageRoot, '..', 'resources')
}
