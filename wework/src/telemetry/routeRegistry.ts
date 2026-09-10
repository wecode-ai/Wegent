import { SMART_APP_ROUTE_DEFINITIONS } from './generated/smartAppEvents'
import type { SmartAppTelemetryEvent } from './facts'

export function resolveTelemetryRoute(
  pathname: string,
  search: string
): SmartAppTelemetryEvent | null {
  const query = new URLSearchParams(search)

  for (const route of SMART_APP_ROUTE_DEFINITIONS) {
    if (!matchesPathname(route.match, pathname) || !matchesQuery(route.match, query)) continue
    return {
      name: route.eventName,
      properties: { domain: 'smart_app' },
    } as SmartAppTelemetryEvent
  }

  return null
}

function matchesPathname(
  match: { readonly pathname?: string; readonly pathnamePrefix?: string },
  pathname: string
): boolean {
  if (match.pathname && match.pathname !== pathname) return false
  if (match.pathnamePrefix && !pathname.startsWith(match.pathnamePrefix)) return false
  return true
}

function matchesQuery(match: object, query: URLSearchParams): boolean {
  const { query: required, queryNot } = match as {
    readonly query?: Readonly<Record<string, string>>
    readonly queryNot?: Readonly<Record<string, string>>
  }
  if (required && Object.entries(required).some(([key, value]) => query.get(key) !== value)) {
    return false
  }
  return !queryNot || !Object.entries(queryNot).some(([key, value]) => query.get(key) === value)
}
