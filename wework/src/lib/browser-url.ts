function matchesTauriAppOrigin(url: URL, appUrl: string | undefined): boolean {
  if (url.protocol !== 'tauri:' || !appUrl) return false

  try {
    const currentUrl = new URL(appUrl)
    return url.protocol === currentUrl.protocol && url.host === currentUrl.host
  } catch {
    return false
  }
}

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

export function normalizeBrowserUrl(value: string, appUrl?: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  const withProtocol =
    localPathToFileUrl(trimmed) ??
    (/^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`)

  try {
    const url = new URL(withProtocol)
    if (
      url.protocol !== 'http:' &&
      url.protocol !== 'https:' &&
      url.protocol !== 'file:' &&
      !isLocalAssetUrl(url) &&
      !matchesTauriAppOrigin(url, appUrl)
    ) {
      return null
    }
    return url.toString()
  } catch {
    return null
  }
}
