import type { SmartAppMarketplaceItem, SmartAppsApi } from '@/api/smartApps'
import { type HarnessAppInstallation, type HarnessAppPreview } from '@/api/local/harnessApps'

export interface SmartAppsMarketplacePageProps {
  api: SmartAppsApi | null
  mode?: 'marketplace' | 'owned'
  onNavigate?: (path: string) => void
  targetSmartAppId?: number | null
}

export interface PendingInstall {
  item: SmartAppMarketplaceItem
  preview: HarnessAppPreview
  intent: 'install' | 'update'
  readInstallations: () => HarnessAppInstallation[] | null
}

export interface SelectedSmartApp {
  item: SmartAppMarketplaceItem
  readInstallations: PendingInstall['readInstallations']
}

export type OwnedFilter = 'all' | 'created' | 'installed'
export type MarketplaceSort = 'recommended' | 'updated'

export interface OwnedSmartAppCard {
  category: Exclude<OwnedFilter, 'all'>
  installation: HarnessAppInstallation | null
  item: SmartAppMarketplaceItem | null
  key: string
}
