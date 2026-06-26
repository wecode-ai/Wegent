import type { ToolBlock } from '@/types/workbench'

export interface WebSearchActivityItem {
  id: string
  label: string
  domain?: string
  iconUrl?: string
  sourceLabel?: string
  sourceUrl?: string
}

export interface WebSearchSourceItem {
  id: string
  label: string
  domain: string
  iconUrl: string
  url: string
}

export function getWebSearchActivityItems(
  blocks: Array<Pick<ToolBlock, 'id' | 'toolInput'>>
): WebSearchActivityItem[] {
  const seen = new Set<string>()
  const items: WebSearchActivityItem[] = []

  const addItem = (item: Omit<WebSearchActivityItem, 'label'> & { label?: string }) => {
    const label = item.label
    const normalized = label?.trim()
    if (!normalized || seen.has(normalized)) return
    seen.add(normalized)
    items.push({ ...item, label: normalized })
  }

  blocks.forEach(block => {
    const action = getWebSearchAction(block.toolInput)
    const actionType = getStringField(action, 'type')
    if (actionType === 'open_page') {
      const url = getStringField(action, 'url')
      const urlMetadata = getUrlMetadata(url)
      addItem({
        id: `${block.id}-url`,
        label: url,
        domain: urlMetadata?.domain,
        iconUrl: urlMetadata?.iconUrl,
        sourceLabel: urlMetadata?.displayUrl,
        sourceUrl: urlMetadata?.url,
      })
      return
    }

    const query = getStringField(action, 'query') ?? getStringArrayField(action, 'queries')[0]
    const siteScopedQuery = getSiteScopedQuery(query)
    addItem({
      id: `${block.id}-query`,
      label: siteScopedQuery?.label ?? query,
      domain: siteScopedQuery?.domain,
      iconUrl: siteScopedQuery?.iconUrl,
      sourceLabel: siteScopedQuery?.domain,
    })
  })

  return items
}

export function getWebSearchSourceItems(
  blocks: Array<Pick<ToolBlock, 'id' | 'toolInput'>>
): WebSearchSourceItem[] {
  const sourcesByDomain = new Map<string, WebSearchSourceItem>()

  getWebSearchActivityItems(blocks).forEach(item => {
    if (!item.domain || !item.iconUrl) return
    const label = item.sourceLabel ?? item.domain
    const existing = sourcesByDomain.get(item.domain)
    const fallbackUrl = `https://${item.domain}`
    if (existing && (!item.sourceUrl || existing.url !== fallbackUrl)) return
    sourcesByDomain.set(item.domain, {
      id: `${item.id}-source`,
      label,
      domain: item.domain,
      iconUrl: item.iconUrl,
      url: item.sourceUrl ?? fallbackUrl,
    })
  })

  return [...sourcesByDomain.values()]
}

function getWebSearchAction(value: unknown): Record<string, unknown> {
  const input = isRecord(value) ? value : {}
  const nestedAction = input.action
  return isRecord(nestedAction) ? nestedAction : input
}

function getStringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key]
  return typeof field === 'string' ? field : undefined
}

function getStringArrayField(value: Record<string, unknown>, key: string): string[] {
  const field = value[key]
  return Array.isArray(field)
    ? field.filter((item): item is string => typeof item === 'string')
    : []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function getSiteScopedQuery(query: string | undefined):
  | {
      label: string
      domain: string
      iconUrl: string
    }
  | undefined {
  const normalizedQuery = query?.trim()
  if (!normalizedQuery) return undefined

  const siteMatch = normalizedQuery.match(/(?:^|\s)site:([^\s]+)/i)
  const rawDomain = siteMatch?.[1]
  const domain = normalizeDomain(rawDomain)
  if (!siteMatch || !domain) return undefined

  const queryWithoutSite = normalizedQuery
    .replace(siteMatch[0], siteMatch[0].startsWith(' ') ? ' ' : '')
    .replace(/\s+/g, ' ')
    .trim()
  return {
    label: queryWithoutSite ? `${queryWithoutSite} | ${domain}` : domain,
    domain,
    iconUrl: getFaviconUrl(domain),
  }
}

function getUrlMetadata(url: string | undefined):
  | {
      url: string
      domain: string
      displayUrl: string
      iconUrl: string
    }
  | undefined {
  if (!url?.trim()) return undefined

  try {
    const parsed = new URL(url)
    const domain = normalizeDomain(parsed.hostname)
    if (!domain) return undefined
    return {
      url,
      domain,
      displayUrl: formatDisplayUrl(parsed, domain),
      iconUrl: getFaviconUrl(domain),
    }
  } catch {
    return undefined
  }
}

function formatDisplayUrl(parsed: URL, domain: string): string {
  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`
  return `${domain}${path === '/' ? '' : path}`
}

function normalizeDomain(value: string | undefined): string | undefined {
  const domain = value
    ?.trim()
    .replace(/^\*\./, '')
    .replace(/^https?:\/\//i, '')
    .split('/')[0]
    ?.replace(/[),.;:]+$/, '')
    .toLowerCase()
  if (!domain) return undefined
  return domain.startsWith('www.') ? domain.slice(4) : domain
}

function getFaviconUrl(domain: string): string {
  return `https://${domain}/favicon.ico`
}
