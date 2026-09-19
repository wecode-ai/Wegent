import i18n from '@/i18n'
import type { InstalledPlugin } from '@/types/api'
import { installedPluginSourceLabel as sourceLabel } from '@wegent/chat-core/installed-plugin-merge'
export * from '@wegent/chat-core/installed-plugin-merge'
export function installedPluginSourceLabel(item: InstalledPlugin): string {
  return sourceLabel(item, key => i18n.t(key))
}
