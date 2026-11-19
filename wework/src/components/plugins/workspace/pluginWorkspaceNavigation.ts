import type { PluginReference } from '@/features/plugins/pluginNavigation'

export function createPluginDetailNavigation(
  reference: PluginReference | null,
  dismissReference: () => void
) {
  return (clearSelection: () => void) => {
    if (reference?.pluginName && reference.marketplaceName) {
      dismissReference()
      window.history.back()
    } else clearSelection()
  }
}
