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

export function normalizeBrowserUrl(value: string, appUrl?: string): string | null {
  const trimmed = value.trim()
  if (!trimmed) return null

  const withProtocol = /^[a-z][a-z\d+\-.]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`

  try {
    const url = new URL(withProtocol)
    if (
      url.protocol !== 'http:' &&
      url.protocol !== 'https:' &&
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
