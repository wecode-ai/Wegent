import { parse } from 'smol-toml'

export function matchesBundledMarketplaceConfig(content, expectedSource) {
  const marketplace = parse(content).marketplaces?.['wework-personal']
  return (
    marketplace?.source_type === 'local' &&
    typeof marketplace.source === 'string' &&
    marketplace.source.length > 0 &&
    (!expectedSource || marketplace.source === expectedSource)
  )
}
