import type { AnalyticsEventMap } from '@/telemetry/events'
import { getDshSlotEntries, WEWORK_DSH_SLOTS, type WeworkDshSlotEntry } from './dshUiSlots'

export interface WeworkDshRoute extends WeworkDshSlotEntry {
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
