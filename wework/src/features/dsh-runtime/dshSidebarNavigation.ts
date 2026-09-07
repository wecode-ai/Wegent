import type { ComponentType } from 'react'

import type { DeviceInfo } from '@/types/api'
import type { CloudWorkStatus } from '@/types/workbench'
import { importDshUiModule } from './dshUiModules'
import { getDshSlotEntries, WEWORK_DSH_SLOTS, type WeworkDshSlotEntry } from './dshUiSlots'

interface WeworkDshSidebarNavigationItemBase extends WeworkDshSlotEntry {
  activeItem?: string
  experimental?: boolean
  icon?: string
  label: string
  labelKey?: string
  prefetch?: boolean
  testId?: string
}

export type WeworkDshSidebarNavigationItem =
  | (WeworkDshSidebarNavigationItemBase & {
      module: string
      path: string
      surface: 'module'
      workspaceSidebarTab?: never
    })
  | (WeworkDshSidebarNavigationItemBase & {
      module?: never
      path: string
      surface?: 'item'
      workspaceSidebarTab?: never
    })
  | (WeworkDshSidebarNavigationItemBase & {
      module?: never
      path?: never
      surface?: 'item'
      workspaceSidebarTab: string
    })

type WeworkDshSidebarNavigationModuleItem = Extract<
  WeworkDshSidebarNavigationItem,
  { surface: 'module' }
>

export interface WeworkDshSidebarNavigationModuleProps {
  cloudWorkStatus?: CloudWorkStatus
  devices: DeviceInfo[]
  item: WeworkDshSidebarNavigationModuleItem
  onAddRemoteDevice: () => void
  onNavigate: (path: string) => void
  onOpenSettings: (page: string) => void
  onSelectStandaloneDevice?: (deviceId: string) => void
  selected: boolean
}

export interface DshSidebarNavigationModule {
  default: ComponentType<WeworkDshSidebarNavigationModuleProps>
  preload?: () => void | Promise<void>
}

export function getDshSidebarNavigationItems(): readonly WeworkDshSidebarNavigationItem[] {
  return getDshSlotEntries<WeworkDshSidebarNavigationItem>(WEWORK_DSH_SLOTS.sidebarNavigation)
}

export function prefetchDshSidebarNavigation(item: WeworkDshSidebarNavigationItem): void {
  if (!item.module || !item.prefetch) return
  void importDshUiModule<DshSidebarNavigationModule>(item.module).then(module => module.preload?.())
}
