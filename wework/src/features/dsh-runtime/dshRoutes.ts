import type { AnalyticsEventMap } from '@/telemetry/events'
import type { WorkspaceTabKind } from '@/features/workspace-tabs/workspaceTabs'
import { getDshSlotEntries, WEWORK_DSH_SLOTS, type WeworkDshSlotEntry } from './dshUiSlots'

export interface WeworkDshRoute extends WeworkDshSlotEntry {
  workspaceTabKind?: WorkspaceTabKind
  icon?: string
  module?: string
  path: string
  restorePolicy?: 'none' | 'session'
  telemetryFeature: AnalyticsEventMap['feature_opened']['feature']
  title?: string
  titleKey?: string
}

export function getDshRoutes(): readonly WeworkDshRoute[] {
  return getDshSlotEntries<WeworkDshRoute>(WEWORK_DSH_SLOTS.route)
}

export function resolveDshRoute(path: string): WeworkDshRoute | null {
  return getDshRoutes().find(route => route.path === path) ?? null
}
