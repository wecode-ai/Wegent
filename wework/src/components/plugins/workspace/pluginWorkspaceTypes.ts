import type { ReactNode } from 'react'
import type { PluginReference } from '@/features/plugins/pluginNavigation'
import type { Dispatch, SetStateAction } from 'react'
import type { createAsyncResource } from '@wegent/chat-core/async-resource'
import type { PluginMarketplaceItem, PluginPublicationRequestItem } from '@/types/api'
import type { InstalledPluginItem } from '../PluginManagementRows'
import type { PluginCatalogInput, createPluginCatalogState } from './pluginCatalogState'
import type { createPluginWorkspaceOperations } from './pluginWorkspaceOperations'
import type { createPluginConnectorHealthState } from './pluginConnectorHealthState'
import type { createPluginPublicationState } from './pluginPublicationState'

export interface PendingMarketplaceInstall {
  item: PluginMarketplaceItem
  requiredConnectionNames: string[]
  promptAfterInstall?: string
}
export interface PluginWorkspaceServices {
  catalog: ReturnType<typeof createPluginCatalogState>
  operations: ReturnType<typeof createPluginWorkspaceOperations>
  pluginApi: PluginCatalogInput['pluginApi']
  localPluginApi: PluginCatalogInput['localPluginApi']
  t: PluginCatalogInput['t']
  marketplaceCacheKeyValue: string
  currentDeviceId: string
  knownExecutorDeviceId: string
  cloudApiBaseUrl: string | undefined
  cloudToken: string | null | undefined
  localSyncResource: ReturnType<typeof createAsyncResource<boolean>>
  installedPlugins: InstalledPluginItem[]
  reconciliationBlocksActions: boolean
  connectorHealth: ReturnType<typeof createPluginConnectorHealthState>
  selectedMarketplacePluginId: string | number | null
  selectedPluginId: string | number | null
  localConnectorAuthBySlug: Record<string, 'connected' | 'disconnected'>
  setPluginDetailActionError(
    value: {
      pluginId: string | number
      message: string
      source?: 'detail-read' | 'auth-health'
    } | null
  ): void
  selectedMarketplacePlugin: PluginMarketplaceItem | null
  selectedMarketplacePluginDetail: InstalledPluginItem | null
  isMarketplacePluginUninstalling(item: PluginMarketplaceItem): boolean
  beginMarketplacePluginTrial(
    item: PluginMarketplaceItem,
    installed: InstalledPluginItem | null | undefined,
    prompt?: string
  ): void
  ensureMarketplaceConnectors(item: PluginMarketplaceItem, isCurrent?: () => boolean): Promise<void>
  rollbackInstalledPluginAfterAuthFailure(
    plugin: InstalledPluginItem['raw'],
    isCurrent: () => boolean
  ): Promise<void>
  ensureLocalConnectorsAfterInstall(
    item: PluginMarketplaceItem,
    plugin: InstalledPluginItem['raw'],
    isCurrent: () => boolean
  ): Promise<void>
  publications: ReturnType<typeof createPluginPublicationState>
  publicationRequests: PluginPublicationRequestItem[]
  setSelectedPluginId: Dispatch<SetStateAction<string | number | null>>
  setSelectedMarketplacePluginId: Dispatch<SetStateAction<string | number | null>>
  refreshLocalMarketplace(options?: { reloadCatalog: boolean }): void
}

export interface PluginsWorkspaceProps {
  sidebarCollapsed?: boolean
  topBarLeftActions?: ReactNode
  cloudMarketplaceAvailable?: boolean
  cloudApiBaseUrl?: string
  cloudToken?: string | null
  cloudUserId?: number | null
  pluginReference?: PluginReference | null
}
