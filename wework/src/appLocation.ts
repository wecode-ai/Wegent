import { useState } from 'react'
import { useWindowEvent } from '@wegent/collaboration/dom-events'
import { stripAppBasePath } from '@/config/runtime'
import { canonicalAssistantRoute } from '@/features/collaboration-exp/integration/deepLinks'
import { toBrowserPath } from '@/lib/navigation'

function readCurrentRoute() {
  return stripAppBasePath(window.location.pathname) + window.location.search
}

export function canonicalizeBrowserLocation() {
  const current = readCurrentRoute()
  const route = canonicalAssistantRoute(current)
  if (route !== current) {
    // An existing popstate event already notifies navigation owners.
    window.history.replaceState(
      window.history.state,
      '',
      toBrowserPath(route) + window.location.hash
    )
  }
  return route
}

export function useCurrentPath() {
  return useCurrentLocation().pathname
}

export function useCurrentLocation() {
  const [route, setRoute] = useState(() => canonicalAssistantRoute(readCurrentRoute()))
  useWindowEvent('popstate', () => setRoute(canonicalizeBrowserLocation()), { capture: true })
  const queryStart = route.indexOf('?')
  return queryStart === -1
    ? { pathname: route, search: '' }
    : { pathname: route.slice(0, queryStart), search: route.slice(queryStart) }
}
