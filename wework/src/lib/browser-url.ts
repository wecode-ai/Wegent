const URL_SCHEME = /^[a-z][a-z\d+.-]*:/i
const EXPLICIT_AUTHORITY = /^[a-z][a-z\d+.-]*\s*:\s*[/\\]\s*[/\\]/i
const KNOWN_URI_SCHEME =
  /^(?:https?|file|asset|ftp|wss?|about|blob|data|javascript|mailto|tel|sms|wework):/i
const WEB_SEARCH_OPERATOR = /^(?:site|filetype|intitle|inurl|before|after):(?!\/\/)/i

function isLocalAssetUrl(url: URL): boolean {
  return url.protocol === 'asset:' && url.hostname === 'localhost'
}

function encodeFilePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%3A/gi, ':')
}

function encodeFilePath(path: string): string {
  return path
    .split('/')
    .map((segment, index) => {
      if (index === 0 && /^[a-zA-Z]:$/.test(segment)) return segment
      return encodeFilePathSegment(segment)
    })
    .join('/')
}

function localPathToFileUrl(value: string): string | null {
  const normalized = value.trim()
  if (!normalized) return null

  if (/^\\\\/.test(normalized)) {
    const uncPath = normalized.replace(/^\\\\+/, '').replace(/\\/g, '/')
    const [host, ...segments] = uncPath.split('/')
    if (!host || segments.length === 0) return null
    return `file://${host}/${segments.map(encodeFilePathSegment).join('/')}`
  }

  if (/^[a-zA-Z]:[\\/]/.test(normalized)) {
    return `file:///${encodeFilePath(normalized.replace(/\\/g, '/'))}`
  }

  if (normalized.startsWith('/')) {
    return `file://${encodeFilePath(normalized.replace(/\\/g, '/'))}`
  }

  return null
}

export function browserDiagnosticOrigin(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.origin : url.protocol
  } catch {
    return null
  }
}

function addressAuthority(value: string): string {
  return value.split(/[/?#\\]/, 1)[0]
}

function addressHostPort(value: string): string {
  const authority = addressAuthority(value)
  return authority.slice(authority.lastIndexOf('@') + 1)
}

export function normalizeBrowserUrl(value: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  const localFile = localPathToFileUrl(trimmed)
  const scheme = trimmed.match(URL_SCHEME)?.[0]
  const afterScheme = scheme ? trimmed.slice(scheme.length) : ''
  const hasAuthority = afterScheme.startsWith('//')
  // A bare authority can include a port or user info. Known opaque schemes remain unsupported.
  if (!localFile && scheme && !hasAuthority) {
    const bareAuthority = addressAuthority(trimmed)
    if (
      KNOWN_URI_SCHEME.test(scheme) ||
      (!bareAuthority.includes('@') && !/^\d+(?:[/?#\\]|$)/.test(afterScheme))
    )
      return null
  }
  const withProtocol = localFile ?? (hasAuthority ? trimmed : `http://${trimmed}`)

  try {
    if (!localFile) {
      const hostPort = addressHostPort(hasAuthority ? afterScheme.slice(2) : trimmed)
      // Reject malformed authorities before the runtime's URL parser can escape whitespace.
      if (/\s/.test(decodeURIComponent(hostPort))) return null
    }
    const url = new URL(withProtocol)
    if (
      url.protocol !== 'http:' &&
      url.protocol !== 'https:' &&
      url.protocol !== 'file:' &&
      !isLocalAssetUrl(url)
    ) {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}

function looksLikeNetworkHost(host: string): boolean {
  return (
    (host.includes('.') && /^\d[\d.\s]*$/.test(host)) ||
    /^(?:localhost|\[[^\]\s:]*:[^\]\s]*\]?)$/i.test(host) ||
    /^[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)+\.?$/u.test(host)
  )
}

// Keep address intent even when the authority will fail URL validation.
function networkEndpoint(text: string): { port?: string } | undefined {
  const explicitHttp = /^https?:\/\//i.test(text)
  if (!explicitHttp && KNOWN_URI_SCHEME.test(text)) return undefined
  const hostPort = addressHostPort(text.replace(/^https?:\/\//i, '')).trimEnd()
  if (looksLikeNetworkHost(hostPort) || /^[\da-f]{0,4}:[\da-f]{0,4}:\S*$/i.test(hostPort)) return {}
  const parts = /^(\[[^\]]+\]|[^:@]+):([^\r\n]*)$/.exec(hostPort)
  if (!parts) return undefined
  const [, rawHost, port] = parts
  const host = rawHost.trimEnd()
  const hasAddressSuffix = text.length > addressAuthority(text).length
  const bareHostWithPort =
    /^[\p{L}\p{N}_-]+$/u.test(host) &&
    (/^\d+$/.test(port) ||
      (hasAddressSuffix && !WEB_SEARCH_OPERATOR.test(text) && /^\S+$/.test(port)))
  if (explicitHttp || looksLikeNetworkHost(host) || bareHostWithPort) {
    return { port }
  }
  return undefined
}

export function hasInvalidBrowserPort(value: string): boolean {
  const port = networkEndpoint(value.trim())?.port
  return Boolean(port && (!/^\d+$/.test(port) || Number(port) > 65535))
}

function hasUrlParameters(text: string): boolean {
  const parametersStart = text.search(/[?#]/)
  return parametersStart >= 0 && /[?&#][^=?#&\s]+=/.test(text.slice(parametersStart))
}

function hasNetworkAddressIntent(text: string): boolean {
  // A bare package version with up to three numeric components can look like a shortened IPv4 host.
  if (/^[\w.-]+@v?\d+(?:\.\d+){0,2}(?:-[\w.-]+)?(?:\+[\w.-]+)?$/i.test(text)) return false
  if (EXPLICIT_AUTHORITY.test(text) || networkEndpoint(text)) return true
  if (!hasUrlParameters(text)) return false

  // Use the compact authority only to classify inputs with URL parameters.
  const hostPort = addressHostPort(text)
  try {
    const compact = decodeURIComponent(hostPort).replace(/\s/g, '')
    return compact !== hostPort && Boolean(networkEndpoint(compact))
  } catch {
    return false
  }
}

/** Only address-bar text can become a search. Programmatic navigation still requires a URL. */
export function browserAddressAction(value: string) {
  const text = value.trim()
  const networkAddress = hasNetworkAddressIntent(text)
  const colonQuery =
    !networkAddress &&
    (WEB_SEARCH_OPERATOR.test(text) ||
      (/^[a-z][a-z\d+.-]*:\s/i.test(text) && !KNOWN_URI_SCHEME.test(text)))
  const directUrl = colonQuery ? null : normalizeBrowserUrl(text)
  const explicitAddress =
    networkAddress || (!colonQuery && URL_SCHEME.test(text)) || /^[/\\]/.test(text)
  const hasPath = /^[^/?#\\]+[/\\]/.test(text)
  if (!text || explicitAddress || (directUrl && (hasPath || hasUrlParameters(text)))) {
    return { kind: 'visit' as const, url: directUrl ?? text, alternateHostUrl: null }
  }
  return {
    kind: 'search' as const,
    url: `https://www.google.com/search?${new URLSearchParams({ q: text })}`,
    alternateHostUrl: directUrl,
  }
}
