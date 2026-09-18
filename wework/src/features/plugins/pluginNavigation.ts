export * from '@wegent/chat-core/plugin-reference'
import { isWegentCloudMarketplaceId } from './marketplaceIdentity'

export function isWegentCloudMarketplace(marketplaceName: string): boolean {
  return isWegentCloudMarketplaceId(marketplaceName)
}
