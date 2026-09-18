const PROXY_SCHEMES: Record<string, string> = {
  HTTP: 'http',
  HTTPS: 'https',
  PROXY: 'http',
  SOCKS: 'socks5',
  SOCKS5: 'socks5',
}

export async function resolveSystemProxy(
  session: { resolveProxy(url: string): Promise<string> },
  targetUrl: string
): Promise<string | null> {
  const url = new URL(targetUrl)
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('System proxy target must be an HTTP or HTTPS URL')
  }
  return proxyRulesToUrl(await session.resolveProxy(url.href))
}

function validProxyEndpoint(endpoint: string): boolean {
  const match = endpoint.match(/^(?:\[[^\]]+\]|[^:/\s]+):(\d+)$/)
  if (!match) return false
  const port = Number(match[1])
  return port > 0 && port <= 65_535
}

export function proxyRulesToUrl(proxyRules: string): string | null {
  for (const entry of proxyRules.split(';')) {
    const [type, endpoint, ...extra] = entry.trim().split(/\s+/)
    if (!type || type.toUpperCase() === 'DIRECT') return null
    if (!endpoint || extra.length > 0 || !validProxyEndpoint(endpoint)) continue

    const scheme = PROXY_SCHEMES[type.toUpperCase()]
    if (!scheme) continue
    return `${scheme}://${endpoint}`
  }
  return null
}
