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

export function resolveRunningHarnessAppInstallation(key: string): HarnessAppInstallation | null {
  if (!key.startsWith('harness-')) return null
  return runningApps.get(key.slice('harness-'.length)) ?? null
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

export async function takeHarnessAppAdditionalProxyTokens(
  installationId: string
): Promise<string[]> {
  const tokens = await invokeDesktopHost<string[] | null | undefined>(
    'smartApps.takeAdditionalProxyTokens',
    { installationId }
  )
  return Array.isArray(tokens) ? tokens : []
}

export function storeHarnessAppAdditionalProxyTokens(
  installationId: string,
  tokens: string[]
): Promise<void> {
  return invokeDesktopHost<void>('smartApps.storeAdditionalProxyTokens', { installationId, tokens })
}

export function takeHarnessAppContextToken(installationId: string): Promise<string | null> {
  return invokeDesktopHost<string | null>('smartApps.takeContextToken', { installationId })
}

export function storeHarnessAppContextToken(installationId: string, token: string): Promise<void> {
  return invokeDesktopHost<void>('smartApps.storeContextToken', { installationId, token })
}

export function takeHarnessAppDecisionToken(installationId: string): Promise<string | null> {
  return invokeDesktopHost<string | null>('smartApps.takeDecisionToken', { installationId })
}

export function storeHarnessAppDecisionToken(installationId: string, token: string): Promise<void> {
  return invokeDesktopHost<void>('smartApps.storeDecisionToken', { installationId, token })
}

/**
 * Route scope for the decision router. It carries the installation id and a
 * random suffix so concurrent launches never share a route, and it never
 * embeds anything the user typed.
 */
export function harnessAppDecisionScope(installationId: string): string {
  return `smart-app:${installationId}:${crypto.randomUUID()}`
}
