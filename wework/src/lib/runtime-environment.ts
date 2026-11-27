import { getRuntimeConfig, getRuntimeDesktopHost } from '@/config/runtime'

export function isElectronRuntime(): boolean {
  return getRuntimeDesktopHost() === 'electron'
}

export function isDesktopRuntime(): boolean {
  return isElectronRuntime()
}

export function getDesktopWindowLabel(): string {
  if (isElectronRuntime()) return getRuntimeConfig().desktopWindowLabel
  return 'main'
}
