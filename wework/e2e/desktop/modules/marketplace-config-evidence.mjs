import { realpath } from 'node:fs/promises'

const MARKETPLACE_MANIFEST_SUFFIXES = [
  '/.agents/plugins/marketplace.json',
  '/.claude-plugin/marketplace.json',
]

export function configuredMarketplaceSource(config, marketplaceId = 'wework-personal') {
  let inMarketplace = false
  for (const line of config.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/)
    if (header) {
      inMarketplace = header[1].trim() === `marketplaces.${marketplaceId}`
      continue
    }
    if (!inMarketplace) continue
    const match = line.match(/^\s*source\s*=\s*(?:"((?:\\.|[^"\\])*)"|'([^']*)')\s*(?:#.*)?$/)
    if (!match) continue
    if (match[1] !== undefined) {
      try {
        return JSON.parse(`"${match[1]}"`)
      } catch {
        return null
      }
    }
    return match[2]
  }
  return null
}

export function normalizedMarketplaceSource(source) {
  let normalized = source.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  for (const suffix of MARKETPLACE_MANIFEST_SUFFIXES) {
    if (normalized.endsWith(suffix)) {
      normalized = normalized.slice(0, -suffix.length)
      break
    }
  }
  return normalized
}

export async function marketplaceSourcesMatch(left, right) {
  if (!left || !right) return false
  const normalizedLeft = normalizedMarketplaceSource(left)
  const normalizedRight = normalizedMarketplaceSource(right)
  try {
    const [canonicalLeft, canonicalRight] = await Promise.all([realpath(left), realpath(right)])
    return (
      normalizedMarketplaceSource(canonicalLeft) === normalizedMarketplaceSource(canonicalRight)
    )
  } catch {
    return normalizedLeft === normalizedRight
  }
}
