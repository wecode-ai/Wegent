import type { HarnessAppInstallation } from '@/api/local/harnessApps'
import type { WorkspaceTabsContextValue } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { invokeDesktopHost } from '@/api/dsh/desktopHost'

const runningApps = new Map<string, HarnessAppInstallation>()

export function harnessAppKey(installationId: string): string {
  return `harness-${installationId}`
}

export function harnessAppRoute(installationId: string): string {
  return `/app/${encodeURIComponent(harnessAppKey(installationId))}`
}

export function registerHarnessAppTab(installation: HarnessAppInstallation): string {
  const key = harnessAppKey(installation.id)
  if (!installation.webUrl) throw new Error('Harness app is not running')
  runningApps.set(installation.id, installation)
  return key
}

export function unregisterHarnessAppTab(installationId: string): void {
  runningApps.delete(installationId)
}

export function resolveRunningHarnessApp(
  key: string
): { key: string; nativeLabel: string; title: string; url: string } | null {
  if (!key.startsWith('harness-')) return null
  const installationId = key.slice('harness-'.length)
  const installation = runningApps.get(installationId)
  if (!installation?.webUrl) return null
  return {
    key,
    nativeLabel: `smart-app:${installationId}`,
    title: installation.manifest.displayName,
    url: installation.webUrl,
  }
}

export function openHarnessAppTab(
  workspaceTabs: WorkspaceTabsContextValue,
  installation: HarnessAppInstallation
): void {
  const route = harnessAppRoute(installation.id)
  const existing = workspaceTabs.tabs.find(tab => tab.contentRoute === route)
  if (existing) {
    workspaceTabs.selectTab(existing.id, {
      title: installation.manifest.displayName,
      contentRoute: route,
    })
    return
  }
  workspaceTabs.openTab('auxiliary', {
    title: installation.manifest.displayName,
    contentRoute: route,
  })
}

export function takeHarnessAppProxyToken(installationId: string): Promise<string | null> {
  return invokeDesktopHost<string | null>('smartApps.takeProxyToken', { installationId })
}

export function storeHarnessAppProxyToken(installationId: string, token: string): Promise<void> {
  return invokeDesktopHost<void>('smartApps.storeProxyToken', { installationId, token })
}

export function takeHarnessAppContextToken(installationId: string): Promise<string | null> {
  return invokeDesktopHost<string | null>('smartApps.takeContextToken', { installationId })
}

export function storeHarnessAppContextToken(installationId: string, token: string): Promise<void> {
  return invokeDesktopHost<void>('smartApps.storeContextToken', { installationId, token })
}
