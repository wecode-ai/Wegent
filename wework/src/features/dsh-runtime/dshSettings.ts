import type { ComponentType } from 'react'
import type { WorkbenchServices } from '@/features/workbench/workbenchServices'
import type { RefreshWorkLists } from '@/features/workbench/workbenchContextTypes'
import type { DeviceInfo, RuntimeTaskAddress } from '@/types/api'
import { getDshSlotEntries, WEWORK_DSH_SLOTS, type WeworkDshSlotEntry } from './dshUiSlots'

export interface WeworkDshSettingsContext {
  services?: WorkbenchServices
  devices: DeviceInfo[]
  onBack: () => void
  onOpenCloudSettings: () => void
  onOpenRuntimeTask?: (address: RuntimeTaskAddress) => Promise<void>
  onRefreshWorkLists?: RefreshWorkLists
}

export interface WeworkDshSettingsPage extends WeworkDshSlotEntry {
  aliases?: readonly string[]
  category: string
  categoryLabel: string
  categoryLabelKey?: string
  component?: string
  desktopOnly?: boolean
  experimental?: boolean
  icon?: string
  label: string
  labelKey?: string
  module?: string
  path: string
}

export type WeworkSettingsIcon = ComponentType<{ className?: string }>

export function getDshSettingsPages(): readonly WeworkDshSettingsPage[] {
  return getDshSlotEntries<WeworkDshSettingsPage>(WEWORK_DSH_SLOTS.settingsPage)
}

export function resolveDshSettingsPath(
  path: string,
  pages = getDshSettingsPages()
): WeworkDshSettingsPage | null {
  return pages.find(page => page.path === path || page.aliases?.includes(path)) ?? null
}
