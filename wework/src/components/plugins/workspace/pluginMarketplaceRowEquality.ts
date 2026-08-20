import type { PluginMarketplaceItem } from '@/types/api'

export interface PluginMarketplaceRowLabels {
  install: string
  installing: string
  uninstalling: string
  retry: string
  syncing: string
  try: string
  manage: string
  uninstall: string
  copy: string
}

export type PluginMarketplaceRowAction =
  | 'open'
  | 'install'
  | 'try'
  | 'manage'
  | 'uninstall'
  | 'copy'

export interface PluginMarketplaceRowProps {
  item: PluginMarketplaceItem
  isLoggedIn: boolean
  isInstalling: boolean
  isUninstalling: boolean
  allowPendingRetry: boolean
  showPendingAsSyncing?: boolean
  labels: PluginMarketplaceRowLabels
  testIdPrefix?: string
  onAction: (action: PluginMarketplaceRowAction, item: PluginMarketplaceItem) => void
}

export function arePluginMarketplaceRowPropsEqual(
  previous: PluginMarketplaceRowProps,
  next: PluginMarketplaceRowProps
): boolean {
  return (
    previous.item === next.item &&
    previous.item.id === next.item.id &&
    previous.item.installed === next.item.installed &&
    previous.item.installedLocally === next.item.installedLocally &&
    previous.item.currentDeviceInstallation?.state === next.item.currentDeviceInstallation?.state &&
    previous.isLoggedIn === next.isLoggedIn &&
    previous.isInstalling === next.isInstalling &&
    previous.isUninstalling === next.isUninstalling &&
    previous.allowPendingRetry === next.allowPendingRetry &&
    previous.showPendingAsSyncing === next.showPendingAsSyncing &&
    previous.labels === next.labels &&
    previous.testIdPrefix === next.testIdPrefix &&
    previous.onAction === next.onAction
  )
}
