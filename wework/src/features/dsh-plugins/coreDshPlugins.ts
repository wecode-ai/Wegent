import { invokeDesktopHost } from '@/api/dsh/desktopHost'

export interface CoreDshPlugin {
  name: string
  displayName: string
  description: string
  version: string
  requestedSpec: string
  enabled: boolean
  immutable: boolean
  homepage: string
  repository: string
  canUpdate: boolean
  canToggle: boolean
  canUninstall: boolean
}

export function readCoreDshPlugins(): Promise<CoreDshPlugin[]> {
  return invokeDesktopHost('runtime.listCoreDshPlugins')
}

export function installCoreDshPlugin(spec: string): Promise<CoreDshPlugin[]> {
  return invokeDesktopHost('runtime.installCoreDshPlugin', { spec })
}

export function updateCoreDshPlugin(name: string): Promise<CoreDshPlugin[]> {
  return invokeDesktopHost('runtime.updateCoreDshPlugin', { name })
}

export function setCoreDshPluginEnabled(name: string, enabled: boolean): Promise<CoreDshPlugin[]> {
  return invokeDesktopHost('runtime.setCoreDshPluginEnabled', { name, enabled })
}

export function uninstallCoreDshPlugin(name: string): Promise<CoreDshPlugin[]> {
  return invokeDesktopHost('runtime.uninstallCoreDshPlugin', { name })
}

export async function restartCoreDsh(): Promise<void> {
  await invokeDesktopHost('runtime.restartCoreDsh')
}
