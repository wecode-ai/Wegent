import { getRuntimeConfig } from '@/config/runtime'

export function isElectronRuntime(): boolean {
  return typeof window !== 'undefined' && getRuntimeConfig().desktopHost === 'electron'
}

export function isDesktopRuntime(): boolean {
  return isElectronRuntime()
}

export function getDesktopWindowLabel(): string {
  if (isElectronRuntime()) return getRuntimeConfig().desktopWindowLabel
  return 'main'
}
