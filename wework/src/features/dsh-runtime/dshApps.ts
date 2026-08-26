import { getDshSlotEntries, WEWORK_DSH_SLOTS, type WeworkDshSlotEntry } from './dshUiSlots'

export interface WeworkDshApp extends WeworkDshSlotEntry {
  description?: string
  descriptionKey?: string
  experimental?: boolean
  hidden?: boolean
  hiddenInSwitcher?: boolean
  label: string
  labelKey?: string
  mode: 'iframe' | 'native' | 'surface'
  module?: string
  path?: string
  requiresAuth?: boolean
  requiresCloud?: boolean
  url?: string
  urlSource?: 'cloud-web'
  workspaceKinds?: readonly ('task' | 'board')[]
}

export function getDshApps(): readonly WeworkDshApp[] {
  return getDshSlotEntries<WeworkDshApp>(WEWORK_DSH_SLOTS.app)
}

export function resolveDshApp(id: string): WeworkDshApp | null {
  return getDshApps().find(app => app.id === id) ?? null
}
