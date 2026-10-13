import { createRequire } from 'node:module'

const { parse } = createRequire(import.meta.url)(process.env.WEWORK_E2E_TOML_PARSER || 'smol-toml')

export function matchesBundledMarketplaceConfig(content, expectedSource) {
  const marketplace = parse(content).marketplaces?.['wework-personal']
  return (
    marketplace?.source_type === 'local' &&
    typeof marketplace.source === 'string' &&
    marketplace.source.length > 0 &&
    (!expectedSource || marketplace.source === expectedSource)
  )
}
