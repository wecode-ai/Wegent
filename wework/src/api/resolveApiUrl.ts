export function resolveApiUrl(url: string, apiBaseUrl: string): string {
  if (!apiBaseUrl.trim()) return url
  const baseUrl = new URL(apiBaseUrl, window.location.origin)
  return new URL(url, baseUrl).toString()
}
