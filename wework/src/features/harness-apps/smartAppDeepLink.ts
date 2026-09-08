export interface SmartAppOpenRequest {
  smartAppId: number
}

export function smartAppDeepLink(smartAppId: number): string {
  return `wework://smart-app/${smartAppId}`
}

export function smartAppOpenRoute(smartAppId: number): string {
  const query = new URLSearchParams({
    app_type: 'smart_app',
    action: 'open',
    smartAppId: String(smartAppId),
  })
  return `/sites?${query.toString()}`
}

export function parseSmartAppOpenRoute(search: string): SmartAppOpenRequest | null {
  const query = new URLSearchParams(search)
  if (query.get('app_type') !== 'smart_app' || query.get('action') !== 'open') return null
  const smartAppIdText = query.get('smartAppId') ?? ''
  if (!/^[1-9]\d*$/.test(smartAppIdText)) return null
  const smartAppId = Number(smartAppIdText)
  return Number.isSafeInteger(smartAppId) ? { smartAppId } : null
}
