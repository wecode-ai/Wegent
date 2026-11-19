import type { PluginMarketplaceItem } from '@/types/api'
import type { PluginMarketplaceRowAction } from './PluginMarketplaceRow'

export function createPluginMarketplaceRowAction(commands: {
  open(item: PluginMarketplaceItem): void
  install(item: PluginMarketplaceItem): void
  try(item: PluginMarketplaceItem): void
  copy(item: PluginMarketplaceItem): void
  uninstall(item: PluginMarketplaceItem): void
  clearBrowsing(): void
}) {
  return (action: PluginMarketplaceRowAction, item: PluginMarketplaceItem) => {
    if (action === 'open' || action === 'manage') {
      commands.clearBrowsing()
      commands.open(item)
    } else if (action === 'install') commands.install(item)
    else if (action === 'try') {
      commands.clearBrowsing()
      commands.try(item)
    } else if (action === 'copy') commands.copy(item)
    else commands.uninstall(item)
  }
}
