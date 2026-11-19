import type { SmartAppsMarketplacePageProps } from './smartAppsMarketplaceTypes'
import { useSmartAppsMarketplaceModel } from './useSmartAppsMarketplaceModel'
import { SmartAppsMarketplaceView } from './SmartAppsMarketplaceView'
export { SmartAppPublishDialog } from './SmartAppPublishDialog'
export function SmartAppsMarketplacePage(props: SmartAppsMarketplacePageProps) {
  return <SmartAppsMarketplaceView {...useSmartAppsMarketplaceModel(props)} />
}
