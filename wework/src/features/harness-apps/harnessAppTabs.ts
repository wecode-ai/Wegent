import type { HarnessAppInstallation } from '@/api/local/harnessApps'
import type { WorkspaceTabsContextValue } from '@/features/workspace-tabs/workspaceTabsContextValue'
import { invoke } from '@tauri-apps/api/core'
import { getWorkbenchPluginRuntime } from '@/plugin-runtime/bootstrap'

const disposers = new Map<string, () => void>()

export function harnessAppKey(installationId: string): string {
  return `harness-${installationId}`
}

export function harnessAppRoute(installationId: string): string {
  return `/app/${encodeURIComponent(harnessAppKey(installationId))}`
}

export function registerHarnessAppTab(installation: HarnessAppInstallation): string {
  const key = harnessAppKey(installation.id)
  if (!installation.webUrl) throw new Error('Harness app is not running')
  disposers.get(installation.id)?.()
  const dispose = getWorkbenchPluginRuntime().apps.register({
    key,
    mode: 'iframe',
    url: installation.webUrl,
    hidden: true,
    labelKey: `harness-app.${installation.id}.label`,
    label: installation.manifest.displayName,
    descriptionKey: `harness-app.${installation.id}.description`,
    description: installation.manifest.description,
  })
  disposers.set(installation.id, dispose)
  return key
}

export function unregisterHarnessAppTab(installationId: string): void {
  disposers.get(installationId)?.()
  disposers.delete(installationId)
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
  return invoke<string | null>('take_harness_app_proxy_token', { installationId })
}

export function storeHarnessAppProxyToken(installationId: string, token: string): Promise<void> {
  return invoke<void>('store_harness_app_proxy_token', { installationId, token })
}

export function takeHarnessAppContextToken(installationId: string): Promise<string | null> {
  return invoke<string | null>('take_harness_app_context_token', { installationId })
}

export function storeHarnessAppContextToken(installationId: string, token: string): Promise<void> {
  return invoke<void>('store_harness_app_context_token', { installationId, token })
}
